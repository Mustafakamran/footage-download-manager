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
    pub finished: Arc<AtomicBool>,
    pub success: Arc<AtomicBool>,
    pub cancelled: Arc<AtomicBool>,
    pub error: Arc<Mutex<String>>,
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
            finished: Arc::new(AtomicBool::new(false)),
            success: Arc::new(AtomicBool::new(false)),
            cancelled: Arc::new(AtomicBool::new(false)),
            error: Arc::new(Mutex::new(String::new())),
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
}

/// rclone connection string for an account id (provider derived from prefix).
/// Drive surfaces "Shared with me"; Dropbox is plain.
pub fn account_fs(account_id: &str) -> Result<String, String> {
    let acct = parse_remote(account_id).ok_or_else(|| format!("bad account id: {account_id}"))?;
    // Drive *links* are rooted at a folder id in their config — list them plainly,
    // not via "Shared with me".
    if account_id.starts_with("drivelink_") {
        return Ok(format!("{account_id}:"));
    }
    Ok(match acct.provider.as_str() {
        "drive" => format!("{account_id},shared_with_me=true:"),
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
        created.push(status_for(handles.job_id, &account_id, &item.name, &dest, total));
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

fn status_for(job_id: i64, account_id: &str, name: &str, dest: &str, total: i64) -> JobStatus {
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
    }
}

/// Live status for a native job, computed from its atomic counters. Speed is the
/// running average (bytes / elapsed); good enough for an ETA display.
fn native_status(job: &NativeJob) -> JobStatus {
    let h = &job.handles;
    let bytes = h.transferred.load(Ordering::SeqCst);
    let finished = h.finished.load(Ordering::SeqCst);
    let cancelled = h.cancelled.load(Ordering::SeqCst);
    let elapsed = job.started.elapsed().as_secs_f64().max(0.001);
    let speed = if finished { 0.0 } else { bytes as f64 / elapsed };
    let eta = if speed > 0.0 && job.total_bytes > bytes {
        Some((job.total_bytes - bytes) as f64 / speed)
    } else {
        None
    };
    JobStatus {
        job_id: h.job_id,
        account_id: job.account_id.clone(),
        name: job.name.clone(),
        dest: job.dest.clone(),
        total_bytes: job.total_bytes,
        bytes,
        speed,
        eta,
        finished,
        success: h.success.load(Ordering::SeqCst),
        cancelled,
        error: h.error.lock().unwrap_or_else(|e| e.into_inner()).clone(),
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
    for job in &jobs {
        let mut s = status_for(job.job_id, &job.account_id, &job.name, &job.dest, job.total_bytes);
        s.cancelled = job.cancelled;

        // Live byte/speed/eta from the per-job stats group.
        if let Ok(stats) = rc_post(
            &conn,
            "core/stats",
            &json!({ "group": format!("job/{}", job.job_id) }),
        ) {
            s.bytes = stats.get("bytes").and_then(|v| v.as_i64()).unwrap_or(0);
            s.speed = stats.get("speed").and_then(|v| v.as_f64()).unwrap_or(0.0);
            s.eta = stats.get("eta").and_then(|v| v.as_f64());
            if s.total_bytes == 0 {
                s.total_bytes = stats.get("totalBytes").and_then(|v| v.as_i64()).unwrap_or(0);
            }
        }

        // Completion + error from job status.
        if let Ok(js) = rc_post(&conn, "job/status", &json!({ "jobid": job.job_id })) {
            s.finished = js.get("finished").and_then(|v| v.as_bool()).unwrap_or(false);
            s.success = js.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
            if let Some(err) = js.get("error").and_then(|v| v.as_str()) {
                s.error = err.to_string();
            }
        }
        out.push(s);
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
    rc_post(&conn, endpoint, &json!({ "fs": fs, "remote": path })).map_err(humanize_delete_err)?;
    Ok(())
}

/// Turn rclone's raw delete failure into a human message for the common cases.
fn humanize_delete_err(e: String) -> String {
    if e.contains("ACCESS_TOKEN_SCOPE_INSUFFICIENT") || e.contains("insufficientPermissions") {
        "Insufficient permission — this Google Drive account was connected read-only. \
         Reconnect it (remove + add again) to grant delete access. Note: files shared with \
         you but owned by someone else can't be deleted."
            .into()
    } else if e.contains("files.content.write") || e.contains("missing_scope") {
        "Dropbox delete needs the 'files.content.write' permission, which this Dropbox app \
         doesn't have yet. Open the Dropbox App Console (dropbox.com/developers/apps) → your app \
         → Permissions, tick 'files.content.write' (and 'files.content.read'), click Submit, then \
         reconnect this account in FDM (remove + add again) so the new permission takes effect."
            .into()
    } else {
        e
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(account_fs("bogus").is_err());
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
}
