//! Just-in-time HLS transcoder for the review player (ABR streaming).
//!
//! Served under `/{secret}/hls/` by the loopback proxy in `stream.rs`:
//!   - `master.m3u8`            → one `#EXT-X-STREAM-INF` per offered rendition,
//!   - `media-<h>.m3u8`         → VOD media playlist (segment list from probed duration),
//!   - `seg-<h>-<n>.ts`         → ffmpeg JIT-transcodes ONLY that ~6s window.
//!
//! The ffmpeg INPUT is either the loopback `/media?...` URL (cloud — ffmpeg pulls
//! bytes through the existing authenticated proxy) or a local file path. Each
//! segment is a self-contained, keyframe-initial GOP so scrubbing transcodes just
//! that window with no full-file pass.
//!
//! Renditions offered = {1080, 720, 480} filtered to height ≤ source height (never
//! upscale), always at least the smallest. Source height + duration come from
//! `ffprobe`, probed once per source and cached in memory.
//!
//! The module is split into PURE seams (unit-tested, no ffmpeg) and a RUNTIME that
//! spawns the ffmpeg/ffprobe sidecars synchronously (the stream server runs on
//! plain threads, not async).

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};

/// Segment length in seconds. Each `.ts` covers one of these windows.
pub const SEG_DUR: f64 = 6.0;

/// Default cap on concurrent ffmpeg processes. Used as the initial permit count
/// before the encoder is chosen; `setup` then resizes the semaphore to the
/// encoder-aware effective limit (see `concurrency_for`).
pub const MAX_CONCURRENT_FFMPEG: usize = 3;

/// How many segments ahead of the requested one to warm on background threads.
/// Prefetch covers `n+1..=n+PREFETCH`, bounded to the last segment, and only
/// runs when an ffmpeg permit is free (it never blocks a live request).
pub const PREFETCH: u64 = 4;

/// Consecutive hardware-encode failures before the session permanently downgrades
/// to libx264. A single mid-playback failure only retries that one segment on
/// software (the hardware choice is kept) — we don't pin software off one blip.
pub const HW_FAILURE_DOWNGRADE_THRESHOLD: u32 = 3;

/// LRU segment-cache size cap (~2 GB).
pub const CACHE_CAP_BYTES: u64 = 2 * 1024 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Pure seams
// ---------------------------------------------------------------------------

/// One offered quality level. `height` drives `scale=-2:<h>`; the bitrates feed
/// the encoder and the playlist `BANDWIDTH`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Rendition {
    pub height: u32,
    /// Approximate display width for `RESOLUTION` (assumes 16:9; informational only —
    /// the real width is derived by ffmpeg from the source aspect via `scale=-2`).
    pub width: u32,
    /// Target video bitrate in kbps.
    pub v_kbps: u32,
    /// Target audio bitrate in kbps.
    pub a_kbps: u32,
}

/// The full catalogue of renditions, largest first.
const ALL_RENDITIONS: [Rendition; 3] = [
    Rendition { height: 1080, width: 1920, v_kbps: 5000, a_kbps: 128 },
    Rendition { height: 720, width: 1280, v_kbps: 2800, a_kbps: 128 },
    Rendition { height: 480, width: 854, v_kbps: 1400, a_kbps: 96 },
];

/// Renditions to offer for a source of the given height: keep those with
/// `height <= source_height` (never upscale), but always keep the smallest so a
/// tiny/odd source still gets at least one level. Largest first.
pub fn offered_renditions(source_height: u32) -> Vec<Rendition> {
    let mut out: Vec<Rendition> = ALL_RENDITIONS
        .iter()
        .copied()
        .filter(|r| r.height <= source_height)
        .collect();
    if out.is_empty() {
        // Source shorter than the smallest rendition — offer the smallest anyway.
        out.push(ALL_RENDITIONS[ALL_RENDITIONS.len() - 1]);
    }
    out
}

/// HLS `BANDWIDTH` attribute (bits/sec) — video + audio with a little overhead.
fn bandwidth_bps(r: &Rendition) -> u32 {
    // kbps → bps, plus ~10% container/overhead headroom.
    ((r.v_kbps + r.a_kbps) as u64 * 1000 * 11 / 10) as u32
}

/// The master playlist: one `#EXT-X-STREAM-INF` per rendition, each pointing at
/// `media-<h>.m3u8?<query>` so the source params travel with every request.
pub fn master_playlist(renditions: &[Rendition], query: &str) -> String {
    let mut s = String::from("#EXTM3U\n#EXT-X-VERSION:3\n");
    for r in renditions {
        s.push_str(&format!(
            "#EXT-X-STREAM-INF:BANDWIDTH={},RESOLUTION={}x{}\n",
            bandwidth_bps(r),
            r.width,
            r.height
        ));
        s.push_str(&format!("media-{}.m3u8?{}\n", r.height, query));
    }
    s
}

/// Number of segments for a duration at `seg_dur` (the final segment may be short).
pub fn segment_count(duration_secs: f64, seg_dur: f64) -> u64 {
    if duration_secs <= 0.0 || seg_dur <= 0.0 {
        return 0;
    }
    (duration_secs / seg_dur).ceil() as u64
}

/// A VOD media playlist for one rendition: `#EXT-X-PLAYLIST-TYPE:VOD`, an `EXTINF`
/// per segment (the final one carries the remainder), `seg-<h>-<n>.ts?<query>`
/// URIs, and `#EXT-X-ENDLIST`.
pub fn media_playlist(duration_secs: f64, seg_dur: f64, rend: &Rendition, query: &str) -> String {
    let count = segment_count(duration_secs, seg_dur);
    let target = seg_dur.ceil() as u64;
    let mut s = String::from("#EXTM3U\n#EXT-X-VERSION:3\n");
    s.push_str(&format!("#EXT-X-TARGETDURATION:{target}\n"));
    s.push_str("#EXT-X-MEDIA-SEQUENCE:0\n");
    s.push_str("#EXT-X-PLAYLIST-TYPE:VOD\n");
    for n in 0..count {
        let (_start, dur) = segment_window(n, seg_dur, duration_secs);
        s.push_str(&format!("#EXTINF:{:.6},\n", dur));
        s.push_str(&format!("seg-{}-{}.ts?{}\n", rend.height, n, query));
    }
    s.push_str("#EXT-X-ENDLIST\n");
    s
}

/// The `[start, dur)` window for segment `n`. The last segment is clamped to the
/// remaining duration so it can be shorter than `seg_dur`.
pub fn segment_window(n: u64, seg_dur: f64, duration: f64) -> (f64, f64) {
    let start = n as f64 * seg_dur;
    if start >= duration {
        return (start, 0.0);
    }
    let dur = (duration - start).min(seg_dur);
    (start, dur)
}

/// Chosen H.264 encoder for the session.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Encoder {
    Libx264,
    VideoToolbox,
    Nvenc,
    Qsv,
    Amf,
}

impl Encoder {
    /// The ffmpeg `-c:v` encoder name.
    pub fn ffmpeg_name(&self) -> &'static str {
        match self {
            Encoder::Libx264 => "libx264",
            Encoder::VideoToolbox => "h264_videotoolbox",
            Encoder::Nvenc => "h264_nvenc",
            Encoder::Qsv => "h264_qsv",
            Encoder::Amf => "h264_amf",
        }
    }

    /// Whether this is a hardware encoder (so a failure can fall back to libx264).
    pub fn is_hardware(&self) -> bool {
        !matches!(self, Encoder::Libx264)
    }
}

/// Effective concurrent-ffmpeg limit for the chosen encoder. Hardware encoders
/// (videotoolbox/nvenc/qsv/amf) offload to a dedicated ASIC, so several can run
/// at once (4) without pegging the CPU; software (libx264) saturates CPU cores,
/// so we cap it low (2) — and pair it with a per-process `-threads` cap (see
/// `ffmpeg_args`) so one software transcode can't freeze the whole app.
pub fn concurrency_for(encoder: Encoder) -> usize {
    if encoder.is_hardware() {
        4
    } else {
        2
    }
}

/// Per-process libx264 thread cap: about half the logical cores, min 2. Capping
/// software-encode threads stops a single transcode from pegging every core and
/// freezing the whole app. `logical_cores` is the machine's logical CPU count.
pub fn libx264_threads(logical_cores: usize) -> usize {
    (logical_cores / 2).max(2)
}

/// Logical CPU count for sizing the libx264 `-threads` cap, defaulting to 2 if
/// the platform can't report it.
fn logical_cores() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2)
}

/// Pick the best available H.264 encoder for `os` from ffmpeg's encoder list.
/// macOS: `h264_videotoolbox` else `libx264`. Windows: nvenc > qsv > amf > libx264.
/// Anything else (Linux/dev): libx264. `available` holds encoder names as printed
/// by `ffmpeg -encoders` (e.g. "h264_videotoolbox", "h264_nvenc", "libx264").
pub fn pick_encoder(available: &[String], os: &str) -> Encoder {
    let has = |name: &str| available.iter().any(|a| a == name);
    match os {
        "macos" => {
            if has("h264_videotoolbox") {
                Encoder::VideoToolbox
            } else {
                Encoder::Libx264
            }
        }
        "windows" => {
            if has("h264_nvenc") {
                Encoder::Nvenc
            } else if has("h264_qsv") {
                Encoder::Qsv
            } else if has("h264_amf") {
                Encoder::Amf
            } else {
                Encoder::Libx264
            }
        }
        _ => Encoder::Libx264,
    }
}

/// Build the ffmpeg argument vector that JIT-transcodes ONE segment to mpegts on
/// stdout (`pipe:1`):
///   - input seek (`-ss <start>` BEFORE `-i` for a fast keyframe seek) + `-t <dur>`,
///   - `scale=-2:<h>` (aspect-preserving, even width), chosen H.264 encoder + AAC,
///   - a forced IDR at the segment start (`-force_key_frames 0`) so the `.ts` is
///     independently decodable,
///   - `-output_ts_offset <start>` so segment timing aligns with the playlist,
///   - `-f mpegts pipe:1`.
pub fn ffmpeg_args(input: &str, start: f64, dur: f64, rend: &Rendition, encoder: Encoder) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-nostdin".into(),
    ];

    // Hardware-accelerated decode where it pairs with the encoder.
    if matches!(encoder, Encoder::VideoToolbox) {
        a.push("-hwaccel".into());
        a.push("videotoolbox".into());
    }

    // Fast input seek to the segment start, before -i.
    a.push("-ss".into());
    a.push(format!("{start:.6}"));
    a.push("-i".into());
    a.push(input.to_string());
    // Encode exactly this window.
    a.push("-t".into());
    a.push(format!("{dur:.6}"));

    // Video: scale (even width via -2), encoder, target bitrate.
    a.push("-vf".into());
    a.push(format!("scale=-2:{}", rend.height));
    a.push("-c:v".into());
    a.push(encoder.ffmpeg_name().into());
    if matches!(encoder, Encoder::Libx264) {
        a.push("-preset".into());
        a.push("veryfast".into());
        // Cap software-encode threads (~half the logical cores, min 2) so a single
        // libx264 transcode can't peg every core and freeze the whole app.
        a.push("-threads".into());
        a.push(libx264_threads(logical_cores()).to_string());
    }
    a.push("-b:v".into());
    a.push(format!("{}k", rend.v_kbps));
    a.push("-maxrate".into());
    a.push(format!("{}k", rend.v_kbps));
    a.push("-bufsize".into());
    a.push(format!("{}k", rend.v_kbps * 2));
    a.push("-pix_fmt".into());
    a.push("yuv420p".into());

    // Force an IDR at the segment start so the .ts is self-contained.
    a.push("-force_key_frames".into());
    a.push("expr:gte(t,0)".into());

    // Audio.
    a.push("-c:a".into());
    a.push("aac".into());
    a.push("-b:a".into());
    a.push(format!("{}k", rend.a_kbps));
    a.push("-ac".into());
    a.push("2".into());

    // Keep playlist timing aligned with absolute time.
    a.push("-output_ts_offset".into());
    a.push(format!("{start:.6}"));
    a.push("-muxdelay".into());
    a.push("0".into());

    // Output mpegts to stdout.
    a.push("-f".into());
    a.push("mpegts".into());
    a.push("pipe:1".into());
    a
}

/// Build the ffprobe argument vector that prints the source duration + height as
/// JSON (read by `parse_probe`).
pub fn ffprobe_args(input: &str) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-print_format".into(),
        "json".into(),
        "-show_entries".into(),
        "format=duration:stream=height,codec_type".into(),
        "-i".into(),
        input.to_string(),
    ]
}

/// Source probe result: total duration (s) + max video stream height (px).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Probe {
    pub duration: f64,
    pub height: u32,
}

/// Parse ffprobe JSON (as produced by `ffprobe_args`) into a `Probe`. Picks the
/// tallest video stream's height and the format duration.
pub fn parse_probe(json: &str) -> Result<Probe, String> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let duration = v
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(|d| d.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|d| *d > 0.0)
        .ok_or_else(|| "ffprobe: missing/zero duration".to_string())?;
    let height = v
        .get("streams")
        .and_then(|s| s.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|st| st.get("codec_type").and_then(|c| c.as_str()) == Some("video"))
                .filter_map(|st| st.get("height").and_then(|h| h.as_u64()))
                .max()
                .unwrap_or(0) as u32
        })
        .unwrap_or(0);
    if height == 0 {
        return Err("ffprobe: no video stream height".into());
    }
    Ok(Probe { duration, height })
}

// ---------------------------------------------------------------------------
// Source key + request parsing
// ---------------------------------------------------------------------------

/// Where ffmpeg reads bytes from for a given request.
#[derive(Clone, Debug)]
pub enum SourceInput {
    /// Cloud: ffmpeg pulls through the loopback `/media?...` proxy URL.
    Url(String),
    /// Local: a filesystem path used directly as `-i`.
    Local(String),
}

impl SourceInput {
    fn as_ffmpeg_input(&self) -> &str {
        match self {
            SourceInput::Url(u) => u,
            SourceInput::Local(p) => p,
        }
    }
}

/// A parsed HLS source: the stable cache key + the ffmpeg input + the raw query
/// string to echo back into child-playlist/segment URIs.
#[derive(Clone, Debug)]
pub struct HlsSource {
    pub key: String,
    pub input: SourceInput,
    pub query: String,
}

/// Build the loopback `/media?...` URL for a cloud source from the same params the
/// HLS request carried (acct/fid/path/size/ext). `base` is `http://127.0.0.1:PORT/SECRET`.
fn media_url(base: &str, params: &HashMap<String, String>) -> String {
    // Reconstruct the exact /media query the legacy player uses.
    let mut q = String::new();
    for k in ["acct", "fid", "path", "size", "ext"] {
        if let Some(v) = params.get(k) {
            if !q.is_empty() {
                q.push('&');
            }
            q.push_str(k);
            q.push('=');
            q.push_str(v);
        }
    }
    format!("{base}/media?{q}")
}

/// Parse the query string of an HLS request into an `HlsSource`. Accepts either a
/// cloud source (`acct`+`path`+`size`, ffmpeg reads via the `/media` proxy) or a
/// local source (`local=<base64url abspath>`, ffmpeg reads the file directly).
/// `media_base` is the loopback base used to build the cloud `/media` input URL.
pub fn parse_source(query: &str, params: &HashMap<String, String>, media_base: &str) -> Result<HlsSource, String> {
    if let Some(local_b64) = params.get("local") {
        let path = String::from_utf8(
            URL_SAFE_NO_PAD
                .decode(local_b64)
                .map_err(|e| format!("local b64: {e}"))?,
        )
        .map_err(|e| format!("local utf8: {e}"))?;
        return Ok(HlsSource {
            key: format!("local|{path}"),
            input: SourceInput::Local(path),
            query: query.to_string(),
        });
    }
    let acct = params.get("acct").ok_or_else(|| "missing acct/local".to_string())?;
    let path_b64 = params.get("path").ok_or_else(|| "missing path".to_string())?;
    let path = String::from_utf8(
        URL_SAFE_NO_PAD
            .decode(path_b64)
            .map_err(|e| format!("path b64: {e}"))?,
    )
    .map_err(|e| format!("path utf8: {e}"))?;
    Ok(HlsSource {
        key: format!("cloud|{acct}|{path}"),
        input: SourceInput::Url(media_url(media_base, params)),
        query: query.to_string(),
    })
}

/// A parsed `/hls/...` route.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum HlsRoute {
    Master,
    Media { height: u32 },
    Segment { height: u32, n: u64 },
}

/// Parse the path component after `/{secret}/hls/` (no query) into a route.
pub fn parse_route(path: &str) -> Option<HlsRoute> {
    if path == "master.m3u8" {
        return Some(HlsRoute::Master);
    }
    if let Some(rest) = path.strip_prefix("media-").and_then(|p| p.strip_suffix(".m3u8")) {
        return rest.parse::<u32>().ok().map(|height| HlsRoute::Media { height });
    }
    if let Some(rest) = path.strip_prefix("seg-").and_then(|p| p.strip_suffix(".ts")) {
        let (h, n) = rest.split_once('-')?;
        let height = h.parse::<u32>().ok()?;
        let n = n.parse::<u64>().ok()?;
        return Some(HlsRoute::Segment { height, n });
    }
    None
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

/// A counting semaphore (std-only) so the stream server's plain threads can cap
/// concurrent ffmpeg processes without pulling in async.
struct Semaphore {
    inner: Mutex<usize>,
    cv: Condvar,
}

impl Semaphore {
    fn new(permits: usize) -> Self {
        Semaphore { inner: Mutex::new(permits), cv: Condvar::new() }
    }

    /// Block until a permit is free, then take it. Used by on-demand (live,
    /// player-requested) segments, which must always eventually get a permit.
    fn acquire(self: &Arc<Self>) -> SemaphoreGuard {
        let mut n = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        while *n == 0 {
            n = self.cv.wait(n).unwrap_or_else(|e| e.into_inner());
        }
        *n -= 1;
        SemaphoreGuard { sem: Arc::clone(self) }
    }

    /// Take a permit only if one is immediately free, else return `None`. Used by
    /// prefetch so background warming never waits behind — or starves — a live
    /// request: when every permit is busy serving on-demand segments, prefetch
    /// simply backs off.
    fn try_acquire(self: &Arc<Self>) -> Option<SemaphoreGuard> {
        let mut n = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if *n == 0 {
            return None;
        }
        *n -= 1;
        Some(SemaphoreGuard { sem: Arc::clone(self) })
    }

    /// Resize the permit pool. Only safe at setup, before any transcode is in
    /// flight (all permits free), so we just overwrite the available count.
    fn set_permits(&self, permits: usize) {
        *self.inner.lock().unwrap_or_else(|e| e.into_inner()) = permits;
    }
}

struct SemaphoreGuard {
    sem: Arc<Semaphore>,
}

impl Drop for SemaphoreGuard {
    fn drop(&mut self) {
        let mut n = self.sem.inner.lock().unwrap_or_else(|e| e.into_inner());
        *n += 1;
        self.sem.cv.notify_one();
    }
}

/// LRU disk cache of produced `.ts` segments, capped by total bytes.
#[derive(Default)]
struct SegmentCache {
    /// cache-key → (file path, size). Insertion order tracked separately for LRU.
    entries: HashMap<String, (PathBuf, u64)>,
    /// LRU order, oldest first.
    order: Vec<String>,
    total: u64,
}

impl SegmentCache {
    fn touch(&mut self, key: &str) {
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            let k = self.order.remove(pos);
            self.order.push(k);
        }
    }

    fn get(&mut self, key: &str) -> Option<PathBuf> {
        let path = self.entries.get(key).map(|(p, _)| p.clone());
        if path.is_some() {
            self.touch(key);
        }
        path
    }

    fn insert(&mut self, key: String, path: PathBuf, size: u64, cap: u64) {
        if let Some((_, old)) = self.entries.insert(key.clone(), (path, size)) {
            self.total = self.total.saturating_sub(old);
            if let Some(pos) = self.order.iter().position(|k| *k == key) {
                self.order.remove(pos);
            }
        }
        self.total += size;
        self.order.push(key);
        // Evict oldest until under cap.
        while self.total > cap && !self.order.is_empty() {
            let oldest = self.order.remove(0);
            if let Some((p, sz)) = self.entries.remove(&oldest) {
                self.total = self.total.saturating_sub(sz);
                let _ = std::fs::remove_file(&p);
            }
        }
    }
}

/// The shared HLS runtime: sidecar paths, probe + segment caches, encoder choice,
/// and the ffmpeg-process semaphore. Held behind an `Arc` so prefetch threads
/// share the *same* caches/semaphore (not copies).
pub struct HlsRuntime {
    /// Absolute path to the ffmpeg sidecar (resolved at setup for sync spawning).
    pub ffmpeg_path: Mutex<Option<PathBuf>>,
    /// Absolute path to the ffprobe sidecar.
    pub ffprobe_path: Mutex<Option<PathBuf>>,
    /// Temp dir for cached `.ts` (cleared on exit).
    pub cache_dir: Mutex<Option<PathBuf>>,
    /// Source-key → probe result.
    probes: Mutex<HashMap<String, Probe>>,
    /// Chosen encoder; downgraded to libx264 for the session only after several
    /// consecutive hw transcode failures (a single mid-playback failure is not
    /// enough — see `record_hw_failure`).
    encoder: Mutex<Option<Encoder>>,
    /// Count of consecutive hardware-encode failures; reset on any hw success.
    consecutive_hw_failures: Mutex<u32>,
    /// Per-source single-flight: so a source is probed once even under concurrency.
    probe_lock: Mutex<()>,
    cache: Mutex<SegmentCache>,
    sem: Arc<Semaphore>,
    /// In-flight prefetch keys, to avoid spawning a duplicate prefetch.
    prefetching: Mutex<std::collections::HashSet<String>>,
}

impl Default for HlsRuntime {
    fn default() -> Self {
        HlsRuntime {
            ffmpeg_path: Mutex::new(None),
            ffprobe_path: Mutex::new(None),
            cache_dir: Mutex::new(None),
            probes: Mutex::new(HashMap::new()),
            encoder: Mutex::new(None),
            consecutive_hw_failures: Mutex::new(0),
            probe_lock: Mutex::new(()),
            cache: Mutex::new(SegmentCache::default()),
            sem: Arc::new(Semaphore::new(MAX_CONCURRENT_FFMPEG)),
            prefetching: Mutex::new(std::collections::HashSet::new()),
        }
    }
}

impl HlsRuntime {
    fn ffmpeg(&self) -> Result<PathBuf, String> {
        self.ffmpeg_path
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or_else(|| "ffmpeg sidecar not resolved".to_string())
    }

    fn ffprobe(&self) -> Result<PathBuf, String> {
        self.ffprobe_path
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or_else(|| "ffprobe sidecar not resolved".to_string())
    }

    fn current_encoder(&self) -> Encoder {
        self.encoder
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .unwrap_or(Encoder::Libx264)
    }

    /// Record a hardware-encode failure. Bumps the consecutive-failure counter and,
    /// only once it reaches `HW_FAILURE_DOWNGRADE_THRESHOLD`, permanently pins the
    /// session to libx264. Returns `true` if this call triggered the downgrade.
    fn record_hw_failure(&self) -> bool {
        let mut fails = self.consecutive_hw_failures.lock().unwrap_or_else(|e| e.into_inner());
        *fails += 1;
        if *fails >= HW_FAILURE_DOWNGRADE_THRESHOLD {
            *self.encoder.lock().unwrap_or_else(|e| e.into_inner()) = Some(Encoder::Libx264);
            true
        } else {
            false
        }
    }

    /// Reset the consecutive hardware-failure counter after a hw-encode success.
    fn record_hw_success(&self) {
        *self.consecutive_hw_failures.lock().unwrap_or_else(|e| e.into_inner()) = 0;
    }

    fn cache_get(&self, key: &str) -> Option<PathBuf> {
        self.cache.lock().unwrap_or_else(|e| e.into_inner()).get(key)
    }

    fn cache_put(&self, key: String, path: PathBuf, size: u64) {
        self.cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, path, size, CACHE_CAP_BYTES);
    }
}

/// Tauri managed-state wrapper around the shared `HlsRuntime`.
#[derive(Default)]
pub struct HlsState {
    pub rt: Arc<HlsRuntime>,
}

/// Resolve the absolute ffmpeg + ffprobe sidecar paths (reusing Tauri's sidecar
/// resolution, which works in both `tauri dev` and the bundled app) and create the
/// HLS cache dir. Best-effort: failures just leave HLS unavailable so the player
/// falls back to direct `/media`.
pub fn setup(app: &tauri::AppHandle) {
    use tauri::Manager;
    use tauri_plugin_shell::ShellExt;

    let rt = app.state::<HlsState>().rt.clone();

    // Resolve sidecar absolute paths via Tauri, then keep them for std::process spawns.
    for (name, slot) in [("ffmpeg", &rt.ffmpeg_path), ("ffprobe", &rt.ffprobe_path)] {
        match app.shell().sidecar(name) {
            Ok(cmd) => {
                let std_cmd: std::process::Command = cmd.into();
                let path = PathBuf::from(std_cmd.get_program());
                *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(path);
            }
            Err(e) => eprintln!("hls: resolve {name} sidecar failed: {e}"),
        }
    }

    // Cache dir under the app cache dir; clear any stale contents from a prior run.
    if let Ok(base) = app.path().app_cache_dir() {
        let dir = base.join("hls");
        let _ = std::fs::remove_dir_all(&dir);
        if std::fs::create_dir_all(&dir).is_ok() {
            *rt.cache_dir.lock().unwrap_or_else(|e| e.into_inner()) = Some(dir);
        }
    }

    // Probe the ffmpeg encoder list once and pick the best for this OS, then VERIFY
    // a hardware pick actually encodes a frame (some machines advertise an encoder
    // that fails at runtime) — falling back to libx264 if it doesn't.
    let encoder = match rt.ffmpeg() {
        Ok(ffmpeg) => {
            let available = list_encoders(&ffmpeg);
            let picked = pick_encoder(&available, std::env::consts::OS);
            if picked.is_hardware() && !verify_encoder(&ffmpeg, picked) {
                eprintln!(
                    "hls: {} advertised but failed a one-frame test encode — falling back to libx264",
                    picked.ffmpeg_name()
                );
                Encoder::Libx264
            } else {
                picked
            }
        }
        Err(_) => Encoder::Libx264,
    };
    eprintln!("hls: selected encoder {}", encoder.ffmpeg_name());
    *rt.encoder.lock().unwrap_or_else(|e| e.into_inner()) = Some(encoder);

    // Size the ffmpeg-concurrency semaphore to the chosen encoder: hardware can run
    // several at once, software is capped low so it can't saturate the CPU.
    rt.sem.set_permits(concurrency_for(encoder));
}

/// Verify an encoder actually works by encoding a single synthetic frame to null.
/// Returns true on success. Catches machines that advertise a hardware encoder in
/// `-encoders` but fail to initialize it at runtime.
fn verify_encoder(ffmpeg: &std::path::Path, encoder: Encoder) -> bool {
    std::process::Command::new(ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x240:rate=1",
            "-frames:v",
            "1",
            "-c:v",
            encoder.ffmpeg_name(),
            "-f",
            "null",
            "-",
        ])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Best-effort cleanup of the HLS cache dir on app exit.
pub fn cleanup(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(dir) = app
        .state::<HlsState>()
        .rt
        .cache_dir
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
    {
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Run `ffmpeg -encoders` and collect the H.264 encoder names present.
fn list_encoders(ffmpeg: &std::path::Path) -> Vec<String> {
    let out = match std::process::Command::new(ffmpeg)
        .args(["-hide_banner", "-encoders"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut names = Vec::new();
    for cand in ["h264_videotoolbox", "h264_nvenc", "h264_qsv", "h264_amf", "libx264"] {
        if text.contains(cand) {
            names.push(cand.to_string());
        }
    }
    names
}

/// Probe a source once (single-flight by source key), caching duration + height.
fn probe_source(state: &HlsRuntime, src: &HlsSource) -> Result<Probe, String> {
    if let Some(p) = state.probes.lock().unwrap_or_else(|e| e.into_inner()).get(&src.key) {
        return Ok(*p);
    }
    // Serialize probes so a source is only probed once even under concurrency.
    let _guard = state.probe_lock.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(p) = state.probes.lock().unwrap_or_else(|e| e.into_inner()).get(&src.key) {
        return Ok(*p);
    }
    let ffprobe = state.ffprobe()?;
    let args = ffprobe_args(src.input.as_ffmpeg_input());
    let out = std::process::Command::new(&ffprobe)
        .args(&args)
        .output()
        .map_err(|e| format!("ffprobe spawn: {e}"))?;
    if !out.status.success() {
        return Err(format!("ffprobe failed: {}", String::from_utf8_lossy(&out.stderr)));
    }
    let probe = parse_probe(&String::from_utf8_lossy(&out.stdout))?;
    state
        .probes
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(src.key.clone(), probe);
    Ok(probe)
}

/// Resolve a rendition by height for a given source (so an out-of-range height in
/// the URL still maps to an offered level).
fn rendition_for(probe: &Probe, height: u32) -> Rendition {
    let offered = offered_renditions(probe.height);
    offered
        .iter()
        .find(|r| r.height == height)
        .copied()
        .unwrap_or_else(|| *offered.last().expect("at least one rendition"))
}

/// Produce (or read from cache) the transcoded `.ts` bytes for segment `n` of a
/// rendition. Spawns ffmpeg synchronously to stdout.
///
/// `prefetch` distinguishes background warming from live (player-requested)
/// segments: a live request *blocks* for an ffmpeg permit (it must always be
/// served), while a prefetch only `try_acquire`s — if every permit is busy
/// serving on-demand segments it backs off (returns `Err`) rather than starve
/// them.
///
/// On a hardware-encoder failure, the failed segment is retried once with
/// libx264 (so playback continues), but the hardware choice is *kept*; only after
/// `HW_FAILURE_DOWNGRADE_THRESHOLD` consecutive hw failures does the session
/// permanently downgrade to software. A hw success resets that counter.
fn produce_segment(
    state: &HlsRuntime,
    src: &HlsSource,
    rend: &Rendition,
    n: u64,
    probe: &Probe,
    prefetch: bool,
) -> Result<Vec<u8>, String> {
    let cache_key = format!("{}|{}|{}", src.key, rend.height, n);
    if let Some(path) = state.cache_get(&cache_key) {
        if let Ok(bytes) = std::fs::read(&path) {
            return Ok(bytes);
        }
    }

    let (start, dur) = segment_window(n, SEG_DUR, probe.duration);
    if dur <= 0.0 {
        return Err("segment out of range".into());
    }

    // Live requests block for a permit; prefetch yields when none is free so it
    // never queues ahead of — or starves — an on-demand segment.
    let _permit = if prefetch {
        match state.sem.try_acquire() {
            Some(p) => p,
            None => return Err("prefetch skipped: no free ffmpeg permit".into()),
        }
    } else {
        state.sem.acquire()
    };
    let ffmpeg = state.ffmpeg()?;
    let input = src.input.as_ffmpeg_input().to_string();

    let encoder = state.current_encoder();
    let bytes = match run_ffmpeg(&ffmpeg, &input, start, dur, rend, encoder) {
        Ok(b) => {
            if encoder.is_hardware() {
                state.record_hw_success();
            }
            b
        }
        Err(e) if encoder.is_hardware() => {
            // Hardware path failed — retry THIS segment on software so playback
            // continues, but keep the hardware choice. Only after several
            // consecutive hw failures do we pin software for the session.
            let downgraded = state.record_hw_failure();
            if downgraded {
                eprintln!(
                    "hls: {} failed ({e}); {} consecutive failures — downgrading session to libx264",
                    encoder.ffmpeg_name(),
                    HW_FAILURE_DOWNGRADE_THRESHOLD
                );
            } else {
                eprintln!("hls: {} failed ({e}); retrying this segment with libx264", encoder.ffmpeg_name());
            }
            run_ffmpeg(&ffmpeg, &input, start, dur, rend, Encoder::Libx264)?
        }
        Err(e) => return Err(e),
    };

    // Best-effort cache write.
    if let Some(dir) = state.cache_dir.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        let safe = src.key.bytes().map(|b| if b.is_ascii_alphanumeric() { b as char } else { '_' }).collect::<String>();
        let fname = format!("{safe}-{}-{}.ts", rend.height, n);
        let path = dir.join(fname);
        if std::fs::write(&path, &bytes).is_ok() {
            state.cache_put(cache_key, path, bytes.len() as u64);
        }
    }
    Ok(bytes)
}

/// Spawn ffmpeg to transcode one segment, capturing stdout (the mpegts bytes).
fn run_ffmpeg(
    ffmpeg: &std::path::Path,
    input: &str,
    start: f64,
    dur: f64,
    rend: &Rendition,
    encoder: Encoder,
) -> Result<Vec<u8>, String> {
    let args = ffmpeg_args(input, start, dur, rend, encoder);
    let out = std::process::Command::new(ffmpeg)
        .args(&args)
        .output()
        .map_err(|e| format!("ffmpeg spawn: {e}"))?;
    if !out.status.success() {
        return Err(format!("ffmpeg exit {}: {}", out.status, String::from_utf8_lossy(&out.stderr)));
    }
    if out.stdout.is_empty() {
        return Err("ffmpeg produced no output".into());
    }
    Ok(out.stdout)
}

/// The inclusive prefetch window `[n+1, last]` for a request at segment `n`: warm
/// up to `PREFETCH` segments ahead, bounded to the final segment index so we never
/// prefetch past the end. Returns an empty range when `n` is the last segment.
pub fn prefetch_window(n: u64, seg_dur: f64, duration: f64) -> std::ops::RangeInclusive<u64> {
    let count = segment_count(duration, seg_dur);
    let first = n + 1;
    // No segments, or `n` is already at/after the last → empty window. Use a
    // start-after-end inclusive range (first..=first-1) so the result `.is_empty()`.
    if count == 0 || first >= count {
        return first..=first.saturating_sub(1);
    }
    let last = count - 1;
    let upper = (n + PREFETCH).min(last);
    first..=upper
}

/// Best-effort prefetch of the WINDOW `n+1..=n+PREFETCH` (bounded to the last
/// segment) on background threads. Each candidate is deduped against the cache and
/// any in-flight transcode, and runs with `prefetch=true` so it only proceeds when
/// an ffmpeg permit is free — never queuing ahead of a live request.
fn prefetch_window_segments(
    state: Arc<HlsRuntime>,
    src: HlsSource,
    rend: Rendition,
    n: u64,
    probe: Probe,
) {
    for next in prefetch_window(n, SEG_DUR, probe.duration) {
        let key = format!("{}|{}|{}", src.key, rend.height, next);
        {
            let mut inflight = state.prefetching.lock().unwrap_or_else(|e| e.into_inner());
            if state.cache_get(&key).is_some() || inflight.contains(&key) {
                continue;
            }
            inflight.insert(key.clone());
        }
        let state = Arc::clone(&state);
        let src = src.clone();
        std::thread::spawn(move || {
            let _ = produce_segment(&state, &src, &rend, next, &probe, true);
            state.prefetching.lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
        });
    }
}

/// Outcome of handling an HLS request, ready for `stream.rs` to turn into a
/// `tiny_http` response.
pub enum HlsResponse {
    /// An `.m3u8` playlist (text/UTF-8).
    Playlist(String),
    /// A `.ts` segment (binary mpegts).
    Segment(Vec<u8>),
}

/// Handle a `/{secret}/hls/<path>?<query>` request. `media_base` is the loopback
/// base (`http://127.0.0.1:PORT/SECRET`) used to build the cloud `/media` ffmpeg
/// input. Returns the playlist text or segment bytes, or an error string (→ the
/// caller responds 500/404 and the player falls back to direct `/media`).
pub fn handle(
    app: &tauri::AppHandle,
    path: &str,
    query: &str,
    media_base: &str,
) -> Result<HlsResponse, String> {
    use tauri::Manager;
    let route = parse_route(path).ok_or_else(|| format!("unknown hls path: {path}"))?;
    let params = parse_query_str(query);

    // Clone the Arc so prefetch threads share the *same* caches/semaphore.
    let rt = app.state::<HlsState>().rt.clone();
    let src = parse_source(query, &params, media_base)?;
    let probe = probe_source(&rt, &src)?;

    match route {
        HlsRoute::Master => {
            let rends = offered_renditions(probe.height);
            Ok(HlsResponse::Playlist(master_playlist(&rends, query)))
        }
        HlsRoute::Media { height } => {
            let rend = rendition_for(&probe, height);
            Ok(HlsResponse::Playlist(media_playlist(
                probe.duration,
                SEG_DUR,
                &rend,
                query,
            )))
        }
        HlsRoute::Segment { height, n } => {
            let rend = rendition_for(&probe, height);
            // Live (player-requested) segment: blocks for a permit so it always wins.
            let bytes = produce_segment(&rt, &src, &rend, n, &probe, false)?;
            // Best-effort prefetch of the next window on the shared runtime.
            prefetch_window_segments(rt, src, rend, n, probe);
            Ok(HlsResponse::Segment(bytes))
        }
    }
}

/// Parse a `&`-separated query string into a map (mirrors `stream::parse_query`).
fn parse_query_str(q: &str) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for pair in q.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            m.insert(k.to_string(), v.to_string());
        }
    }
    m
}

// ---------------------------------------------------------------------------
// Tests (pure seams — no ffmpeg needed)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offers_only_renditions_at_or_below_source_height() {
        let r = offered_renditions(1080);
        assert_eq!(r.iter().map(|x| x.height).collect::<Vec<_>>(), vec![1080, 720, 480]);

        let r = offered_renditions(720);
        assert_eq!(r.iter().map(|x| x.height).collect::<Vec<_>>(), vec![720, 480]);

        let r = offered_renditions(600);
        assert_eq!(r.iter().map(|x| x.height).collect::<Vec<_>>(), vec![480]);
    }

    #[test]
    fn always_offers_at_least_the_smallest() {
        // Source shorter than the smallest rendition still gets 480.
        let r = offered_renditions(360);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].height, 480);

        let r = offered_renditions(1);
        assert_eq!(r[0].height, 480);
    }

    #[test]
    fn offers_only_largest_for_huge_source() {
        let r = offered_renditions(2160);
        assert_eq!(r.iter().map(|x| x.height).collect::<Vec<_>>(), vec![1080, 720, 480]);
    }

    #[test]
    fn master_playlist_has_one_stream_inf_per_rendition() {
        let rends = offered_renditions(1080);
        let q = "acct=drive_x&path=AAAA&size=10&ext=mp4";
        let m = master_playlist(&rends, q);
        assert!(m.starts_with("#EXTM3U"));
        assert_eq!(m.matches("#EXT-X-STREAM-INF:").count(), 3);
        // Each STREAM-INF carries BANDWIDTH + RESOLUTION and points at media-<h>.m3u8?<q>.
        assert!(m.contains("RESOLUTION=1920x1080"));
        assert!(m.contains("RESOLUTION=854x480"));
        assert!(m.contains(&format!("media-1080.m3u8?{q}")));
        assert!(m.contains(&format!("media-480.m3u8?{q}")));
        assert!(m.contains("BANDWIDTH="));
    }

    #[test]
    fn segment_count_rounds_up_with_remainder() {
        assert_eq!(segment_count(60.0, 6.0), 10);
        assert_eq!(segment_count(61.0, 6.0), 11); // remainder → extra short segment
        assert_eq!(segment_count(6.0, 6.0), 1);
        assert_eq!(segment_count(0.0, 6.0), 0);
    }

    #[test]
    fn segment_window_clamps_final_segment() {
        // 13s @ 6s → segments [0,6), [6,12), [12,13).
        assert_eq!(segment_window(0, 6.0, 13.0), (0.0, 6.0));
        assert_eq!(segment_window(1, 6.0, 13.0), (6.0, 6.0));
        let (start, dur) = segment_window(2, 6.0, 13.0);
        assert_eq!(start, 12.0);
        assert!((dur - 1.0).abs() < 1e-9);
        // Out of range.
        assert_eq!(segment_window(3, 6.0, 13.0), (18.0, 0.0));
    }

    #[test]
    fn media_playlist_is_vod_with_correct_extinfs_and_endlist() {
        let rend = Rendition { height: 720, width: 1280, v_kbps: 2800, a_kbps: 128 };
        let q = "acct=drive_x&path=AAAA&size=10&ext=mp4";
        let pl = media_playlist(13.0, 6.0, &rend, q);
        assert!(pl.contains("#EXT-X-PLAYLIST-TYPE:VOD"));
        assert!(pl.contains("#EXT-X-TARGETDURATION:6"));
        assert!(pl.trim_end().ends_with("#EXT-X-ENDLIST"));
        // Three segments, the last ~1s.
        assert_eq!(pl.matches("#EXTINF:").count(), 3);
        assert_eq!(pl.matches(".ts?").count(), 3);
        assert!(pl.contains("#EXTINF:6.000000,"));
        assert!(pl.contains("#EXTINF:1.000000,"));
        assert!(pl.contains(&format!("seg-720-0.ts?{q}")));
        assert!(pl.contains(&format!("seg-720-2.ts?{q}")));
    }

    #[test]
    fn picks_macos_videotoolbox_when_available() {
        let avail = vec!["h264_videotoolbox".to_string(), "libx264".to_string()];
        assert_eq!(pick_encoder(&avail, "macos"), Encoder::VideoToolbox);
        // Without it, software.
        let avail = vec!["libx264".to_string()];
        assert_eq!(pick_encoder(&avail, "macos"), Encoder::Libx264);
    }

    #[test]
    fn picks_windows_hw_in_priority_order() {
        let all = vec![
            "h264_nvenc".to_string(),
            "h264_qsv".to_string(),
            "h264_amf".to_string(),
            "libx264".to_string(),
        ];
        assert_eq!(pick_encoder(&all, "windows"), Encoder::Nvenc);
        assert_eq!(
            pick_encoder(&["h264_qsv".to_string(), "h264_amf".to_string()], "windows"),
            Encoder::Qsv
        );
        assert_eq!(pick_encoder(&["h264_amf".to_string()], "windows"), Encoder::Amf);
        assert_eq!(pick_encoder(&["libx264".to_string()], "windows"), Encoder::Libx264);
    }

    #[test]
    fn picks_software_on_other_os() {
        let all = vec!["h264_nvenc".to_string(), "libx264".to_string()];
        assert_eq!(pick_encoder(&all, "linux"), Encoder::Libx264);
    }

    #[test]
    fn ffmpeg_args_for_libx264_480p() {
        let rend = Rendition { height: 480, width: 854, v_kbps: 1400, a_kbps: 96 };
        let args = ffmpeg_args("http://127.0.0.1:9/s/media?x=1", 12.0, 6.0, &rend, Encoder::Libx264);
        // Input seek before -i.
        let ss = args.iter().position(|a| a == "-ss").unwrap();
        let i = args.iter().position(|a| a == "-i").unwrap();
        assert!(ss < i, "-ss must come before -i");
        assert_eq!(args[ss + 1], "12.000000");
        assert_eq!(args[i + 1], "http://127.0.0.1:9/s/media?x=1");
        // Duration window.
        let t = args.iter().position(|a| a == "-t").unwrap();
        assert_eq!(args[t + 1], "6.000000");
        // Scale, encoder, audio.
        assert!(args.windows(2).any(|w| w[0] == "-vf" && w[1] == "scale=-2:480"));
        assert!(args.windows(2).any(|w| w[0] == "-c:v" && w[1] == "libx264"));
        assert!(args.windows(2).any(|w| w[0] == "-preset" && w[1] == "veryfast"));
        assert!(args.windows(2).any(|w| w[0] == "-c:a" && w[1] == "aac"));
        assert!(args.windows(2).any(|w| w[0] == "-b:a" && w[1] == "96k"));
        assert!(args.windows(2).any(|w| w[0] == "-b:v" && w[1] == "1400k"));
        // Aligned timing + mpegts to stdout.
        assert!(args.windows(2).any(|w| w[0] == "-output_ts_offset" && w[1] == "12.000000"));
        assert!(args.windows(2).any(|w| w[0] == "-force_key_frames"));
        assert_eq!(args[args.len() - 1], "pipe:1");
        assert!(args.windows(2).any(|w| w[0] == "-f" && w[1] == "mpegts"));
        // No videotoolbox hwaccel for software.
        assert!(!args.iter().any(|a| a == "videotoolbox"));
    }

    #[test]
    fn ffmpeg_args_for_videotoolbox_1080p_adds_hwaccel() {
        let rend = Rendition { height: 1080, width: 1920, v_kbps: 5000, a_kbps: 128 };
        let args = ffmpeg_args("/abs/clip.mov", 0.0, 6.0, &rend, Encoder::VideoToolbox);
        assert!(args.windows(2).any(|w| w[0] == "-hwaccel" && w[1] == "videotoolbox"));
        assert!(args.windows(2).any(|w| w[0] == "-c:v" && w[1] == "h264_videotoolbox"));
        assert!(args.windows(2).any(|w| w[0] == "-vf" && w[1] == "scale=-2:1080"));
        // Software-only -preset must NOT be present for hw.
        assert!(!args.iter().any(|a| a == "veryfast"));
        assert_eq!(args[args.len() - 1], "pipe:1");
    }

    #[test]
    fn parses_routes() {
        assert_eq!(parse_route("master.m3u8"), Some(HlsRoute::Master));
        assert_eq!(parse_route("media-720.m3u8"), Some(HlsRoute::Media { height: 720 }));
        assert_eq!(parse_route("seg-480-12.ts"), Some(HlsRoute::Segment { height: 480, n: 12 }));
        assert_eq!(parse_route("seg-1080-0.ts"), Some(HlsRoute::Segment { height: 1080, n: 0 }));
        assert_eq!(parse_route("nope.txt"), None);
        assert_eq!(parse_route("media-x.m3u8"), None);
        assert_eq!(parse_route("seg-720.ts"), None);
    }

    #[test]
    fn parses_local_source() {
        let abspath = "/Users/x/clip.mov";
        let b64 = URL_SAFE_NO_PAD.encode(abspath.as_bytes());
        let q = format!("local={b64}");
        let params = parse_query_str(&q);
        let src = parse_source(&q, &params, "http://127.0.0.1:9/s").unwrap();
        assert_eq!(src.key, format!("local|{abspath}"));
        match src.input {
            SourceInput::Local(p) => assert_eq!(p, abspath),
            _ => panic!("expected local input"),
        }
    }

    #[test]
    fn parses_cloud_source_builds_media_url() {
        let path = "Footage/clip A.mov";
        let path_b64 = URL_SAFE_NO_PAD.encode(path.as_bytes());
        let q = format!("acct=drive_x&fid=abc&path={path_b64}&size=100&ext=mov");
        let params = parse_query_str(&q);
        let src = parse_source(&q, &params, "http://127.0.0.1:9/sek").unwrap();
        assert_eq!(src.key, format!("cloud|drive_x|{path}"));
        match src.input {
            SourceInput::Url(u) => {
                assert!(u.starts_with("http://127.0.0.1:9/sek/media?"));
                assert!(u.contains("acct=drive_x"));
                assert!(u.contains(&format!("path={path_b64}")));
                assert!(u.contains("size=100"));
            }
            _ => panic!("expected url input"),
        }
    }

    #[test]
    fn parse_probe_picks_tallest_video_stream_and_duration() {
        let json = r#"{
            "format": {"duration": "61.5"},
            "streams": [
                {"codec_type": "audio"},
                {"codec_type": "video", "height": 720},
                {"codec_type": "video", "height": 1080}
            ]
        }"#;
        let p = parse_probe(json).unwrap();
        assert_eq!(p.height, 1080);
        assert!((p.duration - 61.5).abs() < 1e-9);
    }

    #[test]
    fn parse_probe_errors_without_video_or_duration() {
        assert!(parse_probe(r#"{"format":{"duration":"10"},"streams":[{"codec_type":"audio"}]}"#).is_err());
        assert!(parse_probe(r#"{"streams":[{"codec_type":"video","height":720}]}"#).is_err());
    }

    #[test]
    fn libx264_args_include_threads_cap() {
        let rend = Rendition { height: 720, width: 1280, v_kbps: 2800, a_kbps: 128 };
        let args = ffmpeg_args("/abs/clip.mov", 0.0, 6.0, &rend, Encoder::Libx264);
        // libx264 must carry a -threads cap so one software transcode can't peg
        // every core. The value equals libx264_threads(logical_cores).
        let t = args.iter().position(|a| a == "-threads").expect("libx264 has -threads");
        let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
        assert_eq!(args[t + 1], libx264_threads(cores).to_string());
    }

    #[test]
    fn hardware_args_have_no_threads_cap() {
        // The -threads cap is software-only; hardware encoders manage their own.
        let rend = Rendition { height: 1080, width: 1920, v_kbps: 5000, a_kbps: 128 };
        let args = ffmpeg_args("/abs/clip.mov", 0.0, 6.0, &rend, Encoder::VideoToolbox);
        assert!(!args.iter().any(|a| a == "-threads"));
    }

    #[test]
    fn libx264_threads_is_half_cores_min_two() {
        assert_eq!(libx264_threads(16), 8);
        assert_eq!(libx264_threads(8), 4);
        assert_eq!(libx264_threads(4), 2);
        // Below 4 cores clamps to the floor of 2.
        assert_eq!(libx264_threads(3), 2);
        assert_eq!(libx264_threads(2), 2);
        assert_eq!(libx264_threads(1), 2);
        assert_eq!(libx264_threads(0), 2);
    }

    #[test]
    fn concurrency_is_encoder_aware() {
        // Hardware encoders can run several at once (4); software is capped low (2).
        assert_eq!(concurrency_for(Encoder::VideoToolbox), 4);
        assert_eq!(concurrency_for(Encoder::Nvenc), 4);
        assert_eq!(concurrency_for(Encoder::Qsv), 4);
        assert_eq!(concurrency_for(Encoder::Amf), 4);
        assert_eq!(concurrency_for(Encoder::Libx264), 2);
    }

    #[test]
    fn prefetch_window_warms_up_to_prefetch_ahead() {
        // 60s @ 6s → 10 segments, indices 0..=9.
        // Mid-stream request: warm n+1..=n+PREFETCH.
        assert_eq!(prefetch_window(0, 6.0, 60.0), 1..=4);
        assert_eq!(prefetch_window(2, 6.0, 60.0), 3..=6);
    }

    #[test]
    fn prefetch_window_is_bounded_to_last_segment() {
        // 10 segments (0..=9). Near the end the window clamps to index 9.
        assert_eq!(prefetch_window(7, 6.0, 60.0), 8..=9);
        // On the last segment there is nothing ahead → empty range.
        let w = prefetch_window(9, 6.0, 60.0);
        assert!(w.is_empty());
        // Past the last segment is also empty.
        assert!(prefetch_window(20, 6.0, 60.0).is_empty());
    }

    #[test]
    fn prefetch_window_empty_for_zero_duration() {
        assert!(prefetch_window(0, 6.0, 0.0).is_empty());
    }

    #[test]
    fn segment_cache_evicts_lru_over_cap() {
        let mut c = SegmentCache::default();
        let cap = 100;
        c.insert("a".into(), PathBuf::from("/x/a"), 60, cap);
        c.insert("b".into(), PathBuf::from("/x/b"), 60, cap); // total 120 > cap → evict "a"
        assert!(!c.entries.contains_key("a"));
        assert!(c.entries.contains_key("b"));
        assert_eq!(c.total, 60);
        // Add d → total 90, still under cap, nothing evicted.
        c.insert("d".into(), PathBuf::from("/x/d"), 30, cap); // total 90
        assert!(c.entries.contains_key("b"));
        assert!(c.entries.contains_key("d"));
        assert_eq!(c.total, 90);
    }
}
