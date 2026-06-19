pub mod accounts;
pub mod rclone;
pub mod secrets;

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
        .manage(RcloneState::default())
        .invoke_handler(tauri::generate_handler![
            rc_call,
            accounts::list_accounts,
            accounts::remove_account,
            accounts::add_account,
            accounts::set_secret,
            accounts::get_secret,
            accounts::delete_secret,
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
