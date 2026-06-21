import { create } from "zustand";
import type { JobStatus, DownloadItem } from "../lib/tauri/commands";

const KEY = "download_history_v1";
const CAP = 500;

export interface HistoryEntry {
  jobId: number;
  name: string;
  accountId: string;
  dest: string;
  size: number;
  status: "success" | "failed" | "cancelled";
  at: number;
  /** Failure reason (for failed entries). */
  error?: string;
  /** Original download item, so a failed entry can be resumed (re-enqueued from
   * its on-disk partial). Absent on entries recorded before this was added. */
  item?: DownloadItem;
}

function load(): HistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}
function persist(items: HistoryEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items.slice(0, CAP)));
  } catch {
    /* ignore quota */
  }
}

interface HistoryState {
  items: HistoryEntry[];
  recorded: Set<number>;
  record: (job: JobStatus, item?: DownloadItem) => void;
  /** Drop one entry (e.g. after the user resumes a failed download). */
  removeEntry: (jobId: number) => void;
  clear: () => void;
}

export const useHistory = create<HistoryState>((set, get) => {
  const items = load();
  return {
    items,
    recorded: new Set(items.map((i) => i.jobId)),

    record: (job, item) => {
      if (!job.finished && !job.cancelled) return;
      if (get().recorded.has(job.jobId)) return;
      const status = job.cancelled ? "cancelled" : job.success ? "success" : "failed";
      const entry: HistoryEntry = {
        jobId: job.jobId,
        name: job.name,
        accountId: job.accountId,
        dest: job.dest,
        size: job.totalBytes || job.bytes,
        status,
        at: Date.now(),
        error: status === "failed" ? job.error : undefined,
        // Keep the item on failures so the user can resume from history.
        item: status === "failed" ? item : undefined,
      };
      const recorded = new Set(get().recorded);
      recorded.add(job.jobId);
      const next = [entry, ...get().items].slice(0, CAP);
      persist(next);
      set({ items: next, recorded });
    },

    removeEntry: (jobId) => {
      const recorded = new Set(get().recorded);
      recorded.delete(jobId);
      const next = get().items.filter((i) => i.jobId !== jobId);
      persist(next);
      set({ items: next, recorded });
    },

    clear: () => {
      persist([]);
      set({ items: [], recorded: new Set() });
    },
  };
});
