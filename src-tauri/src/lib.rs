pub mod accounts;
pub mod bdm;
pub mod download;
pub mod drive;
pub mod dropbox;
pub mod index;
pub mod provider;
pub mod rclone;
pub mod secrets;
pub mod stream;
pub mod transfer;
pub mod wetransfer;

use base64::Engine;
use download::{JobsState, NativeJobsState};
use rclone::supervisor::{start_rclone, stop_rclone, RcloneState};
use tauri::Manager;

#[tauri::command]
fn rc_call(
    state: tauri::State<RcloneState>,
    endpoint: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let conn = state
        .connection
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| "rclone not started".to_string())?;
    rclone::supervisor::rc_post(&conn, &endpoint, &params)
}

/// Write base64-encoded bytes to a path on disk (used to save an exported review
/// PDF the frontend generates in-memory).
#[tauri::command]
fn write_binary_file(path: String, base64: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.as_bytes())
        .map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| format!("write {path}: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(RcloneState::default())
        .manage(JobsState::default())
        .manage(NativeJobsState::default())
        .manage(accounts::OAuthState::default())
        .manage(index::IndexState::default())
        .manage(stream::StreamState::default())
        .manage(bdm::BdmState::default())
        .invoke_handler(tauri::generate_handler![
            rc_call,
            write_binary_file,
            stream::stream_base,
            bdm::bdm_get_config,
            bdm::bdm_set_config,
            accounts::list_accounts,
            accounts::remove_account,
            accounts::add_account,
            accounts::set_secret,
            accounts::get_secret,
            accounts::delete_secret,
            accounts::account_email,
            accounts::add_drive_link,
            dropbox::add_dropbox_link,
            download::start_download,
            download::list_jobs,
            download::cancel_job,
            download::clear_finished_jobs,
            drive::drive_uploader,
            index::index_start,
            index::index_recrawl,
            index::index_get,
            index::index_status,
            index::index_remove,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            start_rclone(&handle).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
            // Loopback streaming proxy for the review player (best-effort).
            if let Err(e) = stream::start_stream_server(&handle) {
                eprintln!("stream server failed to start: {e}");
            }
            // BDM sync agent (no-op until enabled + configured in Settings → Sync).
            bdm::start_agent(&handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.state::<RcloneState>();
                stop_rclone(&state);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
