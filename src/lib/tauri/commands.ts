import { invoke } from "@tauri-apps/api/core";

export type Provider = "drive" | "dropbox";

export interface Account {
  /** rclone remote name; stable account id. */
  id: string;
  provider: Provider;
  /** Sanitized slug reconstructed from the remote name. */
  label: string;
}

/** List all configured accounts (rclone remotes). */
export function listAccounts(): Promise<Account[]> {
  return invoke<Account[]>("list_accounts");
}

/**
 * Add an account via the rclone OAuth flow. Long-running: opens a browser for
 * consent and may take minutes. Tauri maps these camelCase keys to the Rust
 * snake_case params (client_id / client_secret).
 */
export function addAccount(
  provider: Provider,
  label: string,
  clientId: string,
  clientSecret: string,
): Promise<Account> {
  return invoke<Account>("add_account", { provider, label, clientId, clientSecret });
}

/** Remove an account (deletes its rclone remote). */
export function removeAccount(id: string): Promise<void> {
  return invoke("remove_account", { id });
}

/** Store an OAuth app credential in the OS keychain. */
export function setSecret(key: string, value: string): Promise<void> {
  return invoke("set_secret", { key, value });
}

/** Read an OAuth app credential from the OS keychain (null if absent). */
export function getSecret(key: string): Promise<string | null> {
  return invoke<string | null>("get_secret", { key });
}

/** Delete an OAuth app credential from the OS keychain. */
export function deleteSecret(key: string): Promise<void> {
  return invoke("delete_secret", { key });
}

/** Keychain key names for the per-provider OAuth app credentials. */
export const SECRET_KEYS = {
  drive: { id: "google_client_id", secret: "google_client_secret" },
  dropbox: { id: "dropbox_app_key", secret: "dropbox_app_secret" },
} as const;

/** An item to download. */
export interface DownloadItem {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  /** Backend file id — needed to stream/resume a single Drive file. */
  id?: string;
  /**
   * Extra request headers for the streaming HTTP downloader (e.g. Referer,
   * Cookie, User-Agent) so cookie/referer-gated direct downloads succeed. Maps to
   * the Rust `DownloadItem.headers` field (#[serde(default)]).
   */
  headers?: Record<string, string>;
}

/** Live status of a download job. */
export interface JobStatus {
  jobId: number;
  accountId: string;
  name: string;
  dest: string;
  totalBytes: number;
  bytes: number;
  speed: number;
  eta: number | null;
  finished: boolean;
  success: boolean;
  cancelled: boolean;
  error: string;
}

/** Start downloads for the selected items into `dest`; returns the new jobs. */
export function startDownload(
  accountId: string,
  items: DownloadItem[],
  dest: string,
  config?: Record<string, unknown>,
): Promise<JobStatus[]> {
  return invoke<JobStatus[]>("start_download", { accountId, items, dest, config });
}

/** Poll live status of all tracked jobs. */
export function listJobs(): Promise<JobStatus[]> {
  return invoke<JobStatus[]>("list_jobs");
}

/** Cancel a running job. */
export function cancelJob(jobId: number): Promise<void> {
  return invoke("cancel_job", { jobId });
}

/** Drop finished/cancelled jobs from tracking. */
export function clearFinishedJobs(): Promise<void> {
  return invoke("clear_finished_jobs");
}

/** Resolve a Drive file/folder's uploader (owner / last modifier) display name. */
export function driveUploader(accountId: string, fileId: string): Promise<string | null> {
  return invoke<string | null>("drive_uploader", { accountId, fileId });
}

/** The signed-in account's email (Drive about / Dropbox userinfo); null if unavailable. */
export function accountEmail(accountId: string): Promise<string | null> {
  return invoke<string | null>("account_email", { accountId });
}

/** Add a Google Drive shared-folder link as a browseable account (root-folder-id). */
export function addDriveLink(baseAccountId: string, label: string, folderId: string): Promise<Account> {
  return invoke<Account>("add_drive_link", { baseAccountId, label, folderId });
}

/**
 * Add a Dropbox shared-folder link as a browseable account. No rclone remote —
 * it lists/downloads via the native Dropbox API, borrowing a connected Dropbox
 * account's token. Nothing is copied into your own Dropbox.
 */
export function addDropboxLink(baseAccountId: string, label: string, url: string): Promise<Account> {
  return invoke<Account>("add_dropbox_link", { baseAccountId, label, url });
}

/** Base URL of the loopback streaming proxy (review player). Append `/media?…`. */
export function streamBase(): Promise<string> {
  return invoke<string>("stream_base");
}

/**
 * Decide how the review player should source a clip given its `sourceParams`
 * query string: "direct" (already-playable H.264/AAC → no transcode, instant) or
 * "hls" (needs the JIT transcoder). Probes the codec server-side; falls back to
 * "hls" on any error.
 */
export function streamMode(query: string): Promise<"direct" | "hls"> {
  return invoke<"direct" | "hls">("stream_mode", { query });
}

/**
 * The persistent pairing token for the browser extension's loopback ingest.
 * Generated on first call (stored in app config / keychain) and stable after.
 * The extension sends it as the `X-FDM-Token` header on `POST /fdm/ingest`.
 */
export function ingestToken(): Promise<string> {
  return invoke<string>("ingest_token");
}

/**
 * Stage the bundled browser extension into a stable, user-writable folder and
 * return its absolute path. The in-bundle resource dir is read-only/hidden, so we
 * copy it out before pointing Chrome's "Load unpacked" at it.
 */
export function prepareExtension(): Promise<string> {
  return invoke<string>("prepare_extension");
}

/** Reveal a folder in the OS file manager (Finder / Explorer). */
export function revealPath(path: string): Promise<void> {
  return invoke("reveal_path", { path });
}

/** Write base64-encoded bytes to a path on disk (used to save an exported PDF). */
export function writeBinaryFile(path: string, base64: string): Promise<void> {
  return invoke("write_binary_file", { path, base64 });
}

/** Bilal-Drive-Man sync-agent config. */
export interface BdmConfig {
  enabled: boolean;
  portalUrl: string;
  machine: string;
  destRoot: string;
  hasKey: boolean;
  status: string;
}

export function bdmGetConfig(): Promise<BdmConfig> {
  return invoke<BdmConfig>("bdm_get_config");
}

/** Save BDM sync config; apiKey is stored in the OS keychain (omit to keep existing). */
export function bdmSetConfig(
  enabled: boolean,
  portalUrl: string,
  machine: string,
  destRoot: string,
  apiKey?: string,
): Promise<void> {
  return invoke("bdm_set_config", { enabled, portalUrl, machine, destRoot, apiKey });
}
