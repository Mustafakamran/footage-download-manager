//! Account model + rclone-backed account management.
//!
//! Each cloud account is an rclone remote named `<provider>_<slug>`. The pure
//! helpers (`remote_name`, `parse_remote`, `config_create_args`) are unit-tested;
//! the command wrappers talk to the running rc daemon (`rc_post`) or spawn the
//! rclone sidecar one-shot for the OAuth flow.

use crate::rclone::supervisor::{rc_post, RcloneState};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

/// Tracks the in-flight OAuth (`rclone config create`) child so a new connect
/// attempt can kill a previous one still holding the loopback auth port (53682).
#[derive(Default, Clone)]
pub struct OAuthState(pub Arc<Mutex<Option<CommandChild>>>);

/// A cloud account, derived from an rclone remote.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Account {
    /// The rclone remote name; doubles as the stable account id.
    pub id: String,
    /// "drive" or "dropbox".
    pub provider: String,
    /// The slug reconstructed from the remote name (e.g. "client_a"). This is
    /// always the sanitized slug form, NOT the user's original label — the
    /// original capitalization/spacing is not stored and cannot be recovered.
    pub label: String,
}

/// The providers we support, matching the rclone backend names we configure.
const PROVIDERS: [&str; 2] = ["drive", "dropbox"];

/// Sanitize a label into a slug: lowercase, keep [a-z0-9_], map everything else
/// to `_`, collapse runs of `_`, and trim leading/trailing `_`.
fn slugify(label: &str) -> String {
    let mut out = String::with_capacity(label.len());
    let mut prev_underscore = false;
    for ch in label.chars() {
        let mapped = if ch.is_ascii_alphanumeric() {
            ch.to_ascii_lowercase()
        } else {
            '_'
        };
        if mapped == '_' {
            // Collapse repeats; skip the leading underscore entirely.
            if !prev_underscore && !out.is_empty() {
                out.push('_');
            }
            prev_underscore = true;
        } else {
            out.push(mapped);
            prev_underscore = false;
        }
    }
    // Trim a trailing underscore left by trailing junk.
    while out.ends_with('_') {
        out.pop();
    }
    out
}

/// Build the rclone remote name for a provider + label.
pub fn remote_name(provider: &str, label: &str) -> String {
    format!("{}_{}", provider, slugify(label))
}

/// Parse an rclone remote name into an `Account`. Returns `None` if the remote
/// doesn't start with a known provider prefix or has no `_` separator.
pub fn parse_remote(remote: &str) -> Option<Account> {
    let (provider, slug) = remote.split_once('_')?;
    if !PROVIDERS.contains(&provider) {
        return None;
    }
    if slug.is_empty() {
        return None;
    }
    Some(Account {
        id: remote.to_string(),
        provider: provider.to_string(),
        // Slug form is fine as a display fallback.
        label: slug.to_string(),
    })
}

/// Build the `rclone config create` CLI argument vector for a new remote.
///
/// `rclone config create` runs the full OAuth browser flow and saves the remote
/// into the file at `config_path`.
pub fn config_create_args(
    config_path: &str,
    remote: &str,
    provider: &str,
    client_id: &str,
    client_secret: &str,
) -> Vec<String> {
    match provider {
        // NOTE: do NOT set config_is_local=false. That tells rclone it's on a
        // headless/remote machine and to skip the local browser OAuth flow,
        // which saves the remote with an EMPTY token. This app runs on the
        // user's desktop with a browser, so we use the default (local) flow.
        "drive" => vec![
            "config".into(),
            "create".into(),
            remote.into(),
            "drive".into(),
            "client_id".into(),
            client_id.into(),
            "client_secret".into(),
            client_secret.into(),
            "scope".into(),
            "drive.readonly".into(),
            "--config".into(),
            config_path.into(),
        ],
        // dropbox (and any other future provider routed here)
        _ => vec![
            "config".into(),
            "create".into(),
            remote.into(),
            "dropbox".into(),
            "client_id".into(),
            client_id.into(),
            "client_secret".into(),
            client_secret.into(),
            "--config".into(),
            config_path.into(),
        ],
    }
}

/// List all configured accounts by reading rclone's remote list.
#[tauri::command]
pub fn list_accounts(state: tauri::State<RcloneState>) -> Result<Vec<Account>, String> {
    // Recover from a poisoned lock (matches supervisor.rs) so a single panic
    // elsewhere doesn't permanently brick this command.
    let conn = state
        .connection
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| "rclone not started".to_string())?;
    let resp = rc_post(&conn, "config/listremotes", &serde_json::json!({}))?;
    let remotes = match resp.get("remotes").and_then(|v| v.as_array()) {
        Some(arr) => arr,
        None => return Ok(vec![]),
    };
    Ok(remotes
        .iter()
        .filter_map(|v| v.as_str())
        .filter_map(parse_remote)
        .collect())
}

/// Remove an account by deleting its rclone remote.
#[tauri::command]
pub fn remove_account(state: tauri::State<RcloneState>, id: String) -> Result<(), String> {
    // Recover from a poisoned lock (matches supervisor.rs).
    let conn = state
        .connection
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| "rclone not started".to_string())?;
    rc_post(&conn, "config/delete", &serde_json::json!({ "name": id }))?;
    Ok(())
}

/// How long to wait for the interactive OAuth flow to complete. Generous,
/// because the user must consent in a browser.
const OAUTH_TIMEOUT: Duration = Duration::from_secs(300);

/// Add a new account: configure the rclone remote via the interactive OAuth
/// flow (`rclone config create`) and return the resulting `Account`.
///
/// NOTE: This requires the user's own OAuth client credentials and a manual
/// browser consent step, so it cannot be unit-tested headlessly.
#[tauri::command]
pub async fn add_account(
    app: AppHandle,
    oauth: tauri::State<'_, OAuthState>,
    provider: String,
    label: String,
    client_id: String,
    client_secret: String,
) -> Result<Account, String> {
    if !PROVIDERS.contains(&provider.as_str()) {
        return Err(format!("unknown provider: {provider}"));
    }
    // Own the Arc so we don't hold the State borrow across await points.
    let oauth = oauth.inner().clone();
    let remote = remote_name(&provider, &label);

    // Same persistent config file the daemon uses (see start_rclone).
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("create app_data_dir: {e}"))?;
    let config_path = data_dir.join("rclone.conf").to_string_lossy().into_owned();

    let args = config_create_args(&config_path, &remote, &provider, &client_id, &client_secret);

    // Kill any previous in-flight OAuth attempt still holding the loopback auth
    // port (53682), then give the OS a moment to release it. Without this, a
    // second connect fails with "address already in use". Scope the lock so the
    // MutexGuard is dropped before the await (keeps the future Send).
    let prev = oauth.0.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(prev) = prev {
        let _ = prev.kill();
        tokio::time::sleep(Duration::from_millis(400)).await;
    }

    // Spawn the sidecar as a ONE-SHOT (not the daemon) and wait for it to exit.
    let (mut rx, child) = app
        .shell()
        .sidecar("rclone")
        .map_err(|e| format!("sidecar: {e}"))?
        .args(args)
        .spawn()
        .map_err(|e| format!("spawn: {e}"))?;

    // Track the live child so a later connect (or timeout) can kill it.
    // tauri-plugin-shell's CommandChild does NOT kill on drop.
    *oauth.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);

    // Drain events until Terminated, accumulating stderr for error reporting.
    let mut stderr = String::new();
    let collect = async {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stderr(bytes) => {
                    stderr.push_str(&String::from_utf8_lossy(&bytes));
                    stderr.push('\n');
                }
                CommandEvent::Error(e) => {
                    stderr.push_str(&e);
                    stderr.push('\n');
                }
                CommandEvent::Terminated(payload) => {
                    return payload.code;
                }
                CommandEvent::Stdout(_) => {}
                _ => {}
            }
        }
        // Channel closed without an explicit Terminated event.
        None
    };

    let code = match tokio::time::timeout(OAUTH_TIMEOUT, collect).await {
        Ok(code) => code,
        Err(_) => {
            // Timed out: kill the tracked child (kill consumes it).
            if let Some(c) = oauth.0.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = c.kill();
            }
            return Err(format!(
                "rclone config create timed out after {OAUTH_TIMEOUT:?}"
            ));
        }
    };

    // Process exited on its own; drop the now-dead handle.
    let _ = oauth.0.lock().unwrap_or_else(|e| e.into_inner()).take();

    match code {
        Some(0) => parse_remote(&remote).ok_or_else(|| format!("invalid remote name: {remote}")),
        other => Err(format!(
            "rclone config create failed (exit {other:?}): {stderr}"
        )),
    }
}

/// Store an OAuth app credential in the OS keychain.
#[tauri::command]
pub fn set_secret(key: String, value: String) -> Result<(), String> {
    crate::secrets::set_secret(&key, &value)
}

/// Read an OAuth app credential from the OS keychain (None if absent).
#[tauri::command]
pub fn get_secret(key: String) -> Result<Option<String>, String> {
    crate::secrets::get_secret(&key)
}

/// Delete an OAuth app credential from the OS keychain.
#[tauri::command]
pub fn delete_secret(key: String) -> Result<(), String> {
    crate::secrets::delete_secret(&key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_name_sanitizes_label() {
        assert_eq!(remote_name("drive", "Client A"), "drive_client_a");
        assert_eq!(remote_name("dropbox", "My  Work!!"), "dropbox_my_work");
        assert_eq!(remote_name("drive", "  spaced  out  "), "drive_spaced_out");
        assert_eq!(remote_name("drive", "Aa-Bb.Cc"), "drive_aa_bb_cc");
    }

    #[test]
    fn parse_remote_round_trips() {
        let remote = remote_name("drive", "Client A");
        let acct = parse_remote(&remote).expect("should parse");
        assert_eq!(acct.id, "drive_client_a");
        assert_eq!(acct.provider, "drive");
        assert_eq!(acct.label, "client_a");

        let acct = parse_remote("dropbox_my_work").expect("should parse");
        assert_eq!(acct.provider, "dropbox");
        assert_eq!(acct.label, "my_work");
    }

    #[test]
    fn parse_remote_rejects_unknown_and_unprefixed() {
        // Unknown provider prefix.
        assert!(parse_remote("onedrive_foo").is_none());
        // No provider prefix / no separator.
        assert!(parse_remote("drive").is_none());
        assert!(parse_remote("dropbox").is_none());
        assert!(parse_remote("randomremote").is_none());
        // Prefix but empty slug.
        assert!(parse_remote("drive_").is_none());
    }

    #[test]
    fn config_create_args_drive() {
        let args = config_create_args(
            "/data/rclone.conf",
            "drive_client_a",
            "drive",
            "cid",
            "csecret",
        );
        assert_eq!(
            args,
            vec![
                "config",
                "create",
                "drive_client_a",
                "drive",
                "client_id",
                "cid",
                "client_secret",
                "csecret",
                "scope",
                "drive.readonly",
                "--config",
                "/data/rclone.conf",
            ]
        );
    }

    #[test]
    fn config_create_args_dropbox() {
        let args = config_create_args(
            "/data/rclone.conf",
            "dropbox_work",
            "dropbox",
            "key",
            "secret",
        );
        assert_eq!(
            args,
            vec![
                "config",
                "create",
                "dropbox_work",
                "dropbox",
                "client_id",
                "key",
                "client_secret",
                "secret",
                "--config",
                "/data/rclone.conf",
            ]
        );
    }
}
