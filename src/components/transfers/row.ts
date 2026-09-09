// Unified row model for the torrent-style transfer table. Active jobs, queued
// items, and history entries all collapse to one `TransferRow` shape so a single
// table can list every transfer regardless of state (like a torrent client).

import type { JobStatus, DownloadItem } from "../../lib/tauri/commands";
import type { QueueItem, BlockKind } from "../../store/transfers";
import type { HistoryEntry } from "../../store/history";
import { laneOf } from "../../lib/lane";

export type TransferState =
  | "downloading"
  | "uploading"
  | "queued"
  | "paused"
  | "gated"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export interface TransferRow {
  /** Stable per-row id (job/queue/history keyed) for React + selection. */
  id: string;
  jobId?: number;
  queueId?: string;
  name: string;
  /** Best-known total size in bytes. */
  size: number;
  bytes: number;
  speed: number;
  eta: number | null;
  /** 0..100. */
  pct: number;
  state: TransferState;
  accountId: string;
  dest: string;
  /** Source column: the actual path within the account for Drive/Dropbox; the
   *  account label for web/torrent/uploads. */
  source: string;
  /** Account display label (shown in the info panel alongside the source path). */
  account: string;
  error?: string;
  /** Recoverable-failure class on a blocked row (drives the fix hint). */
  blockedKind?: BlockKind;
  /** A blocked transfer scheduled for automatic retry (transient failures). */
  autoRetry?: boolean;
  /** Live connected-peer count for torrent rows (-1/undefined = n/a). */
  peers?: number;
  /** Finished-at timestamp (history rows). */
  at?: number;
  /** Present on failed rows so the panel/actions can re-enqueue. */
  item?: DownloadItem;
  /** True for upload transfers — routes dismiss to the uploads store. */
  upload?: boolean;
  // --- Final stats, carried on finished (history) rows so the info panel keeps
  //     showing avg/peak/elapsed after the live job (and its in-flight stats)
  //     are gone. Absent on live/queued rows (which read live stats instead). ---
  /** Average speed over the whole transfer (bytes/s). */
  avgSpeed?: number;
  /** Peak observed speed (bytes/s). */
  peakSpeed?: number;
  /** Lowest observed non-zero speed (bytes/s). */
  minSpeed?: number;
  /** Wall-clock duration in ms. */
  durationMs?: number;
}

export type LabelOf = (accountId: string) => string;

const jobPct = (bytes: number, total: number) =>
  total > 0 ? Math.min(100, Math.round((bytes / total) * 100)) : 0;

/**
 * The Source cell: for Drive/Dropbox (primary lane) show the actual path of the
 * file/folder within the account; for web/torrent/uploads the account label is
 * enough (there's no cloud path).
 */
function sourceLabel(accountId: string, item: DownloadItem | undefined, labelOf: LabelOf): string {
  if (item && item.path && laneOf(accountId) === "primary") return item.path;
  return labelOf(accountId);
}

/** A live download/upload job. `item` (the inflight source item) supplies the
 *  cloud path for the Source cell when known. */
export function jobRow(j: JobStatus, labelOf: LabelOf, item?: DownloadItem): TransferRow {
  return {
    id: `j${j.jobId}`,
    jobId: j.jobId,
    name: j.name,
    size: j.totalBytes || j.bytes,
    bytes: j.bytes,
    speed: j.speed,
    eta: j.eta,
    pct: jobPct(j.bytes, j.totalBytes),
    state: j.kind === "upload" ? "uploading" : "downloading",
    accountId: j.accountId,
    dest: j.dest,
    source: sourceLabel(j.accountId, item, labelOf),
    account: labelOf(j.accountId),
    upload: j.kind === "upload",
    peers: j.peers,
  };
}

/** A queued (not-yet-started) download. `gated` = waiting on the primary lane. */
export function queueRow(q: QueueItem, position: number, labelOf: LabelOf): TransferRow {
  const gated = !!q.autoPaused && !q.paused;
  return {
    id: q.id,
    queueId: q.id,
    name: q.item.name,
    size: q.item.size ?? 0,
    bytes: q.resumedBytes ?? 0,
    speed: 0,
    eta: null,
    pct: q.item.size ? jobPct(q.resumedBytes ?? 0, q.item.size) : 0,
    state: q.blocked ? "blocked" : gated ? "gated" : q.paused ? "paused" : "queued",
    accountId: q.accountId,
    dest: q.dest,
    source: sourceLabel(q.accountId, q.item, labelOf),
    account: `${labelOf(q.accountId)} · #${position}`,
    item: q.item,
    error: q.blockedError,
    blockedKind: q.blockedKind,
    autoRetry: !!q.nextRetryAt,
  };
}

/** A finished/failed/cancelled transfer from history. */
export function historyRow(h: HistoryEntry, labelOf: LabelOf): TransferRow {
  const state: TransferState =
    h.status === "success" ? "completed" : h.status === "cancelled" ? "cancelled" : "failed";
  const done = h.status === "success";
  return {
    id: h.id ? `h${h.id}` : `h${h.jobId}`,
    jobId: h.jobId,
    name: h.name,
    size: h.size,
    // A successful transfer has all its bytes; a failed/cancelled one only got
    // as far as its recorded size (which for those is the last-seen byte count).
    bytes: h.size,
    speed: 0,
    eta: null,
    pct: done ? 100 : 0,
    state,
    accountId: h.accountId,
    dest: h.dest,
    source: sourceLabel(h.accountId, h.item, labelOf),
    account: labelOf(h.accountId),
    error: h.error,
    at: h.at,
    item: h.item,
    avgSpeed: h.avgSpeed,
    peakSpeed: h.maxSpeed,
    minSpeed: h.minSpeed,
    durationMs: h.durationMs,
  };
}

/** A finished/failed/cancelled upload (uploads carry their own final JobStatus). */
export function uploadHistoryRow(u: JobStatus, labelOf: LabelOf): TransferRow {
  const state: TransferState = u.success ? "completed" : u.cancelled ? "cancelled" : "failed";
  return {
    id: `u${u.jobId}`,
    jobId: u.jobId,
    name: u.name,
    size: u.totalBytes || u.bytes,
    bytes: u.bytes,
    speed: 0,
    eta: null,
    pct: 100,
    state,
    accountId: u.accountId,
    dest: u.dest,
    source: labelOf(u.accountId),
    account: labelOf(u.accountId),
    error: u.error,
    upload: true,
  };
}
