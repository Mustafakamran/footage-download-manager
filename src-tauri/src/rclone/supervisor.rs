use crate::rclone::config::{build_rcd_args, pick_free_port, random_secret, RcConfig};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

/// Connection info shared with the frontend.
///
/// Carries ONE shared `reqwest::blocking::Client` (internally `Arc`-based:
/// `Clone`, `Send`, `Sync`, with a keep-alive connection pool). Building it once
/// and reusing it for every rc call avoids a fresh TCP/HTTP handshake — and the
/// blocking stall that handshake costs — on each rclone interaction. The client
/// is skipped during serialization since only the connection coordinates travel
/// to the frontend.
#[derive(Clone, serde::Serialize)]
pub struct RcConnection {
    pub base_url: String,
    pub user: String,
    pub pass: String,
    #[serde(skip)]
    client: reqwest::blocking::Client,
}

impl RcConnection {
    /// Build a connection, constructing the shared HTTP client once.
    pub fn new(base_url: String, user: String, pass: String) -> Self {
        RcConnection {
            base_url,
            user,
            pass,
            client: reqwest::blocking::Client::new(),
        }
    }
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
    // Use a fixed config file in the app data dir so remotes/tokens persist
    // across restarts. Create the dir if it doesn't exist yet.
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("create app_data_dir: {e}"))?;
    let config_path = data_dir.join("rclone.conf").to_string_lossy().into_owned();
    let cfg = RcConfig {
        host: "127.0.0.1".into(),
        port,
        user: random_secret(16),
        pass: random_secret(32),
        config_path,
    };
    let args = build_rcd_args(&cfg);

    let sidecar = app
        .shell()
        .sidecar("rclone")
        .map_err(|e| format!("sidecar: {e}"))?
        .args(args);
    let (_rx, child) = sidecar.spawn().map_err(|e| format!("spawn: {e}"))?;

    let connection = RcConnection::new(
        format!("http://{}:{}", cfg.host, cfg.port),
        cfg.user,
        cfg.pass,
    );

    wait_until_ready(&connection)?;

    let state = app.state::<RcloneState>();
    *state.child.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
    *state.connection.lock().unwrap_or_else(|e| e.into_inner()) = Some(connection.clone());
    Ok(connection)
}

/// Poll `core/version` until the daemon responds or we time out.
pub fn wait_until_ready(conn: &RcConnection) -> Result<(), String> {
    // Reuse the connection's shared keep-alive client (no per-poll handshake).
    let url = format!("{}/core/version", conn.base_url);
    for _ in 0..50 {
        let resp = conn
            .client
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

/// POST a JSON params object to an rc endpoint with basic auth; return parsed JSON.
pub fn rc_post(
    conn: &RcConnection,
    endpoint: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    // Reuse the connection's shared keep-alive client instead of building a fresh
    // one (and paying a new TCP/HTTP handshake) on every rc call.
    let url = format!("{}/{}", conn.base_url, endpoint);
    let body = serde_json::to_string(params).map_err(|e| e.to_string())?;
    let resp = conn
        .client
        .post(&url)
        .basic_auth(&conn.user, Some(&conn.pass))
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("rc {endpoint} failed: {status} {text}"));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// Kill the daemon on shutdown.
pub fn stop_rclone(state: &RcloneState) {
    // Recover from a poisoned lock so shutdown still kills the child.
    if let Some(child) = state.child.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = child.kill();
    }
}
