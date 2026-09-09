//! BitTorrent downloads via a bundled `rqbit` sidecar (HTTP-controlled).
//!
//! rqbit runs as a long-lived localhost HTTP server (`rqbit server start <dir>`).
//! We POST a magnet or a `.torrent` file's bytes to `/torrents` and poll
//! `/torrents/{id}/stats/v1`. Each torrent is driven by an ordinary native
//! download job (see `transfer.rs::download_torrent`) that mirrors rqbit's
//! `progress_bytes` / `total_bytes` into the shared `NativeHandles` — so torrents
//! appear in the same table + secondary lane as every other download, and the
//! speedometer derives live speed from the progress deltas.

use serde_json::Value;
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

/// The running rqbit sidecar + its loopback API base URL. Tauri-managed; the
/// sidecar is spawned lazily on the first torrent and killed on app shutdown.
#[derive(Default)]
pub struct TorrentState {
    inner: Mutex<Option<Engine>>,
}

struct Engine {
    child: CommandChild,
    /// e.g. "http://127.0.0.1:53912".
    base: String,
}

impl TorrentState {
    /// Return the API base URL, spawning rqbit on first use.
    ///
    /// The cached engine is re-validated on every call: rqbit can die between
    /// torrents (crash, OOM, a killed child), and a stale cached base would then
    /// make every add/stats fail with "error sending request" — and the graceful
    /// retry would loop forever against a dead port. So if the API no longer
    /// answers, we drop the corpse and respawn a fresh sidecar.
    pub fn ensure(&self, app: &AppHandle) -> Result<String, String> {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(e) = guard.as_ref() {
            if alive(&e.base) {
                return Ok(e.base.clone());
            }
            // Dead sidecar — reap it and fall through to a fresh spawn.
            if let Some(old) = guard.take() {
                let _ = old.child.kill();
            }
        }
        let port = free_port()?;
        let dir = default_dir(app);
        std::fs::create_dir_all(&dir).ok();
        let sidecar = app
            .shell()
            .sidecar("rqbit")
            .map_err(|e| format!("rqbit sidecar: {e}"))?
            .args([
                "--http-api-listen-addr".to_string(),
                format!("127.0.0.1:{port}"),
                // No router UPnP (keeps startup quick and avoids gateway prompts).
                // DHT persistence is left ON: rqbit caches its routing table between
                // runs, so peer discovery for magnets is fast on the next launch
                // instead of a cold DHT bootstrap every time.
                "--disable-upnp-port-forward".to_string(),
                "server".to_string(),
                "start".to_string(),
                dir.to_string_lossy().into_owned(),
            ]);
        let (_rx, child) = sidecar.spawn().map_err(|e| format!("spawn rqbit: {e}"))?;
        let base = format!("http://127.0.0.1:{port}");

        // Wait (up to ~5s) until the HTTP API answers before handing back.
        let c = http();
        let mut up = false;
        for _ in 0..50 {
            if c.get(format!("{base}/torrents")).send().map(|r| r.status().is_success()).unwrap_or(false) {
                up = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if !up {
            let _ = child.kill();
            return Err("rqbit HTTP API did not come up".into());
        }
        *guard = Some(Engine { child, base: base.clone() });
        Ok(base)
    }

    /// Kill the sidecar (called on app shutdown).
    pub fn stop(&self) {
        if let Some(e) = self.inner.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = e.child.kill();
        }
    }
}

/// Quick liveness probe for a running rqbit API (short timeout: a dead port
/// refuses instantly, but a hung one shouldn't stall the whole add).
fn alive(base: &str) -> bool {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map(|c| c.get(format!("{base}/torrents")).send().map(|r| r.status().is_success()).unwrap_or(false))
        .unwrap_or(false)
}

fn free_port() -> Result<u16, String> {
    // Bind :0 to grab a free port, then drop the listener so rqbit can take it.
    let l = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    l.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

fn default_dir(app: &AppHandle) -> PathBuf {
    // Only a fallback — every add specifies its own `output_folder`.
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("torrents")
}

fn http() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_default()
}

/// Minimal percent-encoding for a query value (the download folder path).
fn pct(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Add a magnet link or a local `.torrent` file to rqbit, downloading into
/// `dest`. Returns the rqbit torrent id.
pub fn add(base: &str, source: &str, dest: &str) -> Result<i64, String> {
    let c = http();
    let url = format!("{base}/torrents?overwrite=true&output_folder={}", pct(dest));
    let req = c.post(url);
    let req = if source.starts_with("magnet:") {
        req.body(source.to_string())
    } else {
        let bytes = std::fs::read(source).map_err(|e| format!("read .torrent file: {e}"))?;
        req.body(bytes)
    };
    let resp = req.send().map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("rqbit add {status}: {}", text.chars().take(200).collect::<String>()));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    v.get("id").and_then(|x| x.as_i64()).ok_or_else(|| "rqbit: no torrent id in response".into())
}

/// Progress snapshot for one torrent.
pub struct TStats {
    pub total: i64,
    pub progress: i64,
    pub finished: bool,
    pub error: Option<String>,
    /// Live (connected) peer count, from rqbit's `live.snapshot.peer_stats.live`.
    /// -1 while there is no live session yet (still resolving metadata).
    pub peers: i64,
}

pub fn stats(base: &str, id: i64) -> Result<TStats, String> {
    let v: Value = http()
        .get(format!("{base}/torrents/{id}/stats/v1"))
        .send()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;
    let peers = v
        .get("live")
        .and_then(|l| l.get("snapshot"))
        .and_then(|s| s.get("peer_stats"))
        .and_then(|p| p.get("live"))
        .and_then(|x| x.as_i64())
        .unwrap_or(-1);
    Ok(TStats {
        total: v.get("total_bytes").and_then(|x| x.as_i64()).unwrap_or(0),
        progress: v.get("progress_bytes").and_then(|x| x.as_i64()).unwrap_or(0),
        finished: v.get("finished").and_then(|x| x.as_bool()).unwrap_or(false),
        error: v.get("error").and_then(|x| x.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string()),
        peers,
    })
}

/// Stop tracking a torrent but KEEP its downloaded files (so a paused/cancelled
/// torrent can resume from the partial data on a re-add).
pub fn forget(base: &str, id: i64) {
    let _ = http().post(format!("{base}/torrents/{id}/forget")).send();
}
