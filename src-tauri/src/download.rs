//! Download job management.
//!
//! A download is an rclone async job (`operations/copyfile` for a file,
//! `sync/copy` for a folder) launched over the rc API. rclone tags each async
//! job's stats under the group `job/<jobid>`, so live progress is read via
//! `core/stats {group}` and completion via `job/status {jobid}`. Started jobs are
//! tracked in `JobsState` so the UI can poll them globally.

use crate::accounts::parse_remote;
use crate::rclone::supervisor::{rc_post, RcConnection, RcloneState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::AppHandle;

/// An item the user selected to download.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DownloadItem {
    /// Path of the item relative to the account fs root.
    pub path: String,
    /// Display/file name (last path segment).
    pub name: String,
    pub is_dir: bool,
    /// Known size in bytes (0 / -1 for dirs).
    pub size: i64,
    /// Backend file id — required to stream a single Drive file (empty otherwise).
    #[serde(default)]
    pub id: String,
    /// Extra HTTP request headers for direct (Http) downloads — notably
    /// `Referer`, `Cookie`, and `User-Agent` — so cookie/referer-gated direct
    /// downloads (mediafire/filecr/"save image as") succeed.
    #[serde(default)]
    pub headers: std::collections::HashMap<String, String>,
}

/// A tracked job (what we remember after launching).
#[derive(Clone, Debug)]
pub struct Job {
    pub job_id: i64,
    pub account_id: String,
    pub name: String,
    pub dest: String,
    pub total_bytes: i64,
    pub cancelled: bool,
    /// "download" or "upload" — the UI routes each kind to a different surface.
    pub kind: &'static str,
    /// Last observed completion, remembered across polls. rclone reaps a finished
    /// async job after ~60s (`--rc-job-expire-duration`), after which `job/status`
    /// returns "job not found" while the job's stats group still reports 100%.
    /// Without remembering it, a completed upload would snap back to
    /// "Uploading 100%" forever once reaped. Sticky: set true, never cleared.
    pub finished: bool,
    pub success: bool,
    pub error: String,
}

/// Managed state: all jobs launched this session.
#[derive(Default)]
pub struct JobsState {
    pub jobs: Mutex<Vec<Job>>,
}

/// Shared progress/control handles for a native (non-rclone) download job, used
/// by the Dropbox shared-link engine. Cloned into the worker thread so the poll
/// command can read live bytes and request cancellation.
#[derive(Clone)]
pub struct NativeHandles {
    pub job_id: i64,
    pub transferred: Arc<AtomicI64>,
    /// Total bytes for the whole job. Seeded at create; a worker that only learns
    /// the real size after resolving a manifest (WeTransfer/Filemail share links,
    /// whose size is 0 at enqueue) stores it here so the progress bar/ETA fill in
    /// live. `list_jobs` reads this, not the fixed `NativeJob.total_bytes`.
    pub total: Arc<AtomicI64>,
    pub finished: Arc<AtomicBool>,
    pub success: Arc<AtomicBool>,
    pub cancelled: Arc<AtomicBool>,
    pub error: Arc<Mutex<String>>,
    /// Live peer count for torrent jobs (-1 = not a torrent / no live session yet).
    pub peers: Arc<AtomicI64>,
}

/// Minimum gap between speed samples; below this we reuse the last reading so a
/// double-poll can't divide a tiny byte delta by a near-zero interval.
const MIN_SAMPLE_SECS: f64 = 0.25;
/// EMA weight kept on the previous reading (the rest goes to the new sample).
/// Light smoothing so the number is steady without lagging real changes.
const SPEED_EMA_KEEP: f64 = 0.6;
/// A single-tick rate above this (5 GB/s) is never real network throughput for
/// these users — it's a resumed job seeding `transferred` with bytes already on
/// disk. Such a sample re-baselines the speedometer instead of spiking it.
const MAX_PLAUSIBLE_BPS: f64 = 5_000_000_000.0;

/// Rolling speedometer for a native job. Speed is the byte delta between polls
/// over their time gap (instantaneous), not cumulative bytes / session time —
/// the latter reported "download speed = disk read speed" right after a resume,
/// because a resumed job seeds `transferred` with everything already on disk and
/// dividing that by a few seconds of uptime is a huge, fake number. Here the
/// first post-(re)start sample only primes the baseline, and any implausibly
/// large delta re-baselines rather than spiking.
#[derive(Debug)]
struct Speedo {
    last_t: Instant,
    last_bytes: i64,
    primed: bool,
    ema: f64,
}

impl Speedo {
    /// Feed the latest cumulative byte count; return instantaneous speed
    /// (bytes/sec). The first call primes the baseline and returns 0, so a
    /// resumed job's seeded bytes are never counted as throughput. A single
    /// delta above `MAX_PLAUSIBLE_BPS` is a seed/disk artifact: the baseline
    /// advances but the reading is left unchanged.
    fn sample(&mut self, bytes: i64, now: Instant) -> f64 {
        if !self.primed {
            self.primed = true;
            self.last_t = now;
            self.last_bytes = bytes;
            return 0.0;
        }
        let dt = now.duration_since(self.last_t).as_secs_f64();
        if dt >= MIN_SAMPLE_SECS {
            let inst = (bytes - self.last_bytes).max(0) as f64 / dt;
            self.last_t = now;
            self.last_bytes = bytes;
            if inst <= MAX_PLAUSIBLE_BPS {
                self.ema = if self.ema == 0.0 { inst } else { self.ema * SPEED_EMA_KEEP + inst * (1.0 - SPEED_EMA_KEEP) };
            }
        }
        self.ema
    }
}

/// A tracked native download job (Dropbox links stream over the native API
/// rather than rclone, so they need their own progress accounting).
pub struct NativeJob {
    pub account_id: String,
    pub name: String,
    pub dest: String,
    pub total_bytes: i64,
    pub started: Instant,
    pub handles: NativeHandles,
    /// Instantaneous-speed tracker; see `Speedo`.
    speedometer: Mutex<Speedo>,
}

/// Managed state for native jobs. `next_id` allocates NEGATIVE ids so they never
/// collide with rclone's positive job ids (both flow through `list_jobs`).
#[derive(Default)]
pub struct NativeJobsState {
    pub jobs: Mutex<Vec<NativeJob>>,
    pub next_id: AtomicI64,
}

impl NativeJobsState {
    /// Register a new native job and return its control handles. The caller
    /// spawns the worker thread that drives `handles`.
    pub fn create(&self, account_id: &str, name: &str, dest: &str, total: i64) -> NativeHandles {
        let job_id = -(self.next_id.fetch_add(1, Ordering::SeqCst) + 1);
        let handles = NativeHandles {
            job_id,
            transferred: Arc::new(AtomicI64::new(0)),
            total: Arc::new(AtomicI64::new(total)),
            finished: Arc::new(AtomicBool::new(false)),
            success: Arc::new(AtomicBool::new(false)),
            cancelled: Arc::new(AtomicBool::new(false)),
            error: Arc::new(Mutex::new(String::new())),
            peers: Arc::new(AtomicI64::new(-1)),
        };
        self.jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(NativeJob {
                account_id: account_id.to_string(),
                name: name.to_string(),
                dest: dest.to_string(),
                total_bytes: total,
                started: Instant::now(),
                handles: handles.clone(),
                speedometer: Mutex::new(Speedo {
                    last_t: Instant::now(),
                    last_bytes: 0,
                    primed: false,
                    ema: 0.0,
                }),
            });
        handles
    }
}

/// Live job status reported to the UI.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JobStatus {
    pub job_id: i64,
    pub account_id: String,
    pub name: String,
    pub dest: String,
    pub total_bytes: i64,
    pub bytes: i64,
    pub speed: f64,
    pub eta: Option<f64>,
    pub finished: bool,
    pub success: bool,
    pub cancelled: bool,
    pub error: String,
    /// "download" or "upload" — lets the frontend split the shared job poll.
    pub kind: &'static str,
    /// Live peer count for torrents (-1 = not a torrent / not yet peering).
    pub peers: i64,
}

/// rclone connection string for an account id (provider derived from prefix).
/// Drive surfaces "Shared with me"; Dropbox is plain.
pub fn account_fs(account_id: &str) -> Result<String, String> {
    let acct = parse_remote(account_id).ok_or_else(|| format!("bad account id: {account_id}"))?;
    // Drive *links* (folder id) and Shared-Drive links (team_drive) are rooted by
    // their config — list them plainly, not via "Shared with me".
    if account_id.starts_with("drivelink_") || account_id.starts_with("teamdrive_") {
        return Ok(format!("{account_id}:"));
    }
    Ok(match acct.provider.as_str() {
        "drive" => format!("{account_id},shared_with_me=true:"),
        _ => format!("{account_id}:"),
    })
}

/// rclone fs for the FULL background index crawl. Unlike `account_fs` (which
/// surfaces "Shared with me" so browsing sees everything), the auto-index covers
/// ONLY the account's OWNED content: for Drive that's plain My Drive with
/// shortcuts skipped, so the crawl never follows shortcuts/shares into clients'
/// entire drives and reports tens of TB the user doesn't own. Shared folders are
/// still browsed live and can be indexed on demand (`index_folder` keeps using
/// `account_fs`); only the automatic whole-account crawl is bounded to what the
/// account actually stores.
pub fn index_fs(account_id: &str) -> Result<String, String> {
    let acct = parse_remote(account_id).ok_or_else(|| format!("bad account id: {account_id}"))?;
    if account_id.starts_with("drivelink_") || account_id.starts_with("teamdrive_") {
        return Ok(format!("{account_id}:"));
    }
    Ok(match acct.provider.as_str() {
        "drive" => format!("{account_id},skip_shortcuts=true:"),
        _ => format!("{account_id}:"),
    })
}

/// Build the rc (endpoint, params) for downloading one item to `dest`.
/// File → operations/copyfile; folder → sync/copy into `dest/<name>`.
pub fn build_copy(account_fs: &str, item: &DownloadItem, dest: &str) -> (&'static str, Value) {
    if item.is_dir {
        let src = format!("{account_fs}{}", item.path);
        let dst = format!("{dest}/{}", item.name);
        (
            "sync/copy",
            json!({ "srcFs": src, "dstFs": dst, "_async": true }),
        )
    } else {
        (
            "operations/copyfile",
            json!({
                "srcFs": account_fs,
                "srcRemote": item.path,
                "dstFs": dest,
                "dstRemote": item.name,
                "_async": true,
            }),
        )
    }
}

/// Join a remote folder path and an item name ("" folder = account root).
fn join_remote(dest_path: &str, name: &str) -> String {
    if dest_path.is_empty() {
        name.to_string()
    } else {
        format!("{dest_path}/{name}")
    }
}

/// Build the rc (endpoint, params) for uploading one LOCAL item into the remote
/// folder `dest_path`. A file → `operations/copyfile` (srcFs = its parent dir on
/// the local fs); a folder → `sync/copy` into `dest_path/<name>`. Both async so
/// they get a jobid + `job/<id>` stats group, same as downloads once did.
pub fn build_upload(
    account_fs: &str,
    local_path: &str,
    name: &str,
    is_dir: bool,
    dest_path: &str,
) -> (&'static str, Value) {
    if is_dir {
        (
            "sync/copy",
            json!({
                "srcFs": local_path,
                "dstFs": format!("{account_fs}{}", join_remote(dest_path, name)),
                "_async": true,
            }),
        )
    } else {
        // Split the file into (parent dir as the local fs, filename as remote) —
        // rclone's local backend takes a plain absolute path as the fs string.
        let parent = std::path::Path::new(local_path)
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        (
            "operations/copyfile",
            json!({
                "srcFs": parent,
                "srcRemote": name,
                "dstFs": account_fs,
                "dstRemote": join_remote(dest_path, name),
                "_async": true,
            }),
        )
    }
}

/// Launch uploads of local files/folders into `dest_path` on an account. Each
/// item becomes one rclone async job tracked in `JobsState`, so `list_jobs`
/// reports progress and `cancel_job` stops it — no new polling machinery.
#[tauri::command]
pub fn upload_start(
    rclone: tauri::State<RcloneState>,
    jobs_state: tauri::State<JobsState>,
    account_id: String,
    paths: Vec<String>,
    dest_path: String,
) -> Result<Vec<JobStatus>, String> {
    if account_id.starts_with("dropboxlink_") {
        return Err("can't upload to a Dropbox shared link (it's read-only)".into());
    }
    let conn = connection(&rclone)?;
    let fs = account_fs(&account_id)?;
    let mut created = Vec::with_capacity(paths.len());
    for local in paths {
        let meta = std::fs::metadata(&local).map_err(|e| format!("{local}: {e}"))?;
        let name = std::path::Path::new(&local)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| format!("bad path: {local}"))?;
        let total = if meta.is_dir() { 0 } else { meta.len() as i64 };
        let (endpoint, params) = build_upload(&fs, &local, &name, meta.is_dir(), &dest_path);
        let resp = rc_post(&conn, endpoint, &params).map_err(humanize_write_err)?;
        let job_id = resp
            .get("jobid")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| "rclone returned no job id".to_string())?;
        jobs_state.jobs.lock().unwrap_or_else(|e| e.into_inner()).push(Job {
            job_id,
            account_id: account_id.clone(),
            name: name.clone(),
            dest: dest_path.clone(),
            total_bytes: total,
            cancelled: false,
            kind: "upload",
            finished: false,
            success: false,
            error: String::new(),
        });
        created.push(status_for(job_id, &account_id, &name, &dest_path, total, "upload"));
    }
    Ok(created)
}

fn connection(state: &RcloneState) -> Result<RcConnection, String> {
    state
        .connection
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| "rclone not started".to_string())
}

/// Launch downloads for the selected items; returns the created job statuses.
///
/// Launch downloads. All transfers run on the native resumable engine
/// (`transfer.rs`): each file is pulled by several parallel connections into a
/// preallocated part file with a block bitmap, so it resumes byte-for-byte after
/// a pause or crash. `config` carries `{connections, bwLimitBytes}`. rclone is
/// still used for listing/index, not for the byte transfer.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri commands take their state as params.
pub fn start_download(
    app: AppHandle,
    rclone: tauri::State<RcloneState>,
    jobs_state: tauri::State<JobsState>,
    native: tauri::State<NativeJobsState>,
    account_id: String,
    items: Vec<DownloadItem>,
    dest: String,
    config: Option<Value>,
) -> Result<Vec<JobStatus>, String> {
    let _ = &jobs_state; // retained for compatibility
    let conf = config.unwrap_or_default();
    let connections = conf.get("connections").and_then(|v| v.as_u64()).unwrap_or(4) as usize;
    let bw_limit = conf.get("bwLimitBytes").and_then(|v| v.as_u64()).unwrap_or(0);
    crate::transfer::set_bw_limit(bw_limit);

    let conn = connection(&rclone)?;
    let mut created = Vec::with_capacity(items.len());
    for item in items {
        let total = item.size.max(0);
        let handles = native.create(&account_id, &item.name, &dest, total);
        created.push(status_for(handles.job_id, &account_id, &item.name, &dest, total, "download"));
        let app = app.clone();
        let conn = conn.clone();
        let account_id = account_id.clone();
        let dest = dest.clone();
        std::thread::spawn(move || {
            crate::transfer::download_item(app, conn, account_id, item, dest, connections, handles)
        });
    }
    Ok(created)
}

fn status_for(job_id: i64, account_id: &str, name: &str, dest: &str, total: i64, kind: &'static str) -> JobStatus {
    JobStatus {
        job_id,
        account_id: account_id.to_string(),
        name: name.to_string(),
        dest: dest.to_string(),
        total_bytes: total,
        bytes: 0,
        speed: 0.0,
        eta: None,
        finished: false,
        success: false,
        cancelled: false,
        error: String::new(),
        kind,
        peers: -1,
    }
}

/// Live status for a native job, computed from its atomic counters. Speed is the
/// running average (bytes / elapsed); good enough for an ETA display.
fn native_status(job: &NativeJob) -> JobStatus {
    let h = &job.handles;
    let bytes = h.transferred.load(Ordering::SeqCst);
    // Live total (a share worker updates it once the manifest resolves); falls
    // back to the create-time size for regular downloads that knew it up front.
    let total = h.total.load(Ordering::SeqCst).max(job.total_bytes);
    let finished = h.finished.load(Ordering::SeqCst);
    let cancelled = h.cancelled.load(Ordering::SeqCst);
    // Instantaneous speed (byte delta / poll gap), with the resume seed baselined
    // out — see `Speedo::sample`.
    let speed = if finished {
        0.0
    } else {
        job.speedometer.lock().unwrap_or_else(|e| e.into_inner()).sample(bytes, Instant::now())
    };
    let eta = if speed > 0.0 && total > bytes {
        Some((total - bytes) as f64 / speed)
    } else {
        None
    };
    JobStatus {
        job_id: h.job_id,
        account_id: job.account_id.clone(),
        name: job.name.clone(),
        dest: job.dest.clone(),
        total_bytes: total,
        bytes,
        speed,
        eta,
        finished,
        success: h.success.load(Ordering::SeqCst),
        cancelled,
        error: h.error.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        kind: "download",
        peers: h.peers.load(Ordering::SeqCst),
    }
}

/// Poll live status for all tracked jobs (stats group + job status), including
/// native Dropbox-link jobs.
#[tauri::command]
pub fn list_jobs(
    rclone: tauri::State<RcloneState>,
    jobs_state: tauri::State<JobsState>,
    native: tauri::State<NativeJobsState>,
) -> Result<Vec<JobStatus>, String> {
    let conn = connection(&rclone)?;
    let jobs = jobs_state.jobs.lock().unwrap_or_else(|e| e.into_inner()).clone();

    let mut out = Vec::with_capacity(jobs.len());
    // Sticky completion updates to write back after polling (kept out of the poll
    // loop so the jobs lock isn't held across network calls).
    let mut sticky: Vec<(i64, bool, bool, String)> = Vec::new();
    for job in &jobs {
        let mut s = status_for(job.job_id, &job.account_id, &job.name, &job.dest, job.total_bytes, job.kind);
        s.cancelled = job.cancelled;

        // Live byte/speed/eta from the per-job stats group. Note the stats group
        // OUTLIVES the job itself: after rclone reaps a finished async job, this
        // still returns the final bytes (100%) even though `job/status` 404s.
        let mut stats_ok = false;
        if let Ok(stats) = rc_post(
            &conn,
            "core/stats",
            &json!({ "group": format!("job/{}", job.job_id) }),
        ) {
            stats_ok = true;
            s.bytes = stats.get("bytes").and_then(|v| v.as_i64()).unwrap_or(0);
            s.speed = stats.get("speed").and_then(|v| v.as_f64()).unwrap_or(0.0);
            s.eta = stats.get("eta").and_then(|v| v.as_f64());
            if s.total_bytes == 0 {
                s.total_bytes = stats.get("totalBytes").and_then(|v| v.as_i64()).unwrap_or(0);
            }
        }

        // Completion + error from job status.
        match rc_post(&conn, "job/status", &json!({ "jobid": job.job_id })) {
            Ok(js) => {
                s.finished = js.get("finished").and_then(|v| v.as_bool()).unwrap_or(false);
                s.success = js.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
                if let Some(err) = js.get("error").and_then(|v| v.as_str()) {
                    s.error = err.to_string();
                }
                if s.finished {
                    sticky.push((job.job_id, true, s.success, s.error.clone()));
                }
            }
            // job/status errored. If we already saw this job finish, keep that
            // (sticky) — don't let a reaped job revert to "in progress". If we
            // never saw it finish but the daemon is alive (stats_ok) and the job
            // is now gone, it was reaped after completing, so treat it as done.
            Err(_) => {
                if job.finished {
                    s.finished = true;
                    s.success = job.success;
                    if s.error.is_empty() {
                        s.error = job.error.clone();
                    }
                } else if stats_ok {
                    s.finished = true;
                    s.success = !job.cancelled;
                    sticky.push((job.job_id, true, s.success, String::new()));
                }
            }
        }
        // A finished job isn't moving and shows a full bar.
        if s.finished {
            s.speed = 0.0;
            s.eta = None;
            if s.total_bytes > 0 && s.bytes < s.total_bytes {
                s.bytes = s.total_bytes;
            }
        }
        out.push(s);
    }
    if !sticky.is_empty() {
        let mut jl = jobs_state.jobs.lock().unwrap_or_else(|e| e.into_inner());
        for (id, fin, suc, err) in sticky {
            if let Some(j) = jl.iter_mut().find(|j| j.job_id == id) {
                j.finished = fin;
                j.success = suc;
                j.error = err;
            }
        }
    }

    // Native (Dropbox-link) jobs.
    for job in native.jobs.lock().unwrap_or_else(|e| e.into_inner()).iter() {
        out.push(native_status(job));
    }
    Ok(out)
}

/// Stop a running job and mark it cancelled. Negative ids are native jobs (a
/// cancel flag the worker thread observes); positive ids go to rclone.
#[tauri::command]
pub fn cancel_job(
    rclone: tauri::State<RcloneState>,
    jobs_state: tauri::State<JobsState>,
    native: tauri::State<NativeJobsState>,
    job_id: i64,
) -> Result<(), String> {
    if job_id < 0 {
        for j in native.jobs.lock().unwrap_or_else(|e| e.into_inner()).iter() {
            if j.handles.job_id == job_id {
                j.handles.cancelled.store(true, Ordering::SeqCst);
            }
        }
        return Ok(());
    }
    let conn = connection(&rclone)?;
    let _ = rc_post(&conn, "job/stop", &json!({ "jobid": job_id }));
    let mut jobs = jobs_state.jobs.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(j) = jobs.iter_mut().find(|j| j.job_id == job_id) {
        j.cancelled = true;
    }
    Ok(())
}

/// Remove finished/cancelled jobs from tracking (clear completed).
#[tauri::command]
pub fn clear_finished_jobs(
    rclone: tauri::State<RcloneState>,
    jobs_state: tauri::State<JobsState>,
    native: tauri::State<NativeJobsState>,
) -> Result<(), String> {
    // Best-effort: ask rclone the finished state; keep only unfinished, non-cancelled.
    let conn = connection(&rclone)?;
    let mut jobs = jobs_state.jobs.lock().unwrap_or_else(|e| e.into_inner());
    jobs.retain(|j| {
        // Uploads are cleared by the frontend's own dismiss flow (a finished
        // upload stays on the Uploads screen until dismissed), so this
        // "clear finished downloads" sweep — which also fires when a download is
        // paused/auto-paused — must NOT drop them, or the Uploads history would
        // silently empty out from under the user.
        if j.kind == "upload" {
            return true;
        }
        if j.cancelled {
            return false;
        }
        match rc_post(&conn, "job/status", &json!({ "jobid": j.job_id })) {
            Ok(js) => !js.get("finished").and_then(|v| v.as_bool()).unwrap_or(false),
            Err(_) => true,
        }
    });
    // Drop finished/cancelled native jobs too.
    native
        .jobs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|j| {
            !j.handles.finished.load(Ordering::SeqCst) && !j.handles.cancelled.load(Ordering::SeqCst)
        });
    Ok(())
}

/// Delete a file or folder from its cloud account. Deletions go to the provider's
/// recycle bin (Google Drive Trash / Dropbox's 30-day history), so they're
/// recoverable — not a hard erase. A file uses `operations/deletefile`; a folder
/// uses `operations/purge` (folder + contents). Shared-link accounts
/// (`dropboxlink_`) are read-only and rejected, and an empty path (the account
/// root) is refused as a guard.
#[tauri::command]
pub fn delete_item(
    rclone: tauri::State<RcloneState>,
    account_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    if account_id.starts_with("dropboxlink_") {
        return Err("can't delete from a Dropbox shared link (it's read-only)".into());
    }
    if path.trim().is_empty() {
        return Err("refusing to delete the account root".into());
    }
    let conn = connection(&rclone)?;
    let fs = account_fs(&account_id)?;
    let endpoint = if is_dir { "operations/purge" } else { "operations/deletefile" };
    rc_post(&conn, endpoint, &json!({ "fs": fs, "remote": path })).map_err(humanize_write_err)?;
    Ok(())
}

/// Move or copy a file/folder to another folder WITHIN the same account (in-app
/// drag-and-drop reorg). Google Drive / Dropbox do these server-side, so no data
/// is re-downloaded. A file uses `operations/movefile`/`copyfile`; a folder uses
/// `sync/move`/`sync/copy` into `dest/<name>` (then rmdir the emptied source on a
/// move). Read-only shared links and self/descendant targets are refused.
/// Returns the item's new path.
#[tauri::command]
pub fn move_item(
    rclone: tauri::State<RcloneState>,
    account_id: String,
    src_path: String,
    dst_dir: String,
    is_dir: bool,
    copy: bool,
) -> Result<String, String> {
    if account_id.starts_with("dropboxlink_") {
        return Err("can't move inside a Dropbox shared link (it's read-only)".into());
    }
    let src = src_path.trim().trim_matches('/');
    if src.is_empty() {
        return Err("refusing to move the account root".into());
    }
    let name = src.rsplit('/').next().unwrap_or(src);
    let dst_dir = dst_dir.trim().trim_matches('/');
    let dst_path = if dst_dir.is_empty() { name.to_string() } else { format!("{dst_dir}/{name}") };
    if dst_path == src {
        return Err("It's already in that folder.".into());
    }
    // A folder can't be dropped into itself or one of its own descendants.
    if is_dir && (dst_dir == src || dst_dir.starts_with(&format!("{src}/"))) {
        return Err("Can't move a folder into itself.".into());
    }
    let conn = connection(&rclone)?;
    let fs = account_fs(&account_id)?; // e.g. "drive_x:"
    if is_dir {
        let src_fs = format!("{fs}{src}");
        let dst_fs = format!("{fs}{dst_path}");
        let endpoint = if copy { "sync/copy" } else { "sync/move" };
        rc_post(
            &conn,
            endpoint,
            &json!({ "srcFs": src_fs, "dstFs": dst_fs, "createEmptySrcDirs": true }),
        )
        .map_err(humanize_write_err)?;
        // sync/move leaves the now-empty source directory behind — remove it.
        if !copy {
            let _ = rc_post(&conn, "operations/rmdir", &json!({ "fs": fs, "remote": src }));
        }
    } else {
        let endpoint = if copy { "operations/copyfile" } else { "operations/movefile" };
        rc_post(
            &conn,
            endpoint,
            &json!({ "srcFs": fs, "srcRemote": src, "dstFs": fs, "dstRemote": dst_path }),
        )
        .map_err(humanize_write_err)?;
    }
    Ok(dst_path)
}

/// Turn rclone's raw write (delete/upload) failure into a human message for the
/// common permission cases.
fn humanize_write_err(e: String) -> String {
    if e.contains("ACCESS_TOKEN_SCOPE_INSUFFICIENT") || e.contains("insufficientPermissions") {
        "Insufficient permission — this Google Drive account was connected read-only. \
         Reconnect it (remove + add again) to grant write access. Note: writing into a folder \
         shared with you needs Editor permission from its owner."
            .into()
    } else if e.contains("files.content.write") || e.contains("missing_scope") {
        "This Dropbox app doesn't have the 'files.content.write' permission yet. Open the \
         Dropbox App Console (dropbox.com/developers/apps) → your app → Permissions, tick \
         'files.content.write' (and 'files.content.read'), click Submit, then reconnect this \
         account in FDM (remove + add again) so the new permission takes effect."
            .into()
    } else {
        e
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn speedometer_baselines_resume_seed_and_reports_instantaneous() {
        let t0 = Instant::now();
        let mut sp = Speedo { last_t: t0, last_bytes: 0, primed: false, ema: 0.0 };

        // First poll after a resume: `transferred` jumps to 381 GB already on
        // disk. This must PRIME the baseline (report 0), never a disk-speed spike.
        let seeded = 381_000_000_000i64;
        assert_eq!(sp.sample(seeded, t0), 0.0);

        // 1 s later, 100 MB actually downloaded → ~100 MB/s (first real sample
        // seeds the EMA, so it equals the instantaneous value).
        let t1 = t0 + Duration::from_secs(1);
        let s = sp.sample(seeded + 100_000_000, t1);
        assert!((s - 100_000_000.0).abs() < 1.0, "expected ~100 MB/s, got {s}");

        // A seed jump caught mid-fill (+50 GB in 1 s = 50 GB/s) is implausible as
        // network throughput → rejected; the reading holds at the prior EMA.
        let t2 = t1 + Duration::from_secs(1);
        let s2 = sp.sample(seeded + 100_000_000 + 50_000_000_000, t2);
        assert_eq!(s2, s, "implausible delta must not spike the speed");

        // A finished job reports 0 (handled by the caller, but the EMA persists).
        // A normal follow-up sample keeps producing a plausible number.
        let t3 = t2 + Duration::from_secs(1);
        let s3 = sp.sample(seeded + 100_000_000 + 50_000_000_000 + 80_000_000, t3);
        assert!(s3 > 0.0 && s3 < MAX_PLAUSIBLE_BPS, "got {s3}");
    }

    fn item(path: &str, name: &str, is_dir: bool, size: i64) -> DownloadItem {
        DownloadItem {
            path: path.into(),
            name: name.into(),
            is_dir,
            size,
            id: String::new(),
            headers: Default::default(),
        }
    }

    #[test]
    fn account_fs_drive_uses_shared_with_me() {
        assert_eq!(account_fs("drive_x").unwrap(), "drive_x,shared_with_me=true:");
        assert_eq!(account_fs("dropbox_y").unwrap(), "dropbox_y:");
        assert_eq!(account_fs("drivelink_client_a").unwrap(), "drivelink_client_a:");
        assert_eq!(account_fs("teamdrive_aloha").unwrap(), "teamdrive_aloha:");
        assert!(account_fs("bogus").is_err());
    }

    #[test]
    fn index_fs_drive_is_owned_only() {
        // The auto-index crawls owned My Drive with shortcuts skipped (NOT
        // shared_with_me), so it never follows shortcuts into shared content.
        assert_eq!(index_fs("drive_x").unwrap(), "drive_x,skip_shortcuts=true:");
        assert_eq!(index_fs("dropbox_y").unwrap(), "dropbox_y:");
        assert_eq!(index_fs("drivelink_client_a").unwrap(), "drivelink_client_a:");
        assert_eq!(index_fs("teamdrive_aloha").unwrap(), "teamdrive_aloha:");
        assert!(index_fs("bogus").is_err());
    }

    #[test]
    fn build_copy_file_uses_copyfile() {
        let (endpoint, params) = build_copy(
            "drive_x,shared_with_me=true:",
            &item("Folder/a.mxf", "a.mxf", false, 1000),
            "/dest",
        );
        assert_eq!(endpoint, "operations/copyfile");
        assert_eq!(params["srcFs"], "drive_x,shared_with_me=true:");
        assert_eq!(params["srcRemote"], "Folder/a.mxf");
        assert_eq!(params["dstFs"], "/dest");
        assert_eq!(params["dstRemote"], "a.mxf");
        assert_eq!(params["_async"], true);
    }

    #[test]
    fn build_copy_dir_uses_sync_copy_into_named_subfolder() {
        let (endpoint, params) = build_copy(
            "drive_x,shared_with_me=true:",
            &item("FolderA", "FolderA", true, 0),
            "/dest",
        );
        assert_eq!(endpoint, "sync/copy");
        assert_eq!(params["srcFs"], "drive_x,shared_with_me=true:FolderA");
        assert_eq!(params["dstFs"], "/dest/FolderA");
        assert_eq!(params["_async"], true);
    }

    #[test]
    fn build_upload_file_copies_from_parent_dir_into_dest() {
        let (endpoint, params) = build_upload(
            "drive_x,shared_with_me=true:",
            "/renders/final/cut_v3.mp4",
            "cut_v3.mp4",
            false,
            "Client/Renders",
        );
        assert_eq!(endpoint, "operations/copyfile");
        assert_eq!(params["srcFs"], "/renders/final");
        assert_eq!(params["srcRemote"], "cut_v3.mp4");
        assert_eq!(params["dstFs"], "drive_x,shared_with_me=true:");
        assert_eq!(params["dstRemote"], "Client/Renders/cut_v3.mp4");
        assert_eq!(params["_async"], true);
    }

    #[test]
    fn build_upload_file_into_account_root_uses_bare_name() {
        let (_, params) = build_upload("dropbox_y:", "/renders/cut.mp4", "cut.mp4", false, "");
        assert_eq!(params["dstRemote"], "cut.mp4");
    }

    #[test]
    fn build_upload_dir_syncs_into_named_remote_subfolder() {
        let (endpoint, params) = build_upload(
            "dropbox_y:",
            "/renders/ProjectX",
            "ProjectX",
            true,
            "Client/Renders",
        );
        assert_eq!(endpoint, "sync/copy");
        assert_eq!(params["srcFs"], "/renders/ProjectX");
        assert_eq!(params["dstFs"], "dropbox_y:Client/Renders/ProjectX");
        assert_eq!(params["_async"], true);
    }
}
