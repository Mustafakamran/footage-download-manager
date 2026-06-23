//! Native resumable downloader (multi-connection, byte-range, block-resumable).
//!
//! Each file is split into fixed-size BLOCKs and pulled by several parallel
//! connections, each writing its block at the right offset in a preallocated
//! `<dest>.fdmpart`. A `<dest>.fdmmeta` sidecar records which blocks are done,
//! so a paused or crashed transfer resumes by re-fetching only the missing
//! blocks — for files of any size, across Drive, Dropbox and both share types.
//!
//! A global token-bucket enforces an optional bandwidth cap across all workers.
//! rclone is still used only for listing/index, not the byte transfer.

use crate::download::{account_fs, DownloadItem, NativeHandles};
use crate::dropbox;
use crate::provider::{self, Kind};
use crate::rclone::supervisor::{rc_post, RcConnection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// One block per range request / per resume unit.
const BLOCK: u64 = 8 * 1024 * 1024;
/// Refresh the access token if it's older than this (they expire in ~1h).
const TOKEN_TTL: Duration = Duration::from_secs(45 * 60);
const DEFAULT_CONNECTIONS: usize = 4;
const MAX_CONNECTIONS: usize = 16;
/// Per-block fetch attempts before giving up (transient network/5xx/429 retry).
/// A multi-hour 600GB download WILL hit dropped sockets and throttling; one blip
/// must not fail the whole file.
const MAX_BLOCK_ATTEMPTS: u32 = 8;
/// Total deadline for a single 8 MiB block request (a stalled/half-open socket
/// errors here instead of hanging forever, then the block is retried).
const BLOCK_REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
/// Browser-ish UA for generic web (HTTP) downloads — some hosts 403 a default UA.
const HTTP_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 FDM/1.0";

// ---- global bandwidth cap (token bucket) -----------------------------------

static BW_LIMIT: AtomicU64 = AtomicU64::new(0); // bytes/sec; 0 = unlimited
static BUCKET: OnceLock<Mutex<(f64, Instant)>> = OnceLock::new();

/// Set the global download bandwidth cap in bytes/sec (0 = unlimited).
pub fn set_bw_limit(bytes_per_sec: u64) {
    BW_LIMIT.store(bytes_per_sec, Ordering::SeqCst);
}

/// Block until `n` bytes are permitted under the current cap.
fn throttle(n: u64) {
    let limit = BW_LIMIT.load(Ordering::SeqCst);
    if limit == 0 {
        return;
    }
    let bucket = BUCKET.get_or_init(|| Mutex::new((0.0, Instant::now())));
    loop {
        let wait = {
            let mut g = bucket.lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            let elapsed = now.duration_since(g.1).as_secs_f64();
            g.1 = now;
            // Refill, capping the burst to ~1s worth of bytes.
            g.0 = (g.0 + elapsed * limit as f64).min(limit as f64);
            if g.0 >= n as f64 {
                g.0 -= n as f64;
                return;
            }
            (n as f64 - g.0) / limit as f64
        };
        std::thread::sleep(Duration::from_secs_f64(wait.min(1.0)));
    }
}

// ---- token cache -----------------------------------------------------------

/// Caches an access token across the many range requests of a long download,
/// refreshing when stale or rejected. Shared (Arc) across a file's workers.
struct Auth {
    conn: RcConnection,
    kind: Kind,
    token_acct: String,
    link_url: String,
    cur: Mutex<(String, Instant)>,
}

impl Auth {
    fn new(app: &AppHandle, conn: RcConnection, account_id: &str) -> Result<Self, String> {
        let kind = provider::kind_of(account_id);
        let (token_acct, link_url) = provider::token_account(app, account_id);
        let token = provider::fetch_token(&conn, kind, &token_acct)?;
        Ok(Auth { conn, kind, token_acct, link_url, cur: Mutex::new((token, Instant::now())) })
    }
    fn token(&self) -> Result<String, String> {
        // Http carries no auth — never refresh (never touches rclone).
        if self.kind == Kind::Http {
            return Ok(String::new());
        }
        let mut g = self.cur.lock().unwrap_or_else(|e| e.into_inner());
        if g.1.elapsed() > TOKEN_TTL {
            g.0 = provider::fetch_token(&self.conn, self.kind, &self.token_acct)?;
            g.1 = Instant::now();
        }
        Ok(g.0.clone())
    }
    fn refresh(&self) -> Result<String, String> {
        // Http has no token to refresh (a 401 branch is never taken for it).
        if self.kind == Kind::Http {
            return Ok(String::new());
        }
        let mut g = self.cur.lock().unwrap_or_else(|e| e.into_inner());
        g.0 = provider::fetch_token(&self.conn, self.kind, &self.token_acct)?;
        g.1 = Instant::now();
        Ok(g.0.clone())
    }
}

// ---- resume bitmap ---------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct MetaDisk {
    total: u64,
    block: u64,
    /// '1' = block complete, '0' = missing.
    done: String,
}

struct Meta {
    total: u64,
    block: u64,
    done: Vec<bool>,
}

fn part_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(".fdmpart");
    PathBuf::from(s)
}
fn meta_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(".fdmmeta");
    PathBuf::from(s)
}

fn load_meta(p: &Path) -> Option<Meta> {
    let s = std::fs::read_to_string(p).ok()?;
    let d: MetaDisk = serde_json::from_str(&s).ok()?;
    Some(Meta { total: d.total, block: d.block, done: d.done.bytes().map(|b| b == b'1').collect() })
}
fn save_meta(p: &Path, m: &Meta) -> std::io::Result<()> {
    let done: String = m.done.iter().map(|&b| if b { '1' } else { '0' }).collect();
    let d = MetaDisk { total: m.total, block: m.block, done };
    std::fs::write(p, serde_json::to_string(&d).unwrap_or_default())
}

fn len_of(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

/// Bytes already on disk for a file (finalized, or completed blocks) — seeds progress.
fn done_bytes(t: &FileTask) -> i64 {
    if t.size > 0 && len_of(&t.dest) == t.size as u64 {
        return t.size;
    }
    if let Some(m) = load_meta(&meta_path(&t.dest)) {
        if t.size <= 0 || m.total == t.size as u64 {
            let total = m.total;
            let mut sum = 0u64;
            for (i, &d) in m.done.iter().enumerate() {
                if d {
                    let off = i as u64 * m.block;
                    sum += m.block.min(total.saturating_sub(off));
                }
            }
            return sum as i64;
        }
    }
    0
}

// ---- positioned write (cross-platform) -------------------------------------

#[cfg(unix)]
fn write_at(file: &File, offset: u64, buf: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::FileExt;
    file.write_all_at(buf, offset)
}
#[cfg(windows)]
fn write_at(file: &File, offset: u64, buf: &[u8]) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    let mut written = 0usize;
    while written < buf.len() {
        let n = file.seek_write(&buf[written..], offset + written as u64)?;
        if n == 0 {
            return Err(std::io::ErrorKind::WriteZero.into());
        }
        written += n;
    }
    Ok(())
}

// ---- per-file download -----------------------------------------------------

struct FileTask {
    fid: String,
    path: String,
    size: i64,
    dest: PathBuf,
}

/// Exponential backoff (0.5s, 1s, 2s, … capped 30s) for `attempt`, waking early
/// if the job is paused/cancelled so a stuck retry doesn't ignore a pause.
fn backoff(attempt: u32, h: &NativeHandles) {
    let secs = (0.5_f64 * 2f64.powi(attempt.saturating_sub(1) as i32)).min(30.0);
    let mut slept = 0.0;
    while slept < secs {
        if h.cancelled.load(Ordering::SeqCst) {
            return;
        }
        let step = 0.2_f64.min(secs - slept);
        std::thread::sleep(Duration::from_secs_f64(step));
        slept += step;
    }
}

/// Fetch one block [offset, offset+len-1]. Retries transient failures (dropped
/// connection, body-read interruption, HTTP 429, HTTP 5xx) with backoff up to
/// `MAX_BLOCK_ATTEMPTS`; handles 401 token refresh + Drive abuse-acknowledge.
fn fetch_block(auth: &Auth, client: &reqwest::blocking::Client, t: &FileTask, offset: u64, len: u64, h: &NativeHandles) -> Result<Vec<u8>, String> {
    let end = offset + len - 1;
    let mut ack = false;
    let mut attempt: u32 = 0;
    loop {
        if h.cancelled.load(Ordering::SeqCst) {
            return Err("paused".into());
        }
        let token = auth.token()?;
        let resp = match provider::send_range(client, &token, auth.kind, &t.fid, &t.path, &auth.link_url, offset, end, ack) {
            Ok(r) => r,
            // Transport error (connection reset/dropped/timeout) — retry with backoff.
            Err(e) => {
                attempt += 1;
                if attempt >= MAX_BLOCK_ATTEMPTS {
                    return Err(format!("network error after {attempt} attempts: {e}"));
                }
                backoff(attempt, h);
                continue;
            }
        };
        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            // Token expired mid-download — refresh and retry.
            auth.refresh()?;
            attempt += 1;
            if attempt >= MAX_BLOCK_ATTEMPTS {
                return Err("unauthorized after retries".into());
            }
            continue;
        }
        if auth.kind == Kind::Drive && status == reqwest::StatusCode::FORBIDDEN && !ack {
            ack = true; // abuse-acknowledge retry (not counted against attempts)
            continue;
        }
        // Throttling / transient server errors — back off and retry.
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
            attempt += 1;
            if attempt >= MAX_BLOCK_ATTEMPTS {
                return Err(format!("download {status} after {attempt} attempts"));
            }
            backoff(attempt, h);
            continue;
        }
        if !status.is_success() {
            let b = resp.text().unwrap_or_default();
            return Err(format!("download {status}: {}", b.chars().take(300).collect::<String>()));
        }
        match resp.bytes() {
            Ok(bytes) => return Ok(bytes.to_vec()),
            // Body read interrupted (socket dropped mid-block) — retry the block.
            Err(e) => {
                attempt += 1;
                if attempt >= MAX_BLOCK_ATTEMPTS {
                    return Err(format!("read error after {attempt} attempts: {e}"));
                }
                backoff(attempt, h);
                continue;
            }
        }
    }
}

/// Download (or resume) one file with `connections` parallel block workers.
fn download_file(auth: &Arc<Auth>, client: &reqwest::blocking::Client, t: &FileTask, h: &NativeHandles, connections: usize) -> Result<(), String> {
    let total = t.size.max(0) as u64;
    if total == 0 {
        // Empty file — just create it.
        if let Some(p) = t.dest.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        File::create(&t.dest).map_err(|e| e.to_string())?;
        return Ok(());
    }
    if len_of(&t.dest) == total {
        return Ok(()); // already complete
    }
    if let Some(p) = t.dest.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }

    let part = part_path(&t.dest);
    let meta_p = meta_path(&t.dest);
    let nblocks = total.div_ceil(BLOCK) as usize;

    // Load or initialize the resume bitmap.
    let mut meta = match load_meta(&meta_p) {
        Some(m) if m.total == total && m.block == BLOCK && m.done.len() == nblocks => m,
        _ => Meta { total, block: BLOCK, done: vec![false; nblocks] },
    };

    // Preallocate the part file to full size (sparse). Recreate if size is wrong
    // (which also means the bitmap can't be trusted → start fresh).
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false) // keep any partial blocks already on disk
        .open(&part)
        .map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() != total {
        file.set_len(total).map_err(|e| e.to_string())?;
        meta = Meta { total, block: BLOCK, done: vec![false; nblocks] };
    }
    let file = Arc::new(file);
    let _ = save_meta(&meta_p, &meta);

    // Work queue of missing blocks.
    let queue: VecDeque<usize> = (0..nblocks).filter(|&i| !meta.done[i]).collect();
    if queue.is_empty() {
        // Everything is present — finalize.
        return finalize(&file, &part, &meta_p, &t.dest);
    }
    let queue = Arc::new(Mutex::new(queue));
    let meta = Arc::new(Mutex::new(meta));
    let err: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let stop = Arc::new(AtomicBool::new(false));

    let workers = connections.clamp(1, MAX_CONNECTIONS).min(nblocks);
    let mut handles = Vec::new();
    for _ in 0..workers {
        let auth = auth.clone();
        let client = client.clone();
        let file = file.clone();
        let queue = queue.clone();
        let meta = meta.clone();
        let meta_p = meta_p.clone();
        let err = err.clone();
        let stop = stop.clone();
        let h = h.clone();
        let task = FileTask { fid: t.fid.clone(), path: t.path.clone(), size: t.size, dest: t.dest.clone() };
        handles.push(std::thread::spawn(move || {
            loop {
                if stop.load(Ordering::SeqCst) || h.cancelled.load(Ordering::SeqCst) {
                    break;
                }
                let idx = match queue.lock().unwrap_or_else(|e| e.into_inner()).pop_front() {
                    Some(i) => i,
                    None => break,
                };
                let offset = idx as u64 * BLOCK;
                let len = BLOCK.min(total - offset);
                match fetch_block(&auth, &client, &task, offset, len, &h) {
                    Ok(bytes) => {
                        throttle(bytes.len() as u64);
                        if let Err(e) = write_at(&file, offset, &bytes) {
                            *err.lock().unwrap_or_else(|e| e.into_inner()) = Some(e.to_string());
                            stop.store(true, Ordering::SeqCst);
                            break;
                        }
                        h.transferred.fetch_add(len as i64, Ordering::SeqCst);
                        let mut m = meta.lock().unwrap_or_else(|e| e.into_inner());
                        m.done[idx] = true;
                        let _ = save_meta(&meta_p, &m);
                    }
                    Err(e) => {
                        *err.lock().unwrap_or_else(|e| e.into_inner()) = Some(e);
                        stop.store(true, Ordering::SeqCst);
                        break;
                    }
                }
            }
        }));
    }
    for hnd in handles {
        let _ = hnd.join();
    }

    if let Some(e) = err.lock().unwrap_or_else(|e| e.into_inner()).take() {
        return Err(e);
    }
    if h.cancelled.load(Ordering::SeqCst) {
        return Err("paused".into());
    }
    let done = meta.lock().unwrap_or_else(|e| e.into_inner()).done.iter().all(|&b| b);
    if !done {
        return Err("download incomplete".into());
    }
    finalize(&file, &part, &meta_p, &t.dest)
}

fn finalize(file: &File, part: &Path, meta_p: &Path, dest: &Path) -> Result<(), String> {
    file.sync_all().map_err(|e| e.to_string())?;
    std::fs::rename(part, dest).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(meta_p);
    Ok(())
}

fn parse_size(v: &Value) -> i64 {
    v.get("Size").and_then(|x| x.as_i64()).unwrap_or(-1)
}

/// Enumerate the files under a folder selection into per-file tasks.
fn enumerate_folder(app: &AppHandle, conn: &RcConnection, account_id: &str, item: &DownloadItem, dest_root: &Path) -> Result<Vec<FileTask>, String> {
    let mut tasks = Vec::new();
    let folder_dest = dest_root.join(&item.name);

    if account_id.starts_with("dropboxlink_") {
        let entries = dropbox::list_entries(app, conn, account_id)?;
        let prefix = format!("{}/", item.path);
        for e in &entries {
            if e.get("IsDir").and_then(|b| b.as_bool()).unwrap_or(false) {
                continue;
            }
            let p = e.get("Path").and_then(|p| p.as_str()).unwrap_or("");
            if p != item.path && !p.starts_with(&prefix) {
                continue;
            }
            let rel = p.strip_prefix(&prefix).unwrap_or(p);
            tasks.push(FileTask { fid: String::new(), path: p.to_string(), size: parse_size(e), dest: folder_dest.join(rel) });
        }
        return Ok(tasks);
    }

    let fs = account_fs(account_id)?;
    let resp = rc_post(conn, "operations/list", &json!({ "fs": fs, "remote": item.path, "opt": { "recurse": true } }))?;
    let list = resp.get("list").and_then(|l| l.as_array()).cloned().unwrap_or_default();
    let prefix = format!("{}/", item.path);
    for e in &list {
        if e.get("IsDir").and_then(|b| b.as_bool()).unwrap_or(false) {
            continue;
        }
        let raw = e.get("Path").and_then(|p| p.as_str()).unwrap_or("");
        if raw.is_empty() {
            continue;
        }
        let size = parse_size(e);
        if size < 0 {
            continue; // skip non-downloadable (e.g. Google Docs)
        }
        // rclone's operations/list returns Path relative to the fs root (already
        // includes the listed folder); be defensive in case it's relative to the
        // listed remote instead. `full` = account-root-relative path (for the
        // Dropbox provider); `rel_under` = path beneath the selected folder (dest).
        let full = if raw == item.path || raw.starts_with(&prefix) {
            raw.to_string()
        } else {
            format!("{}/{}", item.path, raw)
        };
        let rel_under = full.strip_prefix(&prefix).unwrap_or(raw).to_string();
        tasks.push(FileTask {
            fid: e.get("ID").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            path: full,
            size,
            dest: folder_dest.join(&rel_under),
        });
    }
    Ok(tasks)
}

/// Case-insensitive lookup of a request header by name (the frontend threads
/// `Referer`/`Cookie`/`User-Agent`, but match any casing defensively).
fn header_lookup<'a>(headers: &'a HashMap<String, String>, name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

/// Follow redirects manually, RE-ATTACHING the user-provided UA/Referer/Cookie on
/// every hop (and pointing Referer at the previous URL, like a browser). reqwest's
/// auto-redirect drops Cookie/Authorization across hosts, which breaks Drive /
/// mediafire-style downloads that redirect to a signed CDN on another host. Returns
/// the final (non-redirect) response.
fn http_follow(
    client: &reqwest::blocking::Client,
    url: &str,
    ua: &str,
    referer: Option<&str>,
    cookie: Option<&str>,
    range: Option<&str>,
) -> Result<reqwest::blocking::Response, String> {
    let mut cur = url.to_string();
    let mut referer = referer.map(|s| s.to_string());
    for _ in 0..10 {
        let mut req = client.get(&cur).header("User-Agent", ua);
        if let Some(r) = &referer {
            req = req.header("Referer", r);
        }
        if let Some(c) = cookie {
            req = req.header("Cookie", c);
        }
        if let Some(rg) = range {
            req = req.header("Range", rg);
        }
        let resp = req.send().map_err(|e| e.to_string())?;
        if resp.status().is_redirection() {
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or("redirect without a Location header")?;
            let next = reqwest::Url::parse(&cur)
                .and_then(|base| base.join(loc))
                .map_err(|e| e.to_string())?;
            referer = Some(cur.clone()); // browser sets Referer to the previous URL
            cur = next.to_string();
            continue;
        }
        return Ok(resp);
    }
    Err("too many redirects".into())
}

/// Stream a generic web (HTTP/HTTPS) URL to `dest`. Unlike the block engine, the
/// size is usually unknown and the server may not support Range, so we sequentially
/// stream the body into a `.fdmpart`, resuming via Range when possible and
/// restarting if the server ignores it. `url` is carried in the item's `fid`.
fn download_http(url: &str, dest: &Path, headers: &HashMap<String, String>, h: &NativeHandles) -> Result<(), String> {
    if let Some(p) = dest.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let part = part_path(dest);
    // No total-request timeout (a big file streams in one response); connect only.
    // Auto-redirect is OFF — we follow manually (http_follow) so Cookie/Referer
    // survive cross-host redirects (the common Drive/mediafire → CDN case).
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;

    // A User-Agent from the item headers overrides the default browser-ish UA
    // (some hosts gate on the exact browser UA); otherwise keep HTTP_UA.
    // Referer/Cookie are forwarded so referer/cookie-gated downloads succeed.
    let ua = header_lookup(headers, "user-agent").unwrap_or(HTTP_UA);
    let referer = header_lookup(headers, "referer");
    let cookie = header_lookup(headers, "cookie");

    // Resume from any partial via Range.
    let mut offset = len_of(&part);
    let range = if offset > 0 { Some(format!("bytes={offset}-")) } else { None };
    let mut resp = http_follow(&client, url, ua, referer, cookie, range.as_deref())?;
    let status = resp.status();
    // Server ignored our Range (sent 200 not 206) → start over.
    if offset > 0 && status.as_u16() == 200 {
        offset = 0;
        let _ = std::fs::remove_file(&part);
    }
    if !status.is_success() {
        let b = resp.text().unwrap_or_default();
        return Err(format!("download {status}: {}", b.chars().take(200).collect::<String>()));
    }
    // No content-type guard: download whatever the server returns (like wget/curl).
    // The extension's interception hands us the real file URL; a guard here just
    // blocked legit downloads that momentarily looked like HTML.

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .truncate(false)
        .open(&part)
        .map_err(|e| e.to_string())?;
    if offset == 0 {
        let _ = file.set_len(0);
    }
    h.transferred.store(offset as i64, Ordering::SeqCst);

    let mut buf = vec![0u8; 256 * 1024];
    loop {
        if h.cancelled.load(Ordering::SeqCst) {
            return Err("paused".into());
        }
        let n = resp.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        throttle(n as u64);
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        h.transferred.fetch_add(n as i64, Ordering::SeqCst);
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(&part, dest).map_err(|e| e.to_string())
}

// ---- yt-dlp (social / video URL) -------------------------------------------

/// Resolve the absolute path of a bundled sidecar binary by name (e.g. "yt-dlp",
/// "ffmpeg"), reusing Tauri's sidecar resolution so it works in both `tauri dev`
/// and the packaged app. Mirrors the approach in `hls::setup`.
fn sidecar_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    use tauri_plugin_shell::ShellExt;
    let cmd = app
        .shell()
        .sidecar(name)
        .map_err(|e| format!("resolve {name} sidecar: {e}"))?;
    let std_cmd: std::process::Command = cmd.into();
    Ok(PathBuf::from(std_cmd.get_program()))
}

/// Build the yt-dlp argument vector for downloading `url` into `dest_dir`.
///
/// `--no-playlist` keeps a playlist URL to the single clicked video; `--newline`
/// makes progress one line each so we can parse percentages; `--no-part` writes
/// straight to the final file; `--ffmpeg-location` points at the bundled ffmpeg so
/// merging/remuxing never needs a system install. The output template caps the
/// title to 200 chars so long titles can't blow the filesystem name limit.
///
/// The `-f` selection + `--merge-output-format`/`--remux-video` force a PLAYABLE
/// mp4: prefer an H.264 (avc1) mp4 video stream + m4a audio, falling back to any
/// mp4 video+audio, then a progressive mp4, then best — and remux into an mp4
/// container so QuickTime/the in-app player can always play it. When a `referrer`
/// is known it's passed as a `Referer` request header so referer-gated media
/// (embeds, some CDNs) resolves.
fn ytdlp_args(url: &str, dest_dir: &Path, ffmpeg_dir: &Path, referrer: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "--no-playlist".into(),
        "--newline".into(),
        "--no-part".into(),
        "-f".into(),
        "bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/bv*[ext=mp4]+ba/b[ext=mp4]/b".into(),
        "--merge-output-format".into(),
        "mp4".into(),
        "--remux-video".into(),
        "mp4".into(),
        "--ffmpeg-location".into(),
        ffmpeg_dir.to_string_lossy().into_owned(),
        "-o".into(),
        format!("{}/%(title).200s.%(ext)s", dest_dir.to_string_lossy()),
    ];
    if let Some(ref_url) = referrer {
        if !ref_url.is_empty() {
            args.push("--add-header".into());
            args.push(format!("Referer: {ref_url}"));
        }
    }
    args.push(url.to_string());
    args
}

/// Parse a yt-dlp `--newline` progress line into a fractional progress in [0,1].
///
/// yt-dlp prints lines like `[download]  42.5% of  10.00MiB at  1.20MiB/s ETA ...`.
/// We only extract the percentage; bytes are derived by the caller against a
/// best-effort total. Returns `None` for any line that is not a download-percent
/// line (titles, merger output, warnings, …).
fn parse_ytdlp_percent(line: &str) -> Option<f64> {
    let rest = line.trim_start().strip_prefix("[download]")?.trim_start();
    let pct = rest.split('%').next()?.trim();
    let v: f64 = pct.parse().ok()?;
    if (0.0..=100.0).contains(&v) {
        Some(v / 100.0)
    } else {
        None
    }
}

/// Build a Command that does not flash a console window on Windows (the raw
/// std::process::Command drops the flag Tauri's own Command would set).
fn no_window_command<P: AsRef<std::ffi::OsStr>>(program: P) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Download a social/video URL with the bundled yt-dlp sidecar into `dest_dir`.
///
/// Spawns yt-dlp synchronously, streaming `--newline` stdout to approximate
/// progress against the job's best-effort total (`h` carries no real size for a
/// URL, so percent drives an estimated byte figure). On `h.cancelled` the child is
/// killed. Success is exit code 0.
fn download_ytdlp(app: &AppHandle, url: &str, dest_dir: &Path, referrer: Option<&str>, h: &NativeHandles) -> Result<(), String> {
    std::fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    let ytdlp = sidecar_path(app, "yt-dlp")?;
    let ffmpeg = sidecar_path(app, "ffmpeg")?;
    // yt-dlp wants the *directory* containing ffmpeg, not the binary path.
    let ffmpeg_dir = ffmpeg.parent().map(Path::to_path_buf).unwrap_or(ffmpeg.clone());

    let args = ytdlp_args(url, dest_dir, &ffmpeg_dir, referrer);
    let mut child = no_window_command(&ytdlp)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn yt-dlp: {e}"))?;

    // Best-effort total so the progress bar moves: a video URL has no known size,
    // so we map percent onto a nominal 100 MiB scale purely for the UI. The total
    // is corrected by the frontend when the file lands, but progress reads smoothly.
    const NOMINAL_TOTAL: f64 = 100.0 * 1024.0 * 1024.0;

    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if h.cancelled.load(Ordering::SeqCst) {
                let _ = child.kill();
                let _ = child.wait();
                return Err("paused".into());
            }
            if let Some(frac) = parse_ytdlp_percent(&line) {
                h.transferred.store((frac * NOMINAL_TOTAL) as i64, Ordering::SeqCst);
            }
        }
    }

    // Drain stderr for a useful error message before reaping.
    let mut stderr_buf = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let _ = stderr.read_to_string(&mut stderr_buf);
    }

    let status = child.wait().map_err(|e| format!("yt-dlp wait: {e}"))?;
    if h.cancelled.load(Ordering::SeqCst) {
        return Err("paused".into());
    }
    if status.success() {
        h.transferred.store(NOMINAL_TOTAL as i64, Ordering::SeqCst);
        Ok(())
    } else {
        let tail: String = stderr_buf.lines().rev().take(3).collect::<Vec<_>>().join(" ");
        let tail = tail.chars().take(300).collect::<String>();
        Err(format!("yt-dlp failed ({status}): {tail}"))
    }
}

/// Worker body for one queued item (a file or a whole folder).
pub fn download_item(app: AppHandle, conn: RcConnection, account_id: String, item: DownloadItem, dest: String, connections: usize, h: NativeHandles) {
    let connections = if connections == 0 { DEFAULT_CONNECTIONS } else { connections };
    let result = (|| -> Result<(), String> {
        // yt-dlp downloads run the sidecar (it resolves the real media + filename
        // itself), so they short-circuit before the cloud auth/engine setup. The
        // URL is carried in the item's `id`; yt-dlp writes into the dest folder.
        if provider::kind_of(&account_id) == Kind::Ytdlp {
            if item.is_dir {
                return Err("folders not supported for media URL downloads".into());
            }
            let referrer = header_lookup(&item.headers, "referer");
            return download_ytdlp(&app, &item.id, Path::new(&dest), referrer, &h);
        }

        let auth = Arc::new(Auth::new(&app, conn.clone(), &account_id)?);
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            // Per-request (one 8 MiB block) deadline so a stalled socket errors and
            // retries instead of hanging the whole download forever.
            .timeout(BLOCK_REQUEST_TIMEOUT)
            .build()
            .map_err(|e| e.to_string())?;
        let dest_root = Path::new(&dest);

        let tasks = if item.is_dir {
            // A URL download is always a single file; reject folder selections so
            // an http item never reaches enumerate_folder (which needs rclone).
            if provider::kind_of(&account_id) == Kind::Http {
                return Err("folders not supported for URL downloads".into());
            }
            enumerate_folder(&app, &conn, &account_id, &item, dest_root)?
        } else {
            vec![FileTask { fid: item.id.clone(), path: item.path.clone(), size: item.size, dest: dest_root.join(&item.name) }]
        };

        // Seed progress with whatever is already on disk (resume).
        let already: i64 = tasks.iter().map(done_bytes).sum();
        h.transferred.store(already, Ordering::SeqCst);

        for t in &tasks {
            if h.cancelled.load(Ordering::SeqCst) {
                return Err("paused".into());
            }
            // Generic web URLs stream (unknown size / no Range); cloud files use the
            // multi-connection block engine. The URL is carried in the item's `fid`.
            if auth.kind == Kind::Http {
                download_http(&t.fid, &t.dest, &item.headers, &h)?;
            } else {
                download_file(&auth, &client, t, &h, connections)?;
            }
        }
        Ok(())
    })();

    match result {
        Ok(()) => h.success.store(true, Ordering::SeqCst),
        Err(e) => *h.error.lock().unwrap_or_else(|e| e.into_inner()) = e,
    }
    h.finished.store(true, Ordering::SeqCst);
    let _ = app.emit("download-finished", json!({ "jobId": h.job_id }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn part_and_meta_paths() {
        assert_eq!(part_path(Path::new("/d/clip.mxf")), PathBuf::from("/d/clip.mxf.fdmpart"));
        assert_eq!(meta_path(Path::new("/d/clip.mxf")), PathBuf::from("/d/clip.mxf.fdmmeta"));
    }

    #[test]
    fn bitmap_round_trips() {
        let dir = std::env::temp_dir().join(format!("fdm-meta-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("x.fdmmeta");
        let m = Meta { total: 20_000_000, block: BLOCK, done: vec![true, false, true] };
        save_meta(&p, &m).unwrap();
        let back = load_meta(&p).unwrap();
        assert_eq!(back.total, 20_000_000);
        assert_eq!(back.block, BLOCK);
        assert_eq!(back.done, vec![true, false, true]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ytdlp_args_have_flags_template_and_url() {
        let args = ytdlp_args(
            "https://x.test/watch?v=abc",
            Path::new("/downloads"),
            Path::new("/bin"),
            None,
        );
        assert!(args.contains(&"--no-playlist".to_string()));
        assert!(args.contains(&"--newline".to_string()));
        assert!(args.contains(&"--no-part".to_string()));
        assert!(args.contains(&"--ffmpeg-location".to_string()));
        assert!(args.contains(&"/bin".to_string()));

        // Forces a playable mp4: H.264 mp4 + m4a preferred, then any mp4, then best,
        // remuxed/merged into an mp4 container.
        let fi = args.iter().position(|a| a == "-f").unwrap();
        assert_eq!(
            args[fi + 1],
            "bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/bv*[ext=mp4]+ba/b[ext=mp4]/b"
        );
        let mi = args.iter().position(|a| a == "--merge-output-format").unwrap();
        assert_eq!(args[mi + 1], "mp4");
        let ri = args.iter().position(|a| a == "--remux-video").unwrap();
        assert_eq!(args[ri + 1], "mp4");

        // Output template lands under the dest dir with a length-capped title.
        assert!(args.iter().any(|a| a == "/downloads/%(title).200s.%(ext)s"));
        // The URL is the final positional argument.
        assert_eq!(args.last().unwrap(), "https://x.test/watch?v=abc");
        // -o precedes its template value.
        let oi = args.iter().position(|a| a == "-o").unwrap();
        assert_eq!(args[oi + 1], "/downloads/%(title).200s.%(ext)s");
        // No referrer → no --add-header.
        assert!(!args.contains(&"--add-header".to_string()));
    }

    #[test]
    fn ytdlp_args_add_referer_header_when_present() {
        let args = ytdlp_args(
            "https://x.test/watch?v=abc",
            Path::new("/downloads"),
            Path::new("/bin"),
            Some("https://ref.test/page"),
        );
        let hi = args.iter().position(|a| a == "--add-header").unwrap();
        assert_eq!(args[hi + 1], "Referer: https://ref.test/page");
        // The URL remains the final positional argument after the header.
        assert_eq!(args.last().unwrap(), "https://x.test/watch?v=abc");
    }

    #[test]
    fn parse_ytdlp_percent_extracts_download_lines_only() {
        assert_eq!(
            parse_ytdlp_percent("[download]  42.5% of 10.00MiB at 1.20MiB/s ETA 00:05"),
            Some(0.425)
        );
        assert_eq!(parse_ytdlp_percent("[download]   0.0% of ~12.00MiB"), Some(0.0));
        assert_eq!(parse_ytdlp_percent("[download] 100% of 5.00MiB"), Some(1.0));
        // Non-progress lines yield nothing.
        assert_eq!(parse_ytdlp_percent("[youtube] abc: Downloading webpage"), None);
        assert_eq!(parse_ytdlp_percent("[Merger] Merging formats into \"out.mp4\""), None);
        assert_eq!(parse_ytdlp_percent("[download] Destination: out.mp4"), None);
        assert_eq!(parse_ytdlp_percent(""), None);
    }

    #[test]
    fn throttle_unlimited_is_instant() {
        set_bw_limit(0);
        throttle(1_000_000); // returns immediately, no panic
    }
}
