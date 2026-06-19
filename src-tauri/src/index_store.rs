//! Persistent local cache of an account's full file tree (the "index").
//! The frontend crawls the remote once, then saves the JSON index here so
//! browsing, folder sizes, and folder dates are served locally without
//! per-folder API calls. Stored as `<app_data_dir>/index_<account_id>.json`.

use std::fs;
use tauri::{AppHandle, Manager};

fn index_path(app: &AppHandle, account_id: &str) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("app_data_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create app_data_dir: {e}"))?;
    // account_id is a sanitized rclone remote name (drive_x / dropbox_y), safe as a filename.
    Ok(dir.join(format!("index_{account_id}.json")))
}

/// Persist an account's index JSON to disk.
#[tauri::command]
pub fn save_index(app: AppHandle, account_id: String, data: String) -> Result<(), String> {
    let path = index_path(&app, &account_id)?;
    fs::write(&path, data).map_err(|e| format!("write index: {e}"))
}

/// Load an account's index JSON, or None if it hasn't been crawled yet.
#[tauri::command]
pub fn load_index(app: AppHandle, account_id: String) -> Result<Option<String>, String> {
    let path = index_path(&app, &account_id)?;
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read index: {e}")),
    }
}

/// Delete an account's index (on account removal).
#[tauri::command]
pub fn delete_index(app: AppHandle, account_id: String) -> Result<(), String> {
    let path = index_path(&app, &account_id)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("delete index: {e}")),
    }
}
