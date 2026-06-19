//! End-to-end integration test that proves the bundled rclone binary actually
//! works as an rc daemon, WITHOUT needing a Tauri AppHandle.
//!
//! It reuses the crate's pure helpers (`build_rcd_args`, `pick_free_port`) and
//! the supervisor's `wait_until_ready` / `RcConnection`, but spawns the raw
//! binary via `std::process::Command` instead of the Tauri sidecar API.

use google_drive_downloader_lib::rclone::config::{build_rcd_args, pick_free_port, RcConfig};
use google_drive_downloader_lib::rclone::supervisor::{rc_post, wait_until_ready, RcConnection};
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

/// Build a unique temp path for an rclone config file so tests never touch the
/// user's real config. The file need not pre-exist; rclone creates it on write.
fn temp_config_path(tag: &str) -> PathBuf {
    let name = format!("rclone-test-{}-{}.conf", tag, std::process::id());
    std::env::temp_dir().join(name)
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
    let config_path = temp_config_path("core_version");
    let cfg = RcConfig {
        host: "127.0.0.1".into(),
        port,
        user: "testuser".into(),
        pass: "testpass".into(),
        config_path: config_path.to_string_lossy().into_owned(),
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

    // 3. Prove the new Rust-routed path: rc_post is exactly what the rc_call
    //    Tauri command calls under the hood. The frontend never touches HTTP.
    let json = rc_post(&connection, "core/version", &serde_json::json!({}))
        .expect("rc_post core/version");
    eprintln!("rc_post core/version response: {json}");
    assert!(
        json.get("version").is_some(),
        "rc_post core/version JSON should contain a \"version\" field, got: {json}"
    );
}

/// Proves the `--config <path>` wiring end-to-end: spawn the daemon against a
/// fresh temp config and assert `config/listremotes` returns an empty/clean
/// list. This exercises the list path the `list_accounts` command relies on,
/// without needing OAuth or real credentials.
#[test]
fn rclone_daemon_listremotes_empty_with_temp_config() {
    let binary = match find_rclone_binary() {
        Some(p) => p,
        None => {
            eprintln!("SKIP: no rclone binary found under binaries/rclone-* — skipping test");
            return;
        }
    };

    // A fresh temp config that doesn't exist yet → no remotes configured.
    let config_path = temp_config_path("listremotes");
    let _ = std::fs::remove_file(&config_path);

    let port = pick_free_port().expect("pick a free port");
    let cfg = RcConfig {
        host: "127.0.0.1".into(),
        port,
        user: "testuser".into(),
        pass: "testpass".into(),
        config_path: config_path.to_string_lossy().into_owned(),
    };
    let args = build_rcd_args(&cfg);

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

    wait_until_ready(&connection).expect("rclone daemon became ready");

    let json = rc_post(&connection, "config/listremotes", &serde_json::json!({}))
        .expect("rc_post config/listremotes");
    eprintln!("config/listremotes response: {json}");

    // A fresh config has no remotes. rclone reports this as either a `null`
    // "remotes" value or an empty array — `list_accounts` treats both as []. We
    // assert the same: the array form must be empty if present.
    let remotes = json.get("remotes").expect("response has a \"remotes\" key");
    let empty = remotes.is_null() || remotes.as_array().is_some_and(|a| a.is_empty());
    assert!(
        empty,
        "fresh temp config should have no remotes, got: {remotes}"
    );

    // Cleanup the temp config if rclone created it.
    let _ = std::fs::remove_file(&config_path);
}
