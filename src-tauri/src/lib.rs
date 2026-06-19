pub mod rclone;

use rclone::supervisor::{start_rclone, stop_rclone, RcConnection, RcloneState};
use tauri::Manager;

#[tauri::command]
fn get_rc_connection(state: tauri::State<RcloneState>) -> Result<RcConnection, String> {
    state
        .connection
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "rclone not started".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(RcloneState::default())
        .invoke_handler(tauri::generate_handler![get_rc_connection])
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
