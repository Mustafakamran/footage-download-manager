//! End-to-end integration test that proves the bundled rclone binary actually
//! works as an rc daemon, WITHOUT needing a Tauri AppHandle.
//!
//! It reuses the crate's pure helpers (`build_rcd_args`, `pick_free_port`) and
//! the supervisor's `wait_until_ready` / `RcConnection`, but spawns the raw
//! binary via `std::process::Command` instead of the Tauri sidecar API.

use google_drive_downloader_lib::rclone::config::{build_rcd_args, pick_free_port, RcConfig};
use google_drive_downloader_lib::rclone::supervisor::{wait_until_ready, RcConnection};
use std::path::PathBuf;
use std::process::{Child, Command};

/// Kills the child process when dropped, so the daemon is cleaned up even if an
/// assertion panics mid-test.
struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Locate the bundled rclone sidecar binary by globbing `binaries/rclone-*`.
fn find_rclone_binary() -> Option<PathBuf> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
    let entries = std::fs::read_dir(&dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("rclone-") {
            return Some(entry.path());
        }
    }
    None
}

#[test]
fn rclone_daemon_answers_core_version() {
    let binary = match find_rclone_binary() {
        Some(p) => p,
        None => {
            eprintln!("SKIP: no rclone binary found under binaries/rclone-* — skipping test");
            return;
        }
    };

    let port = pick_free_port().expect("pick a free port");
    let cfg = RcConfig {
        host: "127.0.0.1".into(),
        port,
        user: "testuser".into(),
        pass: "testpass".into(),
    };
    let args = build_rcd_args(&cfg);

    // Spawn the real binary directly (not via the Tauri sidecar API).
    let child = Command::new(&binary)
        .args(&args)
        .spawn()
        .expect("spawn rclone rcd");
    let _guard = ChildGuard(child);

    let connection = RcConnection {
        base_url: format!("http://{}:{}", cfg.host, cfg.port),
        user: cfg.user.clone(),
        pass: cfg.pass.clone(),
    };

    // 1. Reuse the supervisor's health-check.
    wait_until_ready(&connection).expect("rclone daemon became ready");

    // 2. Additionally POST core/version with basic auth and inspect the body.
    let client = reqwest::blocking::Client::new();
    let url = format!("{}/core/version", connection.base_url);
    let resp = client
        .post(&url)
        .basic_auth(&connection.user, Some(&connection.pass))
        .send()
        .expect("POST core/version");
    assert!(
        resp.status().is_success(),
        "core/version returned {}",
        resp.status()
    );
    let body = resp.text().expect("read core/version body");
    eprintln!("core/version response: {body}");
    assert!(
        body.contains("\"version\""),
        "core/version JSON should contain a \"version\" field, got: {body}"
    );
}
