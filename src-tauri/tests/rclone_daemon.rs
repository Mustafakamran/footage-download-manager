//! End-to-end integration test that proves the bundled rclone binary actually
//! works as an rc daemon, WITHOUT needing a Tauri AppHandle.
//!
//! It reuses the crate's pure helpers (`build_rcd_args`, `pick_free_port`) and
//! the supervisor's `wait_until_ready` / `RcConnection`, but spawns the raw
//! binary via `std::process::Command` instead of the Tauri sidecar API.

use google_drive_downloader_lib::download::{build_copy, DownloadItem};
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

    let connection = RcConnection::new(
        format!("http://{}:{}", cfg.host, cfg.port),
        cfg.user.clone(),
        cfg.pass.clone(),
    );

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

    let connection = RcConnection::new(
        format!("http://{}:{}", cfg.host, cfg.port),
        cfg.user.clone(),
        cfg.pass.clone(),
    );

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

/// Proves the full download machinery offline: an async `operations/copyfile`
/// (built by `build_copy`) from one local dir to another, polled to completion
/// via `job/status`, with the bytes actually landing. No cloud account needed —
/// this exercises the exact rc plumbing the `start_download`/`list_jobs`
/// commands use.
#[test]
fn rclone_async_copyfile_completes_locally() {
    let binary = match find_rclone_binary() {
        Some(p) => p,
        None => {
            eprintln!("SKIP: no rclone binary found under binaries/rclone-* — skipping test");
            return;
        }
    };

    // Set up temp src (with a file) + dst dirs.
    let base = std::env::temp_dir().join(format!("dl-test-{}", std::process::id()));
    let src = base.join("src");
    let dst = base.join("dst");
    std::fs::create_dir_all(&src).expect("mk src");
    std::fs::create_dir_all(&dst).expect("mk dst");
    let content = "hello rclone download path";
    std::fs::write(src.join("f.bin"), content).expect("write src file");

    let port = pick_free_port().expect("pick a free port");
    let config_path = temp_config_path("download");
    let cfg = RcConfig {
        host: "127.0.0.1".into(),
        port,
        user: "testuser".into(),
        pass: "testpass".into(),
        config_path: config_path.to_string_lossy().into_owned(),
    };
    let args = build_rcd_args(&cfg);
    let child = Command::new(&binary).args(&args).spawn().expect("spawn rclone rcd");
    let _guard = ChildGuard(child);

    let connection = RcConnection::new(
        format!("http://{}:{}", cfg.host, cfg.port),
        cfg.user.clone(),
        cfg.pass.clone(),
    );
    wait_until_ready(&connection).expect("rclone daemon became ready");

    // Build the copy request via the production helper (local fs as "account").
    let item = DownloadItem {
        path: "f.bin".into(),
        name: "f.bin".into(),
        is_dir: false,
        size: content.len() as i64,
        id: String::new(),
    };
    let (endpoint, params) = build_copy(&src.to_string_lossy(), &item, &dst.to_string_lossy());
    assert_eq!(endpoint, "operations/copyfile");

    let resp = rc_post(&connection, endpoint, &params).expect("start async copyfile");
    let jobid = resp.get("jobid").and_then(|v| v.as_i64()).expect("jobid in response");
    eprintln!("started async copy job {jobid}");

    // Poll job/status until finished (generous local timeout).
    let mut finished = false;
    let mut success = false;
    for _ in 0..100 {
        let js = rc_post(&connection, "job/status", &serde_json::json!({ "jobid": jobid }))
            .expect("job/status");
        if js.get("finished").and_then(|v| v.as_bool()).unwrap_or(false) {
            finished = true;
            success = js.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(finished, "copy job should finish");
    assert!(success, "copy job should succeed");

    // The bytes actually landed.
    let copied = std::fs::read_to_string(dst.join("f.bin")).expect("dst file exists");
    assert_eq!(copied, content, "copied content matches source");

    let _ = std::fs::remove_dir_all(&base);
    let _ = std::fs::remove_file(&config_path);
}
