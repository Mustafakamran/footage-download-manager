import { create } from "zustand";
import {
  startDownload,
  listJobs,
  cancelJob,
  clearFinishedJobs,
  type DownloadItem,
  type JobStatus,
} from "../lib/tauri/commands";
import { loadDlSettings, toDownloadConfig } from "../lib/dl-settings";
import { useHistory } from "./history";
import { useToasts } from "./toast";

const CONCURRENCY_KEY = "download_concurrency";
const QUEUE_KEY = "download_queue_v1";
const INFLIGHT_KEY = "download_inflight_v1";

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pumping = false;
let seq = 0;
const nextId = () => `q${Date.now()}_${++seq}`;
// Job ids paused by the user — so refresh doesn't log them to history as
// "cancelled" (their partial file is kept and they resume from it).
const pausedJobIds = new Set<number>();
// Job ids we've already surfaced a failure toast for (avoid repeats while polling).
const failedToasted = new Set<number>();

function loadConcurrency(): number {
  const n = parseInt(localStorage.getItem(CONCURRENCY_KEY) ?? "1", 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** A download waiting in the queue (no rclone job yet). */
export interface QueueItem {
  id: string;
  accountId: string;
  item: DownloadItem;
  dest: string;
  /** Bytes already on disk from a prior, interrupted run (for "resuming" UI). */
  resumedBytes?: number;
  /** User-paused: kept in the queue but not auto-started until resumed. */
  paused?: boolean;
}

/** A started download we track so it survives an app restart and can resume. */
interface InflightItem extends QueueItem {
  jobId: number;
  bytes: number;
}

function readJson<T>(key: string): T[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota */
  }
}

/**
 * Restore persisted work. Anything that was *in flight* when the app died is
 * brought back to the front of the queue (its rclone/native job is gone, but the
 * partially-downloaded files are on disk — re-running skips/continues them).
 */
function restoreQueue(): QueueItem[] {
  const inflight = readJson<InflightItem>(INFLIGHT_KEY);
  const queued = readJson<QueueItem>(QUEUE_KEY);
  const resumed: QueueItem[] = inflight.map((f) => ({
    id: f.id,
    accountId: f.accountId,
    item: f.item,
    dest: f.dest,
    resumedBytes: f.bytes,
  }));
  const merged = [...resumed, ...queued];
  writeJson(INFLIGHT_KEY, []);
  writeJson(QUEUE_KEY, merged);
  return merged;
}

interface TransfersState {
  jobs: JobStatus[];
  queue: QueueItem[];
  inflight: InflightItem[];
  concurrency: number;
  dockOpen: boolean;

  setDockOpen: (open: boolean) => void;
  setConcurrency: (n: number) => void;
  /** Add items to the back of the queue; they start as slots free up. */
  enqueue: (accountId: string, items: DownloadItem[], dest: string) => void;
  removeQueued: (id: string) => void;
  refresh: () => Promise<void>;
  cancel: (jobId: number) => Promise<void>;
  /** Pause an active job: stop it but keep the partial file + requeue (paused). */
  pause: (jobId: number) => Promise<void>;
  /** Resume a paused queue item (it continues from its partial file). */
  resumePaused: (id: string) => void;
  clearFinished: () => Promise<void>;
  pump: () => Promise<void>;
  /** Restart polling + resume persisted work (call once on app launch). */
  resume: () => void;
  ensurePolling: () => void;
  stopPolling: () => void;
}

export const useTransfers = create<TransfersState>((set, get) => ({
  jobs: [],
  queue: restoreQueue(),
  inflight: [],
  concurrency: loadConcurrency(),
  dockOpen: true,

  setDockOpen: (dockOpen) => set({ dockOpen }),

  setConcurrency: (n) => {
    const concurrency = Math.max(1, Math.floor(n) || 1);
    localStorage.setItem(CONCURRENCY_KEY, String(concurrency));
    set({ concurrency });
    void get().pump();
  },

  enqueue: (accountId, items, dest) => {
    const q = items.map((item) => ({ id: nextId(), accountId, item, dest }));
    const queue = [...get().queue, ...q];
    writeJson(QUEUE_KEY, queue);
    set({ queue, dockOpen: true });
    get().ensurePolling();
    void get().pump();
  },

  removeQueued: (id) => {
    const queue = get().queue.filter((q) => q.id !== id);
    writeJson(QUEUE_KEY, queue);
    set({ queue });
  },

  pump: async () => {
    if (pumping) return;
    pumping = true;
    try {
      // Start queued items (skipping paused ones) until the in-flight count
      // reaches the concurrency limit.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { queue, inflight, concurrency } = get();
        const startable = queue.filter((q) => !q.paused);
        if (inflight.length >= concurrency || startable.length === 0) break;
        const next = startable[0];
        const remaining = queue.filter((q) => q.id !== next.id);
        writeJson(QUEUE_KEY, remaining);
        set({ queue: remaining });
        try {
          const created = await startDownload(next.accountId, [next.item], next.dest, toDownloadConfig(loadDlSettings()));
          const job = created[0];
          if (job) {
            const inf: InflightItem = { ...next, jobId: job.jobId, bytes: 0 };
            const nextInflight = [...get().inflight, inf];
            writeJson(INFLIGHT_KEY, nextInflight);
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
    const jobs = await listJobs();
    set({ jobs });
    // Record finished/cancelled jobs to history — except ones the user paused
    // (those are kept for resume, not logged as cancelled). Surface real failure
    // reasons as a toast so downloads never fail silently.
    for (const j of jobs) {
      // Record finished/cancelled jobs to history (keep the source item on
      // failures so they can be resumed from the Failed tab). Skip user-paused.
      if ((j.finished || j.cancelled) && !pausedJobIds.has(j.jobId)) {
        const inf = get().inflight.find((i) => i.jobId === j.jobId);
        useHistory.getState().record(j, inf?.item);
      }
      if (j.finished && !j.success && !j.cancelled && !failedToasted.has(j.jobId)) {
        failedToasted.add(j.jobId);
        useToasts.getState().push(`Download failed · ${j.name}: ${j.error || "unknown error"}`, "error");
      }
    }

    // Reconcile persisted in-flight set against live jobs: drop finished/cancelled
    // (and jobs that vanished), update live bytes for the rest.
    const stillInflight: InflightItem[] = [];
    for (const inf of get().inflight) {
      const job = jobs.find((j) => j.jobId === inf.jobId);
      if (!job) continue; // cleared from tracking
      if (job.finished || job.cancelled) continue; // done — leaves the in-flight set
      stillInflight.push({ ...inf, bytes: job.bytes });
    }
    writeJson(INFLIGHT_KEY, stillInflight);
    set({ inflight: stillInflight });

    await get().pump();
    const busy = get().inflight.length > 0 || get().queue.some((q) => !q.paused);
    if (!busy) get().stopPolling();
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
    const paused: QueueItem = {
      id: inf.id,
      accountId: inf.accountId,
      item: inf.item,
      dest: inf.dest,
      paused: true,
      resumedBytes: inf.bytes,
    };
    const queue = [paused, ...get().queue];
    const inflight = get().inflight.filter((i) => i.jobId !== jobId);
    writeJson(QUEUE_KEY, queue);
    writeJson(INFLIGHT_KEY, inflight);
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
