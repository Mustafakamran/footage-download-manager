//! Native Dropbox shared-link engine.
//!
//! rclone can't browse an arbitrary Dropbox *shared link* (there's no
//! `root_folder_id` equivalent the way Google Drive has), so links are listed
//! with the native Dropbox API (`files/list_folder` with `shared_link`,
//! recursive + paginated). Downloads go through the shared resumable engine in
//! `transfer.rs` (which uses `provider::send_range` on `get_shared_link_file`).
//!
//! A link account has NO rclone remote. Its id is `dropboxlink_<slug>` and its
//! metadata (the share URL + which connected Dropbox account's token to borrow)
//! lives in `dropbox_links.json` in the app data dir. Everything else — the
//! index, the browser, the download queue — treats it like any other account.

use crate::accounts::{parse_remote, remote_name, Account};
use crate::rclone::supervisor::{RcConnection, RcloneState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const LIST_FOLDER: &str = "https://api.dropboxapi.com/2/files/list_folder";
const LIST_FOLDER_CONTINUE: &str = "https://api.dropboxapi.com/2/files/list_folder/continue";
const GET_METADATA: &str = "https://api.dropboxapi.com/2/sharing/get_shared_link_metadata";

/// Stored metadata for one Dropbox shared-link account.
#[derive(Clone, Serialize, Deserialize)]
pub struct LinkInfo {
    /// The Dropbox share URL (e.g. https://www.dropbox.com/scl/fo/…?rlkey=…).
    pub url: String,
    /// A connected Dropbox account id whose OAuth token authorizes the API calls.
    pub base: String,
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
    Ok(dir.join("dropbox_links.json"))
}

fn load_store(app: &AppHandle) -> HashMap<String, LinkInfo> {
    store_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_store(app: &AppHandle, store: &HashMap<String, LinkInfo>) -> Result<(), String> {
    let p = store_path(app)?;
    let data = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(p, data).map_err(|e| e.to_string())
}

/// The link metadata for an account id, if it's a stored Dropbox link.
pub fn link_info(app: &AppHandle, account_id: &str) -> Option<LinkInfo> {
    load_store(app).get(account_id).cloned()
}

/// All Dropbox-link accounts (so `list_accounts` can surface them alongside the
/// rclone remotes — they have no remote of their own).
pub fn link_accounts(app: &AppHandle) -> Vec<Account> {
    load_store(app).keys().filter_map(|id| parse_remote(id)).collect()
}

/// Forget a Dropbox link (on account removal).
pub fn remove_link(app: &AppHandle, account_id: &str) {
    let mut s = load_store(app);
    if s.remove(account_id).is_some() {
        let _ = save_store(app, &s);
    }
}

/// POST a JSON body to a Dropbox RPC endpoint with bearer auth; return parsed JSON.
fn api_post(token: &str, url: &str, body: &Value) -> Result<Value, String> {
    let client = reqwest::blocking::Client::new();
    let resp = client
        .post(url)
        .bearer_auth(token)
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(body).map_err(|e| e.to_string())?)
        .send()
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("dropbox {url} {status}: {text}"));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// Map a Dropbox list_folder entry to an rclone-shaped list item (so the indexer
/// can reuse its existing `parse_entry`). Paths are made root-relative (the
/// shared link root is "", nested files are "Sub/clip.mxf").
fn map_entry(e: &Value) -> Option<Value> {
    let tag = e.get(".tag").and_then(|t| t.as_str())?;
    let name = e.get("name").and_then(|n| n.as_str())?;
    // path_display is relative to the shared link, with a leading '/'.
    let raw = e.get("path_display").and_then(|p| p.as_str()).unwrap_or("");
    let path = raw.trim_start_matches('/').to_string();
    if path.is_empty() {
        return None;
    }
    match tag {
        "folder" => Some(json!({
            "Name": name, "Path": path, "Size": -1, "IsDir": true, "ModTime": "", "MimeType": ""
        })),
        "file" => {
            let size = e.get("size").and_then(|s| s.as_i64()).unwrap_or(0);
            let mod_time = e.get("server_modified").and_then(|m| m.as_str()).unwrap_or("");
            Some(json!({
                "Name": name, "Path": path, "Size": size, "IsDir": false,
                "ModTime": mod_time, "MimeType": ""
            }))
        }
        _ => None,
    }
}

/// List a shared link's whole tree, returning rclone-shaped entries.
///
/// Dropbox does NOT allow `recursive:true` on a `shared_link`, so we walk the
/// tree ourselves: list each folder non-recursively (paginated via `/continue`)
/// and enqueue subfolders. Subfolders are listed by passing their path
/// (relative to the link root, e.g. "/Sub") alongside the same `shared_link`.
pub fn list_entries(app: &AppHandle, conn: &RcConnection, account_id: &str) -> Result<Vec<Value>, String> {
    let info = link_info(app, account_id).ok_or_else(|| "no Dropbox link info".to_string())?;
    let token = crate::drive::dropbox_access_token(conn, &info.base)?;

    let mut out = Vec::new();
    let mut queue: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    queue.push_back(String::new()); // "" = link root

    while let Some(dir) = queue.pop_front() {
        let mut resp = api_post(
            &token,
            LIST_FOLDER,
            &json!({
                "path": dir,
                "shared_link": { "url": info.url },
                "recursive": false,
                "include_deleted": false,
                "include_mounted_folders": true,
                "include_non_downloadable_files": true
            }),
        )?;
        loop {
            if let Some(entries) = resp.get("entries").and_then(|e| e.as_array()) {
                for e in entries {
                    // Recurse into subfolders by their link-relative path.
                    if e.get(".tag").and_then(|t| t.as_str()) == Some("folder") {
                        if let Some(pd) = e.get("path_display").and_then(|p| p.as_str()) {
                            if !pd.is_empty() && pd != "/" {
                                queue.push_back(pd.to_string());
                            }
                        }
                    }
                    if let Some(v) = map_entry(e) {
                        out.push(v);
                    }
                }
            }
            if !resp.get("has_more").and_then(|h| h.as_bool()).unwrap_or(false) {
                break;
            }
            let cursor = resp
                .get("cursor")
                .and_then(|c| c.as_str())
                .ok_or_else(|| "list_folder: missing cursor".to_string())?
                .to_string();
            resp = api_post(&token, LIST_FOLDER_CONTINUE, &json!({ "cursor": cursor }))?;
        }
    }
    Ok(out)
}

/// Add a Dropbox shared-folder link as a browseable account. Reuses a connected
/// Dropbox account's token (no extra sign-in, nothing copied into your Dropbox).
#[tauri::command]
pub fn add_dropbox_link(
    app: AppHandle,
    rclone: tauri::State<RcloneState>,
    base_account_id: String,
    label: String,
    url: String,
) -> Result<Account, String> {
    if parse_remote(&base_account_id).map(|a| a.provider) != Some("dropbox".to_string()) {
        return Err("base account must be a Dropbox account".into());
    }
    let url = url.trim().to_string();
    if !url.contains("dropbox.com") {
        return Err("not a Dropbox share link".into());
    }
    let conn = rclone
        .connection
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| "rclone not started".to_string())?;

    // Fail fast: verify the borrowed token can actually resolve the link.
    let token = crate::drive::dropbox_access_token(&conn, &base_account_id)?;
    api_post(&token, GET_METADATA, &json!({ "url": url }))
        .map_err(|e| format!("couldn't open that link: {e}"))?;

    let remote = remote_name("dropboxlink", &label);
    let mut store = load_store(&app);
    store.insert(remote.clone(), LinkInfo { url, base: base_account_id });
    save_store(&app, &store)?;
    parse_remote(&remote).ok_or_else(|| format!("bad remote name: {remote}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_file_and_folder_entries_root_relative() {
        let folder = json!({ ".tag": "folder", "name": "Sub", "path_display": "/Sub" });
        let v = map_entry(&folder).unwrap();
        assert_eq!(v["Path"], "Sub");
        assert_eq!(v["IsDir"], true);
        assert_eq!(v["Size"], -1);

        let file = json!({
            ".tag": "file", "name": "clip.mxf", "path_display": "/Sub/clip.mxf",
            "size": 1234, "server_modified": "2026-01-02T03:04:05Z"
        });
        let v = map_entry(&file).unwrap();
        assert_eq!(v["Path"], "Sub/clip.mxf");
        assert_eq!(v["IsDir"], false);
        assert_eq!(v["Size"], 1234);
        assert_eq!(v["ModTime"], "2026-01-02T03:04:05Z");
    }

    #[test]
    fn skips_root_and_unknown_tags() {
        // Root itself (empty path) is dropped.
        assert!(map_entry(&json!({ ".tag": "folder", "name": "", "path_display": "/" })).is_none());
        // Deleted/other tags are dropped.
        assert!(map_entry(&json!({ ".tag": "deleted", "name": "x", "path_display": "/x" })).is_none());
    }
}
