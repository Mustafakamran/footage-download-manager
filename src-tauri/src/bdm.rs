//! Bilal-Drive-Man (BDM) sync agent.
//!
//! Makes FDM act as a second "downloader machine" for the BDM portal. A
//! background thread heartbeats (so FDM shows up as a machine), polls BDM's
//! `download_commands` queue for jobs assigned to this machine, downloads each
//! project's share-link with FDM's own engine (Drive / Dropbox today, WeTransfer
//! once their provider flow lands) into `dest_root/client/couple`, streams
//! progress back to `download-progress` (which mirrors status to Notion), and
//! drops a location breadcrumb comment on the Notion card.
//!
//! All BDM calls are plain HTTPS with the shared `x-api-key`. Config (non-secret)
//! lives in `bdm.json`; the API key is in the OS keychain.

use crate::download::{DownloadItem, NativeJobsState};
use crate::rclone::supervisor::{rc_post, RcConnection, RcloneState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const KEY_NAME: &str = "bdm_api_key";
const POLL_INTERVAL: Duration = Duration::from_secs(10);
const CONNECTIONS: usize = 4;

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct BdmConfig {
    pub enabled: bool,
    pub portal_url: String,
    pub machine: String,
    pub dest_root: String,
}

#[derive(Default)]
pub struct BdmState {
    pub started: AtomicBool,
    pub status: Mutex<String>,
}

fn set_status(app: &AppHandle, s: impl Into<String>) {
    *app.state::<BdmState>().status.lock().unwrap_or_else(|e| e.into_inner()) = s.into();
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
    Ok(dir.join("bdm.json"))
}

fn load_config(app: &AppHandle) -> BdmConfig {
    config_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_config(app: &AppHandle, cfg: &BdmConfig) -> Result<(), String> {
    let p = config_path(app)?;
    std::fs::write(p, serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn api_key() -> Option<String> {
    crate::secrets::get_secret(KEY_NAME).ok().flatten().filter(|k| !k.is_empty())
}

// ─── HTTP helpers (x-api-key) ───────────────────────────────────────────────

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_default()
}

fn get_json(c: &reqwest::blocking::Client, base: &str, path: &str, key: &str) -> Result<Value, String> {
    let resp = c
        .get(format!("{}{}", base.trim_end_matches('/'), path))
        .header("x-api-key", key)
        .send()
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("GET {path} {status}: {}", text.chars().take(200).collect::<String>()));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn send_json(
    c: &reqwest::blocking::Client,
    method: reqwest::Method,
    base: &str,
    path: &str,
    key: &str,
    body: &Value,
) -> Result<(), String> {
    let resp = c
        .request(method, format!("{}{}", base.trim_end_matches('/'), path))
        .header("x-api-key", key)
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(body).map_err(|e| e.to_string())?)
        .send()
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().unwrap_or_default();
        return Err(format!("{path} {status}: {}", text.chars().take(200).collect::<String>()));
    }
    Ok(())
}

// ─── helpers ────────────────────────────────────────────────────────────────

fn platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else {
        "mac"
    }
}

/// Pull BDM's Google Drive OAuth creds (the app the shares are granted to) from
/// the portal — returns (refresh_token, client_id, client_secret).
fn fetch_drive_creds(c: &reqwest::blocking::Client, base: &str, key: &str) -> Result<(String, String, String), String> {
    let v = get_json(c, base, "/api/scanner-credentials?provider=google_drive", key)?;
    let g = v.get("google_drive").filter(|g| !g.is_null()).ok_or("portal has no Google Drive creds configured")?;
    let rt = g.get("refresh_token").and_then(|x| x.as_str()).filter(|s| !s.is_empty()).ok_or("no refresh_token")?;
    let cid = g.get("client_id").and_then(|x| x.as_str()).ok_or("no client_id")?;
    let csec = g.get("client_secret").and_then(|x| x.as_str()).ok_or("no client_secret")?;
    Ok((rt.to_string(), cid.to_string(), csec.to_string()))
}

/// Create a transient `drivelink_*` rclone remote rooted at `folder_id`, using
/// BDM's OAuth creds (expired token JSON forces a refresh via refresh_token).
/// Returns the remote name. Caller deletes it after the download.
fn create_drivelink_with_creds(
    conn: &RcConnection,
    label: &str,
    folder_id: &str,
    refresh_token: &str,
    client_id: &str,
    client_secret: &str,
) -> Result<String, String> {
    let token = json!({
        "access_token": "",
        "token_type": "Bearer",
        "refresh_token": refresh_token,
        "expiry": "2000-01-01T00:00:00Z"
    })
    .to_string();
    let remote = crate::accounts::remote_name("drivelink", label);
    let params = json!({
        "name": remote,
        "type": "drive",
        "parameters": {
            "token": token,
            "client_id": client_id,
            "client_secret": client_secret,
            "root_folder_id": folder_id,
            "scope": "drive.readonly"
        },
        "opt": { "nonInteractive": true, "all": true }
    });
    rc_post(conn, "config/create", &params)?;
    Ok(remote)
}

/// Extract a Drive folder/file id from a share URL.
fn drive_folder_id(url: &str) -> Option<String> {
    for pat in ["/folders/", "id=", "/d/"] {
        if let Some(i) = url.find(pat) {
            let id: String = url[i + pat.len()..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                .collect();
            if !id.is_empty() {
                return Some(id);
            }
        }
    }
    None
}

fn link_type(proj: &Value) -> String {
    if let Some(t) = proj.get("link_type").and_then(|v| v.as_str()) {
        if !t.is_empty() && t != "unknown" {
            return t.to_string();
        }
    }
    let url = proj.get("download_link").and_then(|v| v.as_str()).unwrap_or("");
    if url.contains("dropbox.com") {
        "dropbox".into()
    } else if url.contains("drive.google.com") {
        "google_drive".into()
    } else if url.contains("we.tl") || url.contains("wetransfer.com") {
        "wetransfer".into()
    } else {
        "unknown".into()
    }
}

fn slug(s: &str) -> String {
    let out: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let t = out.trim_matches('_').to_string();
    if t.is_empty() {
        "bdm".into()
    } else {
        t.chars().take(40).collect()
    }
}

// ─── download one project ───────────────────────────────────────────────────

fn download_project(
    app: &AppHandle,
    conn: &RcConnection,
    cfg: &BdmConfig,
    key: &str,
    c: &reqwest::blocking::Client,
    project_id: &str,
) -> Result<(), String> {
    let proj = get_json(c, &cfg.portal_url, &format!("/api/download-projects?id={project_id}"), key)?;
    if proj.is_null() {
        return Err("project not found".into());
    }
    let link = proj.get("download_link").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let client_name = proj.get("client_name").and_then(|v| v.as_str()).unwrap_or("misc").to_string();
    let couple = proj.get("couple_name").and_then(|v| v.as_str()).unwrap_or("project").to_string();
    let lt = link_type(&proj);

    if cfg.dest_root.trim().is_empty() {
        return Err("no destination folder set in FDM Sync settings".into());
    }
    // dest_root/client ; the engine appends /couple via item.name.
    let dest = PathBuf::from(&cfg.dest_root).join(&client_name);
    let dest_str = dest.to_string_lossy().into_owned();
    let label = format!("bdm_{}", slug(&couple));

    let dest_dir = dest.join(&couple);
    let native = app.state::<NativeJobsState>();
    let handles = native.create(&format!("bdm:{lt}"), &couple, &dest_str, 0);

    // Progress reporter: push bytes to BDM every ~2s until the job finishes.
    let reporter = {
        let rc = client();
        let base = cfg.portal_url.clone();
        let k = key.to_string();
        let pid = project_id.to_string();
        let h = handles.clone();
        std::thread::spawn(move || loop {
            let bytes = h.transferred.load(Ordering::SeqCst);
            let _ = send_json(&rc, reqwest::Method::POST, &base, "/api/download-progress", &k,
                &json!({ "project_id": pid, "progress_bytes": bytes, "status": "downloading", "phase": "copying" }));
            if h.finished.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(Duration::from_secs(2));
        })
    };

    // Run the right engine (blocks). Drive uses BDM's OAuth app creds (the shares
    // are granted to *their* app, not FDM's account); WeTransfer is anonymous;
    // Dropbox stays on AAHIL (share is mounted into Bilal's specific account).
    let (result, provider_label): (Result<(), String>, &str) = match lt.as_str() {
        "google_drive" => {
            let r = (|| -> Result<(), String> {
                let fid = drive_folder_id(&link).ok_or("couldn't find a Drive folder id in the link")?;
                let (rt, cid, csec) = fetch_drive_creds(c, &cfg.portal_url, key)?;
                let acct = create_drivelink_with_creds(conn, &label, &fid, &rt, &cid, &csec)?;
                let item = DownloadItem { path: String::new(), name: couple.clone(), is_dir: true, size: 0, id: String::new() };
                crate::transfer::download_item(app.clone(), conn.clone(), acct.clone(), item, dest_str.clone(), CONNECTIONS, handles.clone());
                crate::accounts::delete_remote(conn, &acct);
                if handles.success.load(Ordering::SeqCst) {
                    Ok(())
                } else {
                    let e = handles.error.lock().unwrap_or_else(|e| e.into_inner()).clone();
                    Err(if e.is_empty() { "download failed".into() } else { e })
                }
            })();
            handles.finished.store(true, Ordering::SeqCst);
            (r, "Google Drive (BDM)")
        }
        "wetransfer" => {
            let r = crate::wetransfer::download_share(&link, &dest_dir, &handles);
            match &r {
                Ok(()) => handles.success.store(true, Ordering::SeqCst),
                Err(e) => *handles.error.lock().unwrap_or_else(|e| e.into_inner()) = e.clone(),
            }
            handles.finished.store(true, Ordering::SeqCst);
            (r, "WeTransfer")
        }
        "dropbox" => {
            handles.finished.store(true, Ordering::SeqCst);
            (Err("Dropbox shares are handled by AAHIL, not FDM".into()), "")
        }
        other => {
            handles.finished.store(true, Ordering::SeqCst);
            (Err(format!("unsupported link type: {other}")), "")
        }
    };
    let _ = reporter.join();
    result?;

    // Success → final status + Notion breadcrumb.
    let total = handles.transferred.load(Ordering::SeqCst);
    let _ = send_json(c, reqwest::Method::POST, &cfg.portal_url, "/api/download-progress", key,
        &json!({ "project_id": project_id, "progress_bytes": total, "status": "completed", "phase": "" }));
    let breadcrumb = format!("{} › {} › {}", provider_label, cfg.machine, dest_dir.to_string_lossy());
    let _ = send_json(c, reqwest::Method::POST, &cfg.portal_url, "/api/notion-comment", key,
        &json!({ "project_id": project_id, "text": breadcrumb }));
    Ok(())
}

// ─── poll loop ──────────────────────────────────────────────────────────────

fn poll_once(app: &AppHandle, c: &reqwest::blocking::Client) {
    let cfg = load_config(app);
    if !cfg.enabled || cfg.portal_url.is_empty() || cfg.machine.is_empty() {
        set_status(app, "idle (disabled or not configured)");
        return;
    }
    let key = match api_key() {
        Some(k) => k,
        None => {
            set_status(app, "idle (no API key)");
            return;
        }
    };
    let conn = match app.state::<RcloneState>().connection.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        Some(c) => c,
        None => return,
    };

    // Heartbeat — register/refresh this machine.
    let _ = send_json(
        c,
        reqwest::Method::POST,
        &cfg.portal_url,
        "/api/heartbeat",
        &key,
        &json!({
            "machine_name": cfg.machine,
            "platform": platform(),
            "is_download_pc": true,
            "scanner_version": format!("FDM {}", env!("CARGO_PKG_VERSION")),
        }),
    );

    // Pull pending commands for this machine.
    let cmds = match get_json(c, &cfg.portal_url, &format!("/api/download-commands?machine={}", urlencode(&cfg.machine)), &key) {
        Ok(v) => v,
        Err(e) => {
            set_status(app, format!("poll error: {e}"));
            return;
        }
    };
    let arr = cmds.as_array().cloned().unwrap_or_default();
    set_status(app, format!("connected · {} pending", arr.len()));

    for cmd in arr {
        let id = cmd.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let project_id = cmd.get("project_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if id.is_empty() {
            continue;
        }
        // Mark processing.
        let _ = send_json(c, reqwest::Method::PATCH, &cfg.portal_url, "/api/download-commands", &key, &json!({ "id": id, "status": "processing" }));
        if project_id.is_empty() {
            let _ = send_json(c, reqwest::Method::PATCH, &cfg.portal_url, "/api/download-commands", &key, &json!({ "id": id, "status": "completed" }));
            continue;
        }
        set_status(app, format!("downloading project {project_id}"));
        match download_project(app, &conn, &cfg, &key, c, &project_id) {
            Ok(()) => {
                let _ = send_json(c, reqwest::Method::PATCH, &cfg.portal_url, "/api/download-commands", &key, &json!({ "id": id, "status": "completed" }));
            }
            Err(e) => {
                let _ = send_json(c, reqwest::Method::PATCH, &cfg.portal_url, "/api/download-commands", &key, &json!({ "id": id, "status": "failed", "error_message": e }));
                let _ = send_json(c, reqwest::Method::POST, &cfg.portal_url, "/api/download-progress", &key, &json!({ "project_id": project_id, "status": "failed", "error_message": e }));
                set_status(app, format!("job failed: {e}"));
            }
        }
    }
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Start the agent loop once (idempotent). Reloads config each tick so the UI can
/// enable/disable + reconfigure at runtime.
pub fn start_agent(app: &AppHandle) {
    let state = app.state::<BdmState>();
    if state.started.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let c = client();
        loop {
            poll_once(&app, &c);
            std::thread::sleep(POLL_INTERVAL);
        }
    });
}

// ─── commands ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn bdm_get_config(app: AppHandle) -> Value {
    let cfg = load_config(&app);
    json!({
        "enabled": cfg.enabled,
        "portalUrl": cfg.portal_url,
        "machine": cfg.machine,
        "destRoot": cfg.dest_root,
        "hasKey": api_key().is_some(),
        "status": app.state::<BdmState>().status.lock().unwrap_or_else(|e| e.into_inner()).clone(),
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn bdm_set_config(
    app: AppHandle,
    enabled: bool,
    portal_url: String,
    machine: String,
    dest_root: String,
    api_key: Option<String>,
) -> Result<(), String> {
    if let Some(k) = api_key {
        if !k.is_empty() {
            crate::secrets::set_secret(KEY_NAME, &k)?;
        }
    }
    save_config(&app, &BdmConfig { enabled, portal_url, machine, dest_root })?;
    start_agent(&app); // ensure running; loop picks up new config next tick
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_drive_folder_id() {
        assert_eq!(
            drive_folder_id("https://drive.google.com/drive/folders/1AbC_dEf-123?usp=sharing").as_deref(),
            Some("1AbC_dEf-123")
        );
        assert_eq!(drive_folder_id("https://www.dropbox.com/scl/fo/xyz"), None);
    }

    #[test]
    fn classifies_link_type() {
        assert_eq!(link_type(&json!({ "download_link": "https://www.dropbox.com/scl/fo/x" })), "dropbox");
        assert_eq!(link_type(&json!({ "link_type": "wetransfer" })), "wetransfer");
        assert_eq!(link_type(&json!({ "download_link": "https://drive.google.com/drive/folders/x" })), "google_drive");
    }

    #[test]
    fn slug_sanitizes() {
        assert_eq!(slug("Tom & Jerry / 2026"), "Tom___Jerry___2026");
        assert_eq!(slug(""), "bdm");
    }
}
