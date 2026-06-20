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
use std::sync::Mutex;

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
#[tauri::command]
pub fn start_download(
    rclone: tauri::State<RcloneState>,
    jobs_state: tauri::State<JobsState>,
    account_id: String,
    items: Vec<DownloadItem>,
    dest: String,
    config: Option<Value>,
) -> Result<Vec<JobStatus>, String> {
    let conn = connection(&rclone)?;
    let fs = account_fs(&account_id)?;
    let mut created = Vec::new();

    for item in &items {
        let (endpoint, mut params) = build_copy(&fs, item, &dest);
        // Apply per-download tuning (Transfers, MultiThreadStreams, BwLimit, …)
        // as an rclone rc `_config` override.
        if let Some(cfg) = &config {
            if let Some(obj) = params.as_object_mut() {
                obj.insert("_config".to_string(), cfg.clone());
            }
        }
        let resp = rc_post(&conn, endpoint, &params)?;
        let job_id = resp
            .get("jobid")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| format!("no jobid in response: {resp}"))?;

        let job = Job {
            job_id,
            account_id: account_id.clone(),
            name: item.name.clone(),
            dest: dest.clone(),
            total_bytes: item.size.max(0),
            cancelled: false,
        };
        jobs_state.jobs.lock().unwrap_or_else(|e| e.into_inner()).push(job);
        created.push(status_for(
            job_id,
            &account_id,
            &item.name,
            &dest,
            item.size.max(0),
        ));
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

/// Poll live status for all tracked jobs (stats group + job status).
#[tauri::command]
pub fn list_jobs(
    rclone: tauri::State<RcloneState>,
    jobs_state: tauri::State<JobsState>,
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
    Ok(out)
}

/// Stop a running job and mark it cancelled.
#[tauri::command]
pub fn cancel_job(
    rclone: tauri::State<RcloneState>,
    jobs_state: tauri::State<JobsState>,
    job_id: i64,
) -> Result<(), String> {
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(path: &str, name: &str, is_dir: bool, size: i64) -> DownloadItem {
        DownloadItem { path: path.into(), name: name.into(), is_dir, size }
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
