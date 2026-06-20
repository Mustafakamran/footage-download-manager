//! Native Google Drive API helpers — used only to resolve an uploader's display
//! name, which rclone does not expose. Reads the account's OAuth token + client
//! credentials from rclone's config (`config/dump`), refreshes the access token,
//! and queries the Drive `files.get` endpoint. Best-effort: any failure yields
//! `None` so notifications still work without the name.

use crate::rclone::supervisor::{rc_post, RcConnection, RcloneState};
use serde_json::Value;

/// Pull `token`, `client_id`, `client_secret` for a remote out of `config/dump`.
pub(crate) fn remote_creds(dump: &Value, remote: &str) -> Option<(String, String, String)> {
    let cfg = dump.get(remote)?;
    let token = cfg.get("token").and_then(|v| v.as_str())?.to_string();
    let client_id = cfg.get("client_id").and_then(|v| v.as_str())?.to_string();
    let client_secret = cfg.get("client_secret").and_then(|v| v.as_str())?.to_string();
    Some((token, client_id, client_secret))
}

/// rclone stores the OAuth token as a JSON string; pull the refresh token out.
fn refresh_token_from(token_json: &str) -> Option<String> {
    let v: Value = serde_json::from_str(token_json).ok()?;
    v.get("refresh_token").and_then(|t| t.as_str()).map(|s| s.to_string())
}

/// Prefer the last modifier's name, else the first owner's name.
fn name_from_drive_file(v: &Value) -> Option<String> {
    let last = v
        .get("lastModifyingUser")
        .and_then(|u| u.get("displayName"))
        .and_then(|d| d.as_str());
    let owner = v
        .get("owners")
        .and_then(|o| o.as_array())
        .and_then(|a| a.first())
        .and_then(|o| o.get("displayName"))
        .and_then(|d| d.as_str());
    last.or(owner).map(|s| s.to_string())
}

/// Percent-encode a value for an x-www-form-urlencoded body.
fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Exchange a refresh token for a fresh access token at the given OAuth endpoint.
fn refresh_at(endpoint: &str, client_id: &str, client_secret: &str, refresh_token: &str) -> Result<String, String> {
    let client = reqwest::blocking::Client::new();
    let body = format!(
        "client_id={}&client_secret={}&refresh_token={}&grant_type=refresh_token",
        enc(client_id),
        enc(client_secret),
        enc(refresh_token),
    );
    let resp = client
        .post(endpoint)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .map_err(|e| e.to_string())?;
    let text = resp.text().map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    v.get("access_token")
        .and_then(|a| a.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("no access_token in refresh response: {text}"))
}

/// Query Drive for a file's uploader/owner display name. Returns Ok(None) when
/// unavailable (e.g. no name on the record); Err only on hard failures.
#[tauri::command]
pub fn drive_uploader(
    rclone: tauri::State<RcloneState>,
    account_id: String,
    file_id: String,
) -> Result<Option<String>, String> {
    let conn: RcConnection = rclone
        .connection
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| "rclone not started".to_string())?;

    let dump = rc_post(&conn, "config/dump", &serde_json::json!({}))?;
    let (token_json, client_id, client_secret) =
        remote_creds(&dump, &account_id).ok_or_else(|| format!("no creds for {account_id}"))?;
    let refresh = refresh_token_from(&token_json).ok_or_else(|| "no refresh token".to_string())?;
    let access = refresh_at("https://oauth2.googleapis.com/token", &client_id, &client_secret, &refresh)?;

    let client = reqwest::blocking::Client::new();
    let url = format!(
        "https://www.googleapis.com/drive/v3/files/{file_id}?fields=owners(displayName),lastModifyingUser(displayName)&supportsAllDrives=true"
    );
    let resp = client
        .get(&url)
        .bearer_auth(&access)
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        return Err(format!("drive files.get {status}: {body}"));
    }
    let text = resp.text().map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(name_from_drive_file(&v))
}

/// The Drive account's email via the native about endpoint (rclone doesn't
/// expose it). Best-effort: Err/None when unavailable.
pub fn drive_email(conn: &RcConnection, account_id: &str) -> Result<Option<String>, String> {
    let dump = rc_post(conn, "config/dump", &serde_json::json!({}))?;
    let (token_json, client_id, client_secret) =
        remote_creds(&dump, account_id).ok_or_else(|| format!("no creds for {account_id}"))?;
    let refresh = refresh_token_from(&token_json).ok_or_else(|| "no refresh token".to_string())?;
    let access = refresh_at("https://oauth2.googleapis.com/token", &client_id, &client_secret, &refresh)?;

    let client = reqwest::blocking::Client::new();
    let resp = client
        .get("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)")
        .bearer_auth(&access)
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        return Err(format!("drive about {status}: {body}"));
    }
    let text = resp.text().map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v.get("user")
        .and_then(|u| u.get("emailAddress"))
        .and_then(|e| e.as_str())
        .map(|s| s.to_string()))
}

/// The Dropbox account's email via the native users/get_current_account endpoint
/// (rclone's `config userinfo` reports "doesn't support UserInfo" for some remotes).
pub fn dropbox_email(conn: &RcConnection, account_id: &str) -> Result<Option<String>, String> {
    let dump = rc_post(conn, "config/dump", &serde_json::json!({}))?;
    let (token_json, client_id, client_secret) =
        remote_creds(&dump, account_id).ok_or_else(|| format!("no creds for {account_id}"))?;
    let refresh = refresh_token_from(&token_json).ok_or_else(|| "no refresh token".to_string())?;
    let access = refresh_at("https://api.dropboxapi.com/oauth2/token", &client_id, &client_secret, &refresh)?;

    let client = reqwest::blocking::Client::new();
    let resp = client
        .post("https://api.dropboxapi.com/2/users/get_current_account")
        .bearer_auth(&access)
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        return Err(format!("dropbox get_current_account {status}: {body}"));
    }
    let text = resp.text().map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v.get("email").and_then(|e| e.as_str()).map(|s| s.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_creds_from_dump() {
        let dump = json!({
            "drive_x": { "type": "drive", "token": "{\"refresh_token\":\"R\"}", "client_id": "cid", "client_secret": "csec" }
        });
        let (t, id, sec) = remote_creds(&dump, "drive_x").unwrap();
        assert_eq!(id, "cid");
        assert_eq!(sec, "csec");
        assert_eq!(refresh_token_from(&t).unwrap(), "R");
        assert!(remote_creds(&dump, "missing").is_none());
    }

    #[test]
    fn picks_last_modifier_then_owner() {
        let v = json!({
            "lastModifyingUser": { "displayName": "Alex Editor" },
            "owners": [{ "displayName": "Owner One" }]
        });
        assert_eq!(name_from_drive_file(&v).unwrap(), "Alex Editor");

        let owner_only = json!({ "owners": [{ "displayName": "Owner One" }] });
        assert_eq!(name_from_drive_file(&owner_only).unwrap(), "Owner One");

        assert!(name_from_drive_file(&json!({})).is_none());
    }
}
