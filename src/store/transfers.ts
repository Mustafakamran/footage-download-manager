import { create } from "zustand";
import {
  startDownload,
  listJobs,
  cancelJob,
  clearFinishedJobs,
  type DownloadItem,
  type JobStatus,
} from "../lib/tauri/commands";
import { loadPerf, toRcConfig } from "../lib/perf";

const CONCURRENCY_KEY = "download_concurrency";
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pumping = false;
let seq = 0;
const nextId = () => `q${++seq}`;

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
}

interface TransfersState {
  jobs: JobStatus[];
  queue: QueueItem[];
  concurrency: number;
  dockOpen: boolean;

  setDockOpen: (open: boolean) => void;
  setConcurrency: (n: number) => void;
  /** Add items to the back of the queue; they start as slots free up. */
  enqueue: (accountId: string, items: DownloadItem[], dest: string) => void;
  removeQueued: (id: string) => void;
  refresh: () => Promise<void>;
  cancel: (jobId: number) => Promise<void>;
  clearFinished: () => Promise<void>;
  pump: () => Promise<void>;
  ensurePolling: () => void;
  stopPolling: () => void;
}

export const useTransfers = create<TransfersState>((set, get) => ({
  jobs: [],
  queue: [],
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
    set((s) => ({ queue: [...s.queue, ...q], dockOpen: true }));
    get().ensurePolling();
    void get().pump();
  },

  removeQueued: (id) => set((s) => ({ queue: s.queue.filter((q) => q.id !== id) })),

  pump: async () => {
    if (pumping) return;
    pumping = true;
    try {
      // Start queued items until the active count reaches the concurrency limit.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { jobs, queue, concurrency } = get();
        const active = jobs.filter((j) => !j.finished && !j.cancelled).length;
        if (active >= concurrency || queue.length === 0) break;
        const next = queue[0];
        set((s) => ({ queue: s.queue.filter((q) => q.id !== next.id) }));
        try {
          const created = await startDownload(next.accountId, [next.item], next.dest, toRcConfig(loadPerf()));
          set((s) => ({ jobs: [...s.jobs, ...created] }));
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
    await get().pump();
    const active = get().jobs.some((j) => !j.finished && !j.cancelled);
    if (!active && get().queue.length === 0) get().stopPolling();
  },

  cancel: async (jobId) => {
    await cancelJob(jobId);
    await get().refresh();
  },

  clearFinished: async () => {
    await clearFinishedJobs();
    await get().refresh();
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
