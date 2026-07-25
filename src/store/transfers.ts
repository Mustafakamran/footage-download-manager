import { create } from "zustand";
import {
  startDownload,
  startUpload,
  listJobs,
  cancelJob,
  clearFinishedJobs,
  type DownloadItem,
  type JobStatus,
} from "../lib/tauri/commands";
import { loadDlSettings, toDownloadConfig } from "../lib/dl-settings";
import { laneOf, type Lane } from "../lib/lane";
import { useHistory, type JobStats } from "./history";
import { useToasts } from "./toast";
import { useApp } from "./app";
import { useBrowse } from "./browse";
import { loadJson, loadRaw, saveJson, saveRaw } from "../lib/persisted";

const CONCURRENCY_KEY = "download_concurrency";
const SECONDARY_CONCURRENCY_KEY = "download_secondary_concurrency";
const QUEUE_KEY = "download_queue_v1";
const INFLIGHT_KEY = "download_inflight_v1";

/** Account id for generic HTTP(S) URL downloads (the secondary lane). */
export const HTTP_ACCOUNT_ID = "http";
/** Synthetic account for WeTransfer share links (fetched natively, secondary lane). */
export const WETRANSFER_ACCOUNT_ID = "wetransfer";
/** Synthetic account for Filemail share links (fetched natively, secondary lane). */
export const FILEMAIL_ACCOUNT_ID = "filemail";
/** Synthetic account for Frame.io public share links (fetched natively, secondary lane). */
export const FRAMEIO_ACCOUNT_ID = "frameio";
/** Synthetic account for BitTorrent (magnet / .torrent) via the rqbit engine. */
export const TORRENT_ACCOUNT_ID = "torrent";

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pumping = false;
// The 1s poll writes fresh byte counts to localStorage every tick while a
// download is active — a synchronous disk write (WebView2's store on Windows
// is LevelDB-backed) that can stall the main thread if it lands mid-scan by
// an AV product. Bytes-only updates are cosmetic resume precision, so they're
// throttled to every Nth tick; a real membership change (job started/finished)
// still persists immediately and resets the counter.
let inflightPersistTick = 0;
const INFLIGHT_PERSIST_EVERY_N_TICKS = 3;
/** Rolling window length (in 1s ticks) kept per job for the live speed graph. */
const SPEED_HISTORY_LENGTH = 40;
let seq = 0;
const nextId = () => `q${Date.now()}_${++seq}`;
// Job ids paused by the user OR auto-paused by the lane gate — so refresh
// doesn't log them to history as "cancelled" (their partial file is kept and
// they resume from it).
const pausedJobIds = new Set<number>();
// Job ids the user deleted — hidden from the list and never recorded to history,
// even while the backend keeps returning them until it drops them.
const deletedJobIds = new Set<number>();
// Job ids we've already surfaced a failure toast for (avoid repeats while polling).
const failedToasted = new Set<number>();
// Upload job ids already toasted on finish, and ones dismissed from the strip
// (successful uploads auto-dismiss once toasted; failed ones dismiss manually).
const uploadToasted = new Set<number>();
const uploadDismissed = new Set<number>();

function loadConcurrency(): number {
  const n = parseInt(loadRaw(CONCURRENCY_KEY, "1"), 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function loadSecondaryConcurrency(): number {
  const n = parseInt(loadRaw(SECONDARY_CONCURRENCY_KEY, "3"), 10);
  return Number.isFinite(n) && n >= 1 ? n : 3;
}

/** Decoded last path segment of a URL; falls back to "download". */
export function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (last) return decodeURIComponent(last);
  } catch {
    // Not a parseable URL — fall through to a manual split.
    const cleaned = url.split(/[?#]/)[0];
    const segments = cleaned.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (last) {
      try {
        return decodeURIComponent(last);
      } catch {
        return last;
      }
    }
  }
  return "download";
}

/**
 * Route a pasted link to the right secondary-lane downloader. WeTransfer and
 * Filemail share pages aren't direct file URLs — plain HTTP would just fetch the
 * HTML — so they get a synthetic account whose Rust worker resolves the whole
 * transfer. Anything else is a generic direct-file HTTP download.
 */
export function classifyTransferUrl(url: string): { accountId: string; name: string } {
  // Magnet links have no host — route them to the torrent engine, naming the
  // job from the &dn= display-name when present.
  if (url.toLowerCase().startsWith("magnet:")) {
    let name = "Torrent";
    try {
      const q = url.indexOf("?");
      if (q >= 0) name = new URLSearchParams(url.slice(q + 1)).get("dn") || name;
    } catch {
      /* keep default */
    }
    return { accountId: TORRENT_ACCOUNT_ID, name };
  }
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = url.toLowerCase();
  }
  if (host === "we.tl" || host === "wetransfer.com" || host.endsWith(".wetransfer.com")) {
    return { accountId: WETRANSFER_ACCOUNT_ID, name: "WeTransfer transfer" };
  }
  if (host === "filemail.com" || host.endsWith(".filemail.com")) {
    return { accountId: FILEMAIL_ACCOUNT_ID, name: "Filemail transfer" };
  }
  if (host === "frame.io" || host.endsWith(".frame.io") || host === "f.io") {
    return { accountId: FRAMEIO_ACCOUNT_ID, name: "Frame.io share" };
  }
  return { accountId: HTTP_ACCOUNT_ID, name: filenameFromUrl(url) };
}

/** A download waiting in the queue (no rclone job yet). */
export interface QueueItem {
  id: string;
  accountId: string;
  item: DownloadItem;
  dest: string;
  /** Derived scheduling lane (re-derivable from accountId; cached for the UI). */
  lane: Lane;
  /** Bytes already on disk from a prior, interrupted run (for "resuming" UI). */
  resumedBytes?: number;
  /** User-paused: kept in the queue but NEVER auto-started until resumed. */
  paused?: boolean;
  /**
   * Auto-paused by the lane gate (primary lane busy). Distinct from `paused`:
   * an auto-paused item resumes automatically when the primary lane drains; a
   * user-paused one never does.
   */
  autoPaused?: boolean;
}

/** A started download we track so it survives an app restart and can resume. */
export interface InflightItem extends QueueItem {
  jobId: number;
  bytes: number;
  /**
   * Stats accumulated from the 1s poll speed samples while in flight. Folded
   * into the history entry on finish (see refresh()). Optional so persisted
   * pre-stats in-flight items still validate after an upgrade.
   */
  stats?: JobStats;
}

/**
 * Fold one poll speed sample into a job's accumulated stats. Pure (timestamp
 * passed in) so it can be unit-tested.
 *
 * - startedAt is set on the FIRST observation and never moves.
 * - peakSpeed tracks the max sample; minSpeed the min of NON-ZERO samples
 *   (a 0 sample is a stall/ramp, not a meaningful floor).
 * - lastAt records the most recent observation (a finish-time fallback).
 */
export function accrueStats(prev: JobStats | undefined, speed: number, at: number): JobStats {
  const startedAt = prev?.startedAt ?? at;
  const peakSpeed = Math.max(prev?.peakSpeed ?? 0, speed > 0 ? speed : 0);
  const minSpeed =
    speed > 0 ? (prev?.minSpeed != null ? Math.min(prev.minSpeed, speed) : speed) : prev?.minSpeed;
  return { startedAt, peakSpeed, minSpeed, lastAt: at };
}

function readJson<T>(key: string): T[] {
  const v = loadJson<unknown>(key, []);
  return Array.isArray(v) ? (v as T[]) : [];
}
const writeJson = (key: string, value: unknown) => saveJson(key, value);

/** Ensure a (possibly persisted) queue item has its derived lane tagged. */
function withLane<T extends { accountId: string; lane?: Lane }>(q: T): T & { lane: Lane } {
  return { ...q, lane: laneOf(q.accountId) };
}

/**
 * Restore persisted work. Anything that was *in flight* when the app died is
 * brought back to the front of the queue (its rclone/native job is gone, but the
 * partially-downloaded files are on disk — re-running skips/continues them).
 *
 * `autoPaused` is preserved so a relaunch mid-gate restores the gated state and
 * doesn't auto-start a secondary download while primary still has work.
 */
function restoreQueue(): QueueItem[] {
  const inflight = readJson<InflightItem>(INFLIGHT_KEY);
  const queued = readJson<QueueItem>(QUEUE_KEY);
  const resumed: QueueItem[] = inflight.map((f) =>
    withLane({
      id: f.id,
      accountId: f.accountId,
      item: f.item,
      dest: f.dest,
      resumedBytes: f.bytes,
      paused: f.paused,
      autoPaused: f.autoPaused,
    }),
  );
  const merged = [...resumed, ...queued.map(withLane)];
  writeJson(INFLIGHT_KEY, []);
  writeJson(QUEUE_KEY, merged);
  return merged;
}

/**
 * Whether two job lists are UI-equivalent: same length and, pairwise, identical
 * in the fields that actually drive the downloads UI. Used by refresh() to skip
 * a redundant set()/localStorage write on idle ticks where listJobs() returns
 * byte-for-byte the same data — the common case once everything has finished.
 */
export function jobsEqual(a: JobStatus[], b: JobStatus[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.jobId !== y.jobId ||
      x.bytes !== y.bytes ||
      x.totalBytes !== y.totalBytes ||
      x.speed !== y.speed ||
      x.finished !== y.finished ||
      x.success !== y.success ||
      x.cancelled !== y.cancelled ||
      x.error !== y.error
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Whether two in-flight lists are equivalent for persistence purposes: same
 * length and, pairwise, identical jobId + bytes (the only fields refresh()
 * mutates on a tick). Lets refresh() skip the INFLIGHT_KEY write when nothing
 * about the tracked set changed.
 */
export function inflightEqual(a: InflightItem[], b: InflightItem[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].jobId !== b[i].jobId || a[i].bytes !== b[i].bytes) return false;
  }
  return true;
}

/** Whether the tracked job set itself changed (ignoring bytes) — a start/finish. */
function inflightMembershipEqual(a: InflightItem[], b: InflightItem[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  const bIds = new Set(b.map((i) => i.jobId));
  return a.every((i) => bIds.has(i.jobId));
}

/** Active (in-flight) jobs for a lane, by their tracked items. */
function activeOfLane(inflight: InflightItem[], lane: Lane): InflightItem[] {
  return inflight.filter((i) => i.lane === lane);
}

/** Queued items that could start right now (not user-paused) for a lane. */
function startableQueued(queue: QueueItem[], lane: Lane): QueueItem[] {
  return queue.filter((q) => q.lane === lane && !q.paused);
}

/**
 * Whether there is real work that still needs the 1s poll loop running.
 *
 * An item counts as "needs polling" only if it is ACTIVE (in flight) or
 * STARTABLE-AND-NOT-AUTO-PAUSED. A persisted *auto-paused* secondary on its own
 * is NOT real work: it resumes automatically only once the primary lane drains,
 * and pump() handles that resume — so leaving it out lets a truly-idle app stop
 * polling instead of pinning the timer forever (autoPaused items have `paused`
 * falsy, so the old `!q.paused` test treated them as live work).
 */
export function needsPolling(queue: QueueItem[], inflight: InflightItem[]): boolean {
  if (inflight.length > 0) return true;
  return queue.some((q) => !q.paused && !q.autoPaused);
}

/**
 * Pure lane-scheduling decision. Given the current queue + in-flight set and
 * the per-lane concurrency limits, decide what should happen on this pump tick:
 *
 *  - `startPrimary`    — primary queue items to start now (front of queue first).
 *  - `autoPauseSecondary` — job ids of ACTIVE secondary downloads to preempt
 *                           (primary lane is busy).
 *  - `startSecondary`  — secondary queue items to start now (auto-paused first,
 *                        then plain queued), only when primary has drained.
 *
 * Rules (see docs/.../download-lane-isolation-design.md):
 *  1. Start startable primary up to primaryConcurrency.
 *  2. primaryBusy = any active primary OR any startable-queued primary.
 *  3. If primaryBusy: auto-pause every active secondary; start no secondary.
 *  4. Else: start secondary up to secondaryConcurrency (auto-paused resume first).
 */
export interface LaneDecision {
  startPrimary: QueueItem[];
  autoPauseSecondary: number[];
  startSecondary: QueueItem[];
}

export function decideLanes(
  queue: QueueItem[],
  inflight: InflightItem[],
  primaryConcurrency: number,
  secondaryConcurrency: number,
): LaneDecision {
  // (a) Start startable primary up to the primary limit.
  const activePrimary = activeOfLane(inflight, "primary");
  const primarySlots = Math.max(0, primaryConcurrency - activePrimary.length);
  const startablePrimary = startableQueued(queue, "primary");
  const startPrimary = startablePrimary.slice(0, primarySlots);

  // (b) primaryBusy = anything active in primary OR anything startable-queued
  //     in primary (including the items we're about to start).
  const primaryBusy = activePrimary.length > 0 || startablePrimary.length > 0;

  const activeSecondary = activeOfLane(inflight, "secondary");

  if (primaryBusy) {
    // (c) Preempt every active secondary; start no secondary.
    return {
      startPrimary,
      autoPauseSecondary: activeSecondary.map((i) => i.jobId),
      startSecondary: [],
    };
  }

  // (d) Primary lane drained — resume auto-paused secondary first, then plain
  //     queued, up to the secondary limit.
  const secondarySlots = Math.max(0, secondaryConcurrency - activeSecondary.length);
  const startableSecondary = startableQueued(queue, "secondary");
  const autoPausedFirst = [
    ...startableSecondary.filter((q) => q.autoPaused),
    ...startableSecondary.filter((q) => !q.autoPaused),
  ];
  return {
    startPrimary,
    autoPauseSecondary: [],
    startSecondary: autoPausedFirst.slice(0, secondarySlots),
  };
}

interface TransfersState {
  jobs: JobStatus[];
  /** Live upload jobs (rclone async, local → cloud). Not queued/persisted:
   *  they start immediately and don't survive a restart (re-upload is cheap). */
  uploads: JobStatus[];
  queue: QueueItem[];
  inflight: InflightItem[];
  /**
   * Rolling window of recent speed samples per jobId, for the live per-download
   * graph. Purely in-memory (not persisted) — it's a "right now" visualization,
   * not state that needs to survive a restart.
   */
  speedHistory: Record<number, number[]>;
  concurrency: number;
  secondaryConcurrency: number;
  dockOpen: boolean;
  /** True while an in-app file/folder drag is in flight — reveals the Transfers
   *  drawer as a drop-to-download target even when it's otherwise empty. */
  dragActive: boolean;

  setDragActive: (active: boolean) => void;
  setDockOpen: (open: boolean) => void;
  setConcurrency: (n: number) => void;
  setSecondaryConcurrency: (n: number) => void;
  /** Add items to the back of the queue; they start as slots free up. */
  enqueue: (accountId: string, items: DownloadItem[], dest: string) => void;
  /** Enqueue a generic HTTP(S) URL download (secondary lane). */
  enqueueUrl: (url: string, dest: string, quality?: string) => void;
  /** Queue a BitTorrent download from a local `.torrent` file path. */
  enqueueTorrentFile: (path: string, dest: string) => void;
  /** Upload local files/folders (absolute paths) into a remote folder. */
  startUploads: (accountId: string, paths: string[], destPath: string) => Promise<void>;
  /** Drop one upload from the strip (failed/cancelled entries linger until dismissed). */
  dismissUpload: (jobId: number) => void;
  removeQueued: (id: string) => void;
  refresh: () => Promise<void>;
  cancel: (jobId: number) => Promise<void>;
  /** Pause an active job: stop it but keep the partial file + requeue (paused). */
  pause: (jobId: number) => Promise<void>;
  /** Resume a paused queue item (it continues from its partial file). */
  resumePaused: (id: string) => void;
  /** Start a queued item immediately, in parallel — bypasses the concurrency gate. */
  forceStart: (id: string) => Promise<void>;
  /** Fully remove a job (active or finished): stop it and drop it from the list
   *  and history entirely (unlike cancel, which keeps a cancelled record). */
  deleteJob: (jobId: number) => Promise<void>;
  clearFinished: () => Promise<void>;
  pump: () => Promise<void>;
  /** Restart polling + resume persisted work (call once on app launch). */
  resume: () => void;
  ensurePolling: () => void;
  stopPolling: () => void;
}

export const useTransfers = create<TransfersState>((set, get) => ({
  jobs: [],
  uploads: [],
  queue: restoreQueue(),
  inflight: [],
  speedHistory: {},
  concurrency: loadConcurrency(),
  secondaryConcurrency: loadSecondaryConcurrency(),
  dockOpen: true,
  dragActive: false,

  setDragActive: (active) => set({ dragActive: active }),

  setDockOpen: (dockOpen) => set({ dockOpen }),

  setConcurrency: (n) => {
    const concurrency = Math.max(1, Math.floor(n) || 1);
    saveRaw(CONCURRENCY_KEY, String(concurrency));
    set({ concurrency });
    void get().pump();
  },

  setSecondaryConcurrency: (n) => {
    const secondaryConcurrency = Math.max(1, Math.floor(n) || 1);
    saveRaw(SECONDARY_CONCURRENCY_KEY, String(secondaryConcurrency));
    set({ secondaryConcurrency });
    void get().pump();
  },

  enqueue: (accountId, items, dest) => {
    const q = items.map((item) => withLane({ id: nextId(), accountId, item, dest }));
    const queue = [...get().queue, ...q];
    writeJson(QUEUE_KEY, queue);
    set({ queue, dockOpen: true });
    get().ensurePolling();
    void get().pump();
  },

  enqueueUrl: (url, dest, quality) => {
    const { accountId, name } = classifyTransferUrl(url);
    const item: DownloadItem = {
      path: "",
      name,
      isDir: false,
      size: 0,
      id: url,
    };
    // Frame.io downloads carry the originals-vs-proxy choice as a header the
    // native resolver reads (see frameio.rs). Only meaningful for Frame.io.
    if (quality && accountId === FRAMEIO_ACCOUNT_ID) {
      item.headers = { "x-fdm-frameio-quality": quality };
    }
    get().enqueue(accountId, [item], dest);
  },

  enqueueTorrentFile: (path, dest) => {
    const name = path.split(/[\\/]/).pop() || "torrent";
    const item: DownloadItem = { path: "", name, isDir: false, size: 0, id: path };
    get().enqueue(TORRENT_ACCOUNT_ID, [item], dest);
  },

  startUploads: async (accountId, paths, destPath) => {
    try {
      const created = await startUpload(accountId, paths, destPath);
      set({ uploads: [...get().uploads, ...created] });
      useToasts.getState().push(
        `Uploading ${created.length} item${created.length === 1 ? "" : "s"}`,
        "success",
      );
      get().ensurePolling();
    } catch (e) {
      useToasts.getState().push(`Upload failed to start: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  },

  dismissUpload: (jobId) => {
    uploadDismissed.add(jobId);
    set({ uploads: get().uploads.filter((u) => u.jobId !== jobId) });
  },

  removeQueued: (id) => {
    const queue = get().queue.filter((q) => q.id !== id);
    writeJson(QUEUE_KEY, queue);
    set({ queue });
  },

  forceStart: async (id) => {
    const q = get().queue.find((x) => x.id === id);
    if (!q) return;
    // Pull it out of the queue and launch it now, regardless of the lane's
    // concurrency limit (so it runs alongside whatever is already active).
    const remaining = get().queue.filter((x) => x.id !== id);
    writeJson(QUEUE_KEY, remaining);
    set({ queue: remaining });
    try {
      const created = await startDownload(q.accountId, [q.item], q.dest, toDownloadConfig(loadDlSettings()));
      const job = created[0];
      if (job) {
        const inf: InflightItem = { ...q, autoPaused: false, jobId: job.jobId, bytes: 0 };
        const nextInflight = [...get().inflight, inf];
        writeJson(INFLIGHT_KEY, nextInflight);
        inflightPersistTick = 0;
        set((s) => ({ inflight: nextInflight, jobs: [...s.jobs, job] }));
        get().ensurePolling();
      }
    } catch {
      // Launch failed — put it back at the front of the queue.
      set((s) => ({ queue: [q, ...s.queue] }));
    }
  },

  deleteJob: async (jobId) => {
    deletedJobIds.add(jobId);
    pausedJobIds.delete(jobId);
    try {
      await cancelJob(jobId);
    } catch {
      /* already finished/gone — nothing to stop */
    }
    const inflight = get().inflight.filter((i) => i.jobId !== jobId);
    writeJson(INFLIGHT_KEY, inflight);
    set((s) => ({
      jobs: s.jobs.filter((j) => j.jobId !== jobId),
      uploads: s.uploads.filter((u) => u.jobId !== jobId),
      inflight,
    }));
    useHistory.getState().removeEntry(jobId);
  },

  pump: async () => {
    if (pumping) return;
    pumping = true;
    try {
      // Loop until a tick produces no further action. Each iteration: compute
      // the lane decision, start startable primary, gate/preempt secondary, and
      // (when primary has drained) start secondary.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { queue, inflight, concurrency, secondaryConcurrency } = get();
        const decision = decideLanes(queue, inflight, concurrency, secondaryConcurrency);

        // (c) Preempt active secondary — mirror the user pause() path so the
        // partial is kept and refresh() doesn't log a cancellation.
        if (decision.autoPauseSecondary.length > 0) {
          for (const jobId of decision.autoPauseSecondary) {
            await autoPauseSecondaryJob(get, set, jobId);
          }
          continue; // re-evaluate with the secondary lane now idle
        }

        const next = decision.startPrimary[0] ?? decision.startSecondary[0];
        if (!next) break;

        // Clear an auto-pause flag on a secondary we're about to resume so it no
        // longer shows the gated state, and so refresh() reflects the change.
        const remaining = get().queue.filter((q) => q.id !== next.id);
        writeJson(QUEUE_KEY, remaining);
        set({ queue: remaining });
        try {
          const created = await startDownload(
            next.accountId,
            [next.item],
            next.dest,
            toDownloadConfig(loadDlSettings()),
          );
          const job = created[0];
          if (job) {
            const inf: InflightItem = {
              ...next,
              autoPaused: false,
              jobId: job.jobId,
              bytes: 0,
            };
            const nextInflight = [...get().inflight, inf];
            writeJson(INFLIGHT_KEY, nextInflight);
            inflightPersistTick = 0;
            set((s) => ({ inflight: nextInflight, jobs: [...s.jobs, job] }));
          }
        } catch {
          /* a failed launch is dropped; the rest of the queue continues */
        }
      }
    } finally {
      pumping = false;
    }
  },

  refresh: async () => {
    const polled = await listJobs();
    // Uploads share the poll but none of the download machinery (no queue,
    // lanes, or resume). Toast once on finish; finished uploads (success OR
    // failure) stay listed for the Uploads screen until the user dismisses them.
    // The in-browser strip separately hides completed successes to stay clean.
    const uploads: JobStatus[] = [];
    for (const u of polled) {
      if (u.kind !== "upload") continue;
      if (u.finished && !uploadToasted.has(u.jobId)) {
        uploadToasted.add(u.jobId);
        if (u.success) {
          useToasts.getState().push(`Upload complete · ${u.name}`, "success");
          // Refresh the destination folder's listing so the new file shows up
          // without a manual re-navigate (ensure() is cached + background).
          const acct = useApp.getState().accounts.find((a) => a.id === u.accountId);
          if (acct) void useBrowse.getState().ensure(acct, u.dest);
        } else if (!u.cancelled) {
          useToasts.getState().push(`Upload failed · ${u.name}: ${u.error || "unknown error"}`, "error");
        }
      }
      // Completed uploads stay in the list so the Uploads screen shows a full
      // record (like Downloads history); they leave only when dismissed.
      if (!uploadDismissed.has(u.jobId)) uploads.push(u);
    }
    if (!jobsEqual(uploads, get().uploads)) set({ uploads });

    // Jobs the user deleted are hidden and never recorded to history, even while
    // the backend still returns them (until it stops tracking them).
    const jobs = polled.filter((j) => j.kind !== "upload" && !deletedJobIds.has(j.jobId));
    // Record finished/cancelled jobs to history — except ones the user paused
    // OR we auto-paused (those are kept for resume, not logged as cancelled).
    // Surface real failure reasons as a toast so downloads never fail silently.
    // These are idempotent (history.record + the failedToasted set guard against
    // repeats), so they run every tick regardless of the no-op short-circuit.
    for (const j of jobs) {
      if ((j.finished || j.cancelled) && !pausedJobIds.has(j.jobId)) {
        const inf = get().inflight.find((i) => i.jobId === j.jobId);
        // Fold the final sample in too so a job that finishes between ticks
        // still has a startedAt/lastAt even if it was never seen mid-flight.
        const stats = accrueStats(inf?.stats, j.speed, Date.now());
        useHistory.getState().record(j, inf?.item, stats);
      }
      if (j.finished && !j.success && !j.cancelled && !failedToasted.has(j.jobId)) {
        failedToasted.add(j.jobId);
        useToasts.getState().push(`Download failed · ${j.name}: ${j.error || "unknown error"}`, "error");
      }
    }

    // No-op short-circuit: only push new job state when it actually differs from
    // what the UI already has. On an idle tick listJobs() returns byte-for-byte
    // the same data, so skipping the set() avoids a needless re-render of every
    // subscriber, and skipping the localStorage write avoids a 1Hz sync write.
    if (!jobsEqual(jobs, get().jobs)) set({ jobs });

    // Reconcile persisted in-flight set against live jobs: drop finished/cancelled
    // (and jobs that vanished), update live bytes + accrue speed stats for the rest.
    const now = Date.now();
    const stillInflight: InflightItem[] = [];
    for (const inf of get().inflight) {
      const job = jobs.find((j) => j.jobId === inf.jobId);
      if (!job) continue; // cleared from tracking
      if (job.finished || job.cancelled) continue; // done — leaves the in-flight set
      stillInflight.push({ ...inf, bytes: job.bytes, stats: accrueStats(inf.stats, job.speed, now) });
    }

    // Live per-download speed graph: a fixed-size rolling sample buffer per
    // jobId, refreshed every tick regardless of the throttling below — it's
    // pure in-memory state (never persisted), so there's no disk-write cost,
    // only a render cost, and only a component that actually reads
    // speedHistory[jobId] (the open detail panel) re-renders on it.
    const prevHistory = get().speedHistory;
    if (stillInflight.length > 0 || Object.keys(prevHistory).length > 0) {
      const nextHistory: Record<number, number[]> = {};
      for (const inf of stillInflight) {
        const job = jobs.find((j) => j.jobId === inf.jobId)!;
        const prev = prevHistory[inf.jobId] ?? [];
        nextHistory[inf.jobId] = [...prev, Math.max(0, job.speed)].slice(-SPEED_HISTORY_LENGTH);
      }
      set({ speedHistory: nextHistory });
    }
    // Short-circuit on a byte-for-byte idle tick: skip BOTH the localStorage
    // write and the in-memory set() (per inflightEqual, which compares jobId +
    // bytes). The stats we accrue here only ever change peak/min when bytes
    // advance (a non-zero speed sample), so an idle tick has nothing new to
    // commit — and committing would needlessly re-render every subscriber and
    // break the no-op invariant. The finish-time record() folds in one final
    // fresh sample, so the last-committed stats are all it needs.
    if (!inflightEqual(stillInflight, get().inflight)) {
      const membershipChanged = !inflightMembershipEqual(stillInflight, get().inflight);
      set({ inflight: stillInflight });
      if (membershipChanged) {
        writeJson(INFLIGHT_KEY, stillInflight);
        inflightPersistTick = 0;
      } else if (++inflightPersistTick >= INFLIGHT_PERSIST_EVERY_N_TICKS) {
        writeJson(INFLIGHT_KEY, stillInflight);
        inflightPersistTick = 0;
      }
    }

    // pump() drives auto-resume: when the primary lane has drained it clears
    // autoPaused on gated secondary and restarts them.
    await get().pump();
    const { inflight: inflightAfter, queue: queueAfter, uploads: uploadsAfter } = get();
    const uploadsActive = uploadsAfter.some((u) => !u.finished && !u.cancelled);
    if (!needsPolling(queueAfter, inflightAfter) && !uploadsActive) get().stopPolling();
  },

  cancel: async (jobId) => {
    await cancelJob(jobId);
    await get().refresh();
  },

  pause: async (jobId) => {
    const inf = get().inflight.find((i) => i.jobId === jobId);
    if (!inf) return;
    pausedJobIds.add(jobId);
    await cancelJob(jobId); // worker sees the flag and stops, leaving the .fdmpart
    const paused: QueueItem = withLane({
      id: inf.id,
      accountId: inf.accountId,
      item: inf.item,
      dest: inf.dest,
      paused: true,
      resumedBytes: inf.bytes,
    });
    const queue = [paused, ...get().queue];
    const inflight = get().inflight.filter((i) => i.jobId !== jobId);
    writeJson(QUEUE_KEY, queue);
    writeJson(INFLIGHT_KEY, inflight);
    inflightPersistTick = 0;
    set({ queue, inflight });
    // Drop the now-stopped job from backend tracking so it leaves the live list.
    await clearFinishedJobs().catch(() => {});
    void get().pump(); // a freed slot may let another queued item start
  },

  resumePaused: (id) => {
    const queue = get().queue.map((q) => (q.id === id ? { ...q, paused: false } : q));
    writeJson(QUEUE_KEY, queue);
    set({ queue });
    get().ensurePolling();
    void get().pump();
  },

  clearFinished: async () => {
    await clearFinishedJobs();
    await get().refresh();
  },

  resume: () => {
    if (!get().queue.some((q) => !q.paused)) return; // nothing startable
    get().ensurePolling();
    void get().pump();
  },

  ensurePolling: () => {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      get()
        .refresh()
        .catch(() => {});
    }, 1000);
  },

  stopPolling: () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  },
}));

/**
 * Auto-pause a single ACTIVE secondary job. Mirrors the user `pause()` path so
 * the engine keeps the `.fdmpart` and `refresh()` won't log a cancellation —
 * but tags the requeued item `autoPaused: true` (not `paused`) so it resumes
 * automatically once the primary lane drains.
 */
async function autoPauseSecondaryJob(
  get: () => TransfersState,
  set: (partial: Partial<TransfersState>) => void,
  jobId: number,
): Promise<void> {
  const inf = get().inflight.find((i) => i.jobId === jobId);
  if (!inf) return;
  pausedJobIds.add(jobId);
  await cancelJob(jobId); // worker sees the flag and stops, leaving the .fdmpart
  const gated: QueueItem = withLane({
    id: inf.id,
    accountId: inf.accountId,
    item: inf.item,
    dest: inf.dest,
    autoPaused: true,
    resumedBytes: inf.bytes,
  });
  const queue = [gated, ...get().queue];
  const inflight = get().inflight.filter((i) => i.jobId !== jobId);
  writeJson(QUEUE_KEY, queue);
  writeJson(INFLIGHT_KEY, inflight);
  inflightPersistTick = 0;
  set({ queue, inflight });
  // Drop the now-stopped job from backend tracking so it leaves the live list.
  await clearFinishedJobs().catch(() => {});
}
