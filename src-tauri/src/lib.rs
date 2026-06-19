pub mod accounts;
pub mod download;
pub mod drive;
pub mod index_store;
pub mod rclone;
pub mod secrets;

use download::JobsState;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(RcloneState::default())
        .manage(JobsState::default())
        .manage(accounts::OAuthState::default())
        .invoke_handler(tauri::generate_handler![
            rc_call,
            accounts::list_accounts,
            accounts::remove_account,
            accounts::add_account,
            accounts::set_secret,
            accounts::get_secret,
            accounts::delete_secret,
            download::start_download,
            download::list_jobs,
            download::cancel_job,
            download::clear_finished_jobs,
            drive::drive_uploader,
            index_store::save_index,
            index_store::load_index,
            index_store::delete_index,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            start_rclone(&handle).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
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
