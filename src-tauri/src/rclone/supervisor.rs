use crate::rclone::config::{build_rcd_args, pick_free_port, random_secret, RcConfig};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

/// Connection info shared with the frontend.
#[derive(Clone, serde::Serialize)]
pub struct RcConnection {
    pub base_url: String,
    pub user: String,
    pub pass: String,
}

/// Holds the running rclone child + connection; lives in Tauri managed state.
#[derive(Default)]
pub struct RcloneState {
    pub child: Mutex<Option<CommandChild>>,
    pub connection: Mutex<Option<RcConnection>>,
}

/// Launch the rclone sidecar in rc daemon mode and wait until it answers.
pub fn start_rclone(app: &AppHandle) -> Result<RcConnection, String> {
    let port = pick_free_port().map_err(|e| format!("port: {e}"))?;
    let cfg = RcConfig {
        host: "127.0.0.1".into(),
        port,
        user: random_secret(16),
        pass: random_secret(32),
    };
    let args = build_rcd_args(&cfg);

    let sidecar = app
        .shell()
        .sidecar("rclone")
        .map_err(|e| format!("sidecar: {e}"))?
        .args(args);
    let (_rx, child) = sidecar.spawn().map_err(|e| format!("spawn: {e}"))?;

    let connection = RcConnection {
        base_url: format!("http://{}:{}", cfg.host, cfg.port),
        user: cfg.user,
        pass: cfg.pass,
    };

    wait_until_ready(&connection)?;

    let state = app.state::<RcloneState>();
    *state.child.lock().unwrap() = Some(child);
    *state.connection.lock().unwrap() = Some(connection.clone());
    Ok(connection)
}

/// Poll `core/version` until the daemon responds or we time out.
pub fn wait_until_ready(conn: &RcConnection) -> Result<(), String> {
    let client = reqwest::blocking::Client::new();
    let url = format!("{}/core/version", conn.base_url);
    for _ in 0..50 {
        let resp = client
            .post(&url)
            .basic_auth(&conn.user, Some(&conn.pass))
            .send();
        if let Ok(r) = resp {
            if r.status().is_success() {
                return Ok(());
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Err("rclone daemon did not become ready in time".into())
}

/// Kill the daemon on shutdown.
pub fn stop_rclone(state: &RcloneState) {
    if let Some(child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
    }
}
