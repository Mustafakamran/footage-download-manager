//! Loopback ingest server for the FDM browser extension.
//!
//! A tiny `tiny_http` server (mirroring `stream.rs`) binds to a FIXED loopback
//! port so the browser extension can find it without discovery. It exposes:
//!   - `GET  /fdm/ping`   → `{ ok, version }` so the extension can detect FDM and
//!     confirm its pairing token is valid (the token is *not* required to ping).
//!   - `POST /fdm/ingest` → hands a `{ url, kind }` off to the app, gated by an
//!     `X-FDM-Token` header that must match the persistent pairing token.
//!
//! All responses carry permissive CORS headers and the server answers `OPTIONS`
//! preflight requests, because the extension calls in from a web origin.
//!
//! On a valid ingest the server emits a Tauri `ingest-url` event with the body,
//! which the frontend turns into a download (media → yt-dlp, file → direct HTTP).

use crate::rclone::config::random_secret;
use crate::secrets;
use serde::Deserialize;
use serde_json::json;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};
use tiny_http::{Header, Method, Response, Server};

/// Fixed loopback port the extension targets. Best-effort: if it is already taken
/// (another FDM instance, or a leftover socket), we log and skip — the app still
/// runs, just without browser ingest.
const INGEST_PORT: u16 = 53713;

/// Keychain key under which the persistent pairing token is stored.
const TOKEN_KEY: &str = "ingest_token";

/// Length of a freshly generated pairing token.
const TOKEN_LEN: usize = 40;

/// Return the persistent pairing token, generating + persisting one on first use.
///
/// The token lives in the OS keychain (via `crate::secrets`) so it survives
/// restarts and reinstalls of the app config; the extension stores the same value
/// and sends it back as `X-FDM-Token`.
pub fn token() -> Result<String, String> {
    if let Some(existing) = secrets::get_secret(TOKEN_KEY)? {
        if !existing.is_empty() {
            return Ok(existing);
        }
    }
    let fresh = random_secret(TOKEN_LEN);
    secrets::set_secret(TOKEN_KEY, &fresh)?;
    Ok(fresh)
}

/// Tauri command: the pairing token to display (with a copy button) in Settings.
#[tauri::command]
pub fn ingest_token() -> Result<String, String> {
    token()
}

/// Recursively copy `src` into `dst`, creating directories as needed. Existing
/// files are overwritten so a "set up extension" re-run always lands the bundled
/// version (e.g. after an app update ships a newer extension).
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Tauri command: stage the bundled browser extension into a stable, user-writable
/// folder and return that absolute path.
///
/// The in-bundle resource dir is read-only/hidden (inside the .app / install dir),
/// so Chrome's "Load unpacked" can't reliably point at it. We copy the resource's
/// `extension/` folder into `app_data_dir()/extension` (recreated each call so it
/// stays in sync with the installed app) and hand back that path for the guided
/// "Load unpacked" step.
#[tauri::command]
pub fn prepare_extension(app: AppHandle) -> Result<String, String> {
    let resource = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir: {e}"))?
        .join("extension");
    if !resource.is_dir() {
        return Err(format!(
            "bundled extension not found at {}",
            resource.display()
        ));
    }

    let dest: PathBuf = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("extension");

    // Recreate from scratch so a stale copy never lingers across updates.
    if dest.exists() {
        std::fs::remove_dir_all(&dest)
            .map_err(|e| format!("clear {}: {e}", dest.display()))?;
    }
    copy_dir_all(&resource, &dest).map_err(|e| format!("copy extension: {e}"))?;

    Ok(dest.to_string_lossy().into_owned())
}

/// Tauri command: reveal `path` in the OS file manager (Finder / Explorer) so the
/// user can point Chrome's "Load unpacked" at the staged extension folder.
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("open {path}: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("explorer")
            .arg(&path)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("explorer {path}: {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("xdg-open {path}: {e}"))?;
    }
    Ok(())
}

/// Body of a `POST /fdm/ingest` request.
///
/// The optional fields are additive: the extension may supply a suggested
/// `filename`, the originating page's `referrer`, the page `cookie`/`ua` so
/// cookie/referer-gated direct downloads succeed, and `prompt` to force the
/// native save dialog regardless of the user's `askWhereToSave` setting.
#[derive(Deserialize)]
struct IngestBody {
    url: String,
    /// "file" (direct download) or "media" (social/video via yt-dlp).
    kind: String,
    #[serde(default)]
    filename: Option<String>,
    #[serde(default)]
    referrer: Option<String>,
    #[serde(default)]
    cookie: Option<String>,
    #[serde(default)]
    ua: Option<String>,
    #[serde(default)]
    prompt: Option<bool>,
}

fn header(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).expect("valid header")
}

/// The CORS headers every response carries (the extension calls cross-origin).
fn cors_headers() -> [Header; 3] {
    [
        header("Access-Control-Allow-Origin", "*"),
        header("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
        header("Access-Control-Allow-Headers", "Content-Type, X-FDM-Token"),
    ]
}

/// Constant-time-ish comparison so token validation does not leak length/contents
/// via early-exit timing. Returns false on any length mismatch.
fn token_matches(expected: &str, got: &str) -> bool {
    let a = expected.as_bytes();
    let b = got.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Validate that `kind` is one we route, normalizing to "file"/"media".
fn normalize_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "file" => Some("file"),
        "media" => Some("media"),
        _ => None,
    }
}

/// Read the `X-FDM-Token` header value from a request, if present.
fn token_header(req: &tiny_http::Request) -> Option<String> {
    req.headers()
        .iter()
        .find(|h| h.field.equiv("X-FDM-Token"))
        .map(|h| h.value.as_str().to_string())
}

/// Send a JSON body with the given status and CORS headers.
fn respond_json(req: tiny_http::Request, status: u16, body: serde_json::Value) {
    let mut resp = Response::from_string(body.to_string())
        .with_status_code(status)
        .with_header(header("Content-Type", "application/json"));
    for h in cors_headers() {
        resp = resp.with_header(h);
    }
    let _ = req.respond(resp);
}

/// Handle one incoming request. Pure routing + side effects (event emit); kept
/// small so the unit-tested helpers (`token_matches`, `normalize_kind`) carry the
/// logic.
fn handle(app: &AppHandle, version: &str, expected_token: &str, mut req: tiny_http::Request) {
    let method = req.method().clone();
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or(&url).to_string();

    // CORS preflight: answer any OPTIONS with the allow headers and an empty body.
    if method == Method::Options {
        let mut resp = Response::from_string("").with_status_code(204);
        for h in cors_headers() {
            resp = resp.with_header(h);
        }
        let _ = req.respond(resp);
        return;
    }

    match (&method, path.as_str()) {
        (Method::Get, "/fdm/ping") => {
            respond_json(req, 200, json!({ "ok": true, "version": version }));
        }
        (Method::Post, "/fdm/ingest") => {
            // Gate on the pairing token before reading/acting on the body.
            match token_header(&req) {
                Some(t) if token_matches(expected_token, &t) => {}
                _ => {
                    respond_json(req, 401, json!({ "ok": false, "error": "bad token" }));
                    return;
                }
            }

            let mut body = String::new();
            if std::io::Read::read_to_string(req.as_reader(), &mut body).is_err() {
                respond_json(req, 400, json!({ "ok": false, "error": "unreadable body" }));
                return;
            }
            let parsed: IngestBody = match serde_json::from_str(&body) {
                Ok(b) => b,
                Err(_) => {
                    respond_json(req, 400, json!({ "ok": false, "error": "bad json" }));
                    return;
                }
            };
            let kind = match normalize_kind(&parsed.kind) {
                Some(k) => k,
                None => {
                    respond_json(req, 400, json!({ "ok": false, "error": "bad kind" }));
                    return;
                }
            };
            if parsed.url.trim().is_empty() {
                respond_json(req, 400, json!({ "ok": false, "error": "empty url" }));
                return;
            }

            let _ = app.emit(
                "ingest-url",
                json!({
                    "url": parsed.url,
                    "kind": kind,
                    "filename": parsed.filename,
                    "referrer": parsed.referrer,
                    "cookie": parsed.cookie,
                    "ua": parsed.ua,
                    "prompt": parsed.prompt,
                }),
            );
            respond_json(req, 200, json!({ "ok": true }));
        }
        _ => {
            respond_json(req, 404, json!({ "ok": false, "error": "not found" }));
        }
    }
}

/// Start the loopback ingest server on the FIXED port. Best-effort: a port that is
/// already in use is logged and the function returns `Ok(())` so app startup is
/// never blocked by browser-ingest being unavailable.
pub fn start_ingest_server(app: &AppHandle) {
    // Resolve (and persist) the pairing token up front so the ping/ingest threads
    // share one stable value without touching the keychain per request.
    let expected_token = match token() {
        Ok(t) => t,
        Err(e) => {
            eprintln!("ingest: could not load pairing token: {e}");
            return;
        }
    };

    let server = match Server::http(format!("127.0.0.1:{INGEST_PORT}")) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("ingest: port {INGEST_PORT} unavailable ({e}); browser ingest disabled");
            return;
        }
    };

    let version = app.package_info().version.to_string();
    let app = app.clone();
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            let app = app.clone();
            let version = version.clone();
            let token = expected_token.clone();
            std::thread::spawn(move || handle(&app, &version, &token, req));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_matches_only_on_exact_equal() {
        assert!(token_matches("abc123", "abc123"));
        assert!(!token_matches("abc123", "abc124"));
        assert!(!token_matches("abc123", "abc12")); // length mismatch
        assert!(!token_matches("abc123", "abc1234"));
        assert!(!token_matches("", "x"));
        assert!(token_matches("", ""));
    }

    #[test]
    fn normalize_kind_accepts_only_known() {
        assert_eq!(normalize_kind("file"), Some("file"));
        assert_eq!(normalize_kind("media"), Some("media"));
        assert_eq!(normalize_kind("FILE"), None);
        assert_eq!(normalize_kind("video"), None);
        assert_eq!(normalize_kind(""), None);
    }

    #[test]
    fn ingest_body_parses() {
        // Minimal body: the new optional fields default to None.
        let b: IngestBody =
            serde_json::from_str(r#"{"url":"https://x.test/v","kind":"media"}"#).unwrap();
        assert_eq!(b.url, "https://x.test/v");
        assert_eq!(b.kind, "media");
        assert_eq!(b.filename, None);
        assert_eq!(b.referrer, None);
        assert_eq!(b.cookie, None);
        assert_eq!(b.ua, None);
        assert_eq!(b.prompt, None);
    }

    #[test]
    fn copy_dir_all_copies_nested_tree() {
        let base = std::env::temp_dir().join(format!("fdm-ext-test-{}", std::process::id()));
        let src = base.join("src");
        let nested = src.join("sub");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(src.join("manifest.json"), b"{}").unwrap();
        std::fs::write(nested.join("bg.js"), b"console.log(1)").unwrap();

        let dst = base.join("dst");
        copy_dir_all(&src, &dst).unwrap();

        assert_eq!(std::fs::read(dst.join("manifest.json")).unwrap(), b"{}");
        assert_eq!(
            std::fs::read(dst.join("sub").join("bg.js")).unwrap(),
            b"console.log(1)"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn ingest_body_parses_optional_fields() {
        let b: IngestBody = serde_json::from_str(
            r#"{
                "url":"https://x.test/f.bin",
                "kind":"file",
                "filename":"f.bin",
                "referrer":"https://x.test/page",
                "cookie":"a=1; b=2",
                "ua":"Mozilla/5.0 Test",
                "prompt":true
            }"#,
        )
        .unwrap();
        assert_eq!(b.url, "https://x.test/f.bin");
        assert_eq!(b.kind, "file");
        assert_eq!(b.filename.as_deref(), Some("f.bin"));
        assert_eq!(b.referrer.as_deref(), Some("https://x.test/page"));
        assert_eq!(b.cookie.as_deref(), Some("a=1; b=2"));
        assert_eq!(b.ua.as_deref(), Some("Mozilla/5.0 Test"));
        assert_eq!(b.prompt, Some(true));
    }
}
