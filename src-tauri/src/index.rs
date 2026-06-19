//! Background account indexer.
//!
//! The full recursive crawl, tree/aggregate build, and disk persistence all run
//! on Rust background threads so the UI never freezes. Progress is emitted as
//! Tauri events; the finished index ({tree, agg}) is handed to the frontend once
//! via `index_get`. Folder sizes and "newest file" dates are precomputed here.

use crate::download::account_fs;
use crate::rclone::supervisor::{rc_post, RcConnection, RcloneState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

const INDEX_VERSION: u32 = 3;

/// A file/folder entry, serialized with rclone's PascalCase field names so the
/// frontend's RcItem shape matches directly.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Entry {
    name: String,
    path: String,
    size: i64,
    is_dir: bool,
    mod_time: String,
    mime_type: String,
    #[serde(rename = "ID", default, skip_serializing_if = "String::is_empty")]
    id: String,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Agg {
    size: i64,
    latest: String,
    file_count: i64,
}

#[derive(Clone, Serialize)]
pub struct AccountIndex {
    tree: HashMap<String, Vec<Entry>>,
    agg: HashMap<String, Agg>,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    status: String, // idle | loading | crawling | ready | error
    done: usize,
    total: usize,
    error: String,
}

#[derive(Default)]
pub struct IndexState {
    indexes: Mutex<HashMap<String, AccountIndex>>,
    status: Mutex<HashMap<String, IndexStatus>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn parse_entry(v: &Value) -> Option<Entry> {
    Some(Entry {
        name: v.get("Name")?.as_str()?.to_string(),
        path: v.get("Path")?.as_str()?.to_string(),
        size: v.get("Size").and_then(|x| x.as_i64()).unwrap_or(-1),
        is_dir: v.get("IsDir").and_then(|x| x.as_bool()).unwrap_or(false),
        mod_time: v.get("ModTime").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        mime_type: v.get("MimeType").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        id: v.get("ID").and_then(|x| x.as_str()).unwrap_or("").to_string(),
    })
}

fn list_op(conn: &RcConnection, fs: &str, path: &str, recurse: bool) -> Result<Vec<Entry>, String> {
    let resp = rc_post(
        conn,
        "operations/list",
        &json!({ "fs": fs, "remote": path, "opt": { "recurse": recurse } }),
    )?;
    let list = resp.get("list").and_then(|l| l.as_array()).cloned().unwrap_or_default();
    Ok(list.iter().filter_map(parse_entry).collect())
}

fn build_index(entries: &[Entry]) -> AccountIndex {
    let mut tree: HashMap<String, Vec<Entry>> = HashMap::new();
    let mut agg: HashMap<String, Agg> = HashMap::new();
    for e in entries {
        let parent = match e.path.rfind('/') {
            Some(i) => e.path[..i].to_string(),
            None => String::new(),
        };
        tree.entry(parent).or_default().push(e.clone());
        if e.is_dir {
            agg.entry(e.path.clone()).or_default();
        } else {
            let mut p = e.path.clone();
            while let Some(i) = p.rfind('/') {
                p.truncate(i);
                let a = agg.entry(p.clone()).or_default();
                a.size += e.size.max(0);
                a.file_count += 1;
                if e.mod_time > a.latest {
                    a.latest = e.mod_time.clone();
                }
            }
        }
    }
    for v in tree.values_mut() {
        v.sort_by(|a, b| {
            if a.is_dir != b.is_dir {
                return if a.is_dir { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
            }
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        });
    }
    AccountIndex { tree, agg }
}

fn set_status(app: &AppHandle, account_id: &str, status: &str, done: usize, total: usize, error: &str) {
    let state = app.state::<IndexState>();
    lock(&state.status).insert(
        account_id.to_string(),
        IndexStatus { status: status.into(), done, total, error: error.into() },
    );
}

fn index_path(app: &AppHandle, account_id: &str) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
    Ok(dir.join(format!("index_{account_id}.json")))
}

fn load_from_disk(app: &AppHandle, account_id: &str) -> Option<Vec<Entry>> {
    let path = index_path(app, account_id).ok()?;
    let raw = std::fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    if v.get("version").and_then(|x| x.as_u64()) != Some(INDEX_VERSION as u64) {
        return None;
    }
    serde_json::from_value(v.get("entries")?.clone()).ok()
}

fn save_to_disk(app: &AppHandle, account_id: &str, entries: &[Entry]) {
    if let Ok(path) = index_path(app, account_id) {
        if let Ok(data) = serde_json::to_string(&json!({ "version": INDEX_VERSION, "entries": entries })) {
            let _ = std::fs::write(path, data);
        }
    }
}

/// Recursive crawl across all top-level folders, run by a pool of worker threads.
fn do_crawl(app: &AppHandle, account_id: &str) -> Result<Vec<Entry>, String> {
    let state = app.state::<RcloneState>();
    let conn = lock(&state.connection).clone().ok_or_else(|| "rclone not started".to_string())?;
    let fs = account_fs(account_id)?;

    let root = list_op(&conn, &fs, "", false)?;
    let root_dirs: Vec<Entry> = root.iter().filter(|e| e.is_dir).cloned().collect();
    let total = root_dirs.len();
    set_status(app, account_id, "crawling", 0, total, "");
    let _ = app.emit("index-progress", json!({ "accountId": account_id, "done": 0, "total": total }));

    let entries = Arc::new(Mutex::new(root));
    let queue = Arc::new(Mutex::new(root_dirs.into_iter().collect::<VecDeque<Entry>>()));
    let done = Arc::new(AtomicUsize::new(0));

    let workers = std::cmp::min(8, std::cmp::max(1, total));
    let mut handles = Vec::new();
    for _ in 0..workers {
        let conn = conn.clone();
        let fs = fs.clone();
        let entries = entries.clone();
        let queue = queue.clone();
        let done = done.clone();
        let app = app.clone();
        let account_id = account_id.to_string();
        handles.push(std::thread::spawn(move || loop {
            let dir = { lock(&queue).pop_front() };
            let dir = match dir {
                Some(d) => d,
                None => break,
            };
            let prefix = format!("{}/", dir.path);
            // Retry a flaky/large subtree once.
            let mut sub: Vec<Entry> = Vec::new();
            for attempt in 0..2 {
                match list_op(&conn, &fs, &dir.path, true) {
                    Ok(s) => {
                        sub = s;
                        break;
                    }
                    Err(_) if attempt < 1 => continue,
                    Err(_) => break,
                }
            }
            {
                let mut acc = lock(&entries);
                for mut it in sub {
                    if it.path != dir.path && !it.path.starts_with(&prefix) {
                        it.path = format!("{}{}", prefix, it.path);
                    }
                    acc.push(it);
                }
            }
            let d = done.fetch_add(1, Ordering::SeqCst) + 1;
            set_status(&app, &account_id, "crawling", d, total, "");
            let _ = app.emit("index-progress", json!({ "accountId": account_id, "done": d, "total": total }));
        }));
    }
    for h in handles {
        let _ = h.join();
    }

    let collected = lock(&entries).clone();
    Ok(collected)
}

/// Ensure an account's index exists: serve from memory, else load from disk, else
/// crawl — all on a background thread. Emits index-progress / index-ready / index-error.
#[tauri::command]
pub fn index_start(app: AppHandle, account_id: String) {
    {
        let state = app.state::<IndexState>();
        if lock(&state.indexes).contains_key(&account_id) {
            let _ = app.emit("index-ready", json!({ "accountId": account_id }));
            return;
        }
        let mut st = lock(&state.status);
        if matches!(st.get(&account_id).map(|s| s.status.as_str()), Some("crawling") | Some("loading")) {
            return;
        }
        st.insert(account_id.clone(), IndexStatus { status: "loading".into(), done: 0, total: 0, error: String::new() });
    }
    let _ = app.emit("index-progress", json!({ "accountId": account_id, "done": 0, "total": 0 }));

    std::thread::spawn(move || {
        let entries = match load_from_disk(&app, &account_id) {
            Some(e) => e,
            None => match do_crawl(&app, &account_id) {
                Ok(e) => {
                    save_to_disk(&app, &account_id, &e);
                    e
                }
                Err(err) => {
                    set_status(&app, &account_id, "error", 0, 0, &err);
                    let _ = app.emit("index-error", json!({ "accountId": account_id, "error": err }));
                    return;
                }
            },
        };
        let index = build_index(&entries);
        lock(&app.state::<IndexState>().indexes).insert(account_id.clone(), index);
        set_status(&app, &account_id, "ready", 0, 0, "");
        let _ = app.emit("index-ready", json!({ "accountId": account_id }));
    });
}

/// Force a fresh crawl (clears cache + disk).
#[tauri::command]
pub fn index_recrawl(app: AppHandle, account_id: String) {
    {
        let state = app.state::<IndexState>();
        lock(&state.indexes).remove(&account_id);
    }
    if let Ok(path) = index_path(&app, &account_id) {
        let _ = std::fs::remove_file(path);
    }
    index_start(app, account_id);
}

/// Return the built index ({tree, agg}) once ready, else None.
#[tauri::command]
pub fn index_get(app: AppHandle, account_id: String) -> Option<AccountIndex> {
    lock(&app.state::<IndexState>().indexes).get(&account_id).cloned()
}

/// Current crawl status/progress for an account.
#[tauri::command]
pub fn index_status(app: AppHandle, account_id: String) -> IndexStatus {
    lock(&app.state::<IndexState>().status).get(&account_id).cloned().unwrap_or_default()
}

/// Drop an account's index (on removal).
#[tauri::command]
pub fn index_remove(app: AppHandle, account_id: String) {
    lock(&app.state::<IndexState>().indexes).remove(&account_id);
    lock(&app.state::<IndexState>().status).remove(&account_id);
    if let Ok(path) = index_path(&app, &account_id) {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(path: &str, size: i64, mod_time: &str) -> Entry {
        Entry {
            name: path.rsplit('/').next().unwrap().to_string(),
            path: path.into(),
            size,
            is_dir: false,
            mod_time: mod_time.into(),
            mime_type: String::new(),
            id: String::new(),
        }
    }
    fn d(path: &str) -> Entry {
        Entry {
            name: path.rsplit('/').next().unwrap().to_string(),
            path: path.into(),
            size: -1,
            is_dir: true,
            mod_time: String::new(),
            mime_type: String::new(),
            id: String::new(),
        }
    }

    #[test]
    fn builds_tree_and_recursive_aggregates() {
        let entries = vec![
            d("A"),
            d("A/sub"),
            f("A/sub/clip1.mxf", 1000, "2026-01-02T00:00:00Z"),
            f("A/clip2.mxf", 500, "2026-03-01T00:00:00Z"),
            f("root.mxf", 10, "2026-01-01T00:00:00Z"),
        ];
        let idx = build_index(&entries);
        assert_eq!(idx.tree[""].iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["A", "root.mxf"]);
        assert_eq!(idx.tree["A"].iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["sub", "clip2.mxf"]);
        assert_eq!(idx.agg["A"].size, 1500);
        assert_eq!(idx.agg["A"].latest, "2026-03-01T00:00:00Z");
        assert_eq!(idx.agg["A"].file_count, 2);
        assert_eq!(idx.agg["A/sub"].size, 1000);
    }
}
