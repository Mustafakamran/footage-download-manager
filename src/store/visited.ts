import { create } from "zustand";
import { loadJson, saveJson } from "../lib/persisted";

const KEY = "visited_folders_v1";

const load = () => loadJson<Record<string, string[]>>(KEY, {});

interface VisitedState {
  byAccount: Record<string, string[]>;
  /** Record that a folder was opened, so its badge persists across restarts. */
  markVisited: (accountId: string, path: string) => void;
  /** Mark many folders visited at once (the "Mark all as read" action). */
  markManyVisited: (accountId: string, paths: string[]) => void;
}

export const useVisited = create<VisitedState>((set, get) => ({
  byAccount: load(),

  markVisited: (accountId, path) => {
    if (!path) return; // the account root has no row/badge to mark
    const cur = get().byAccount[accountId] ?? [];
    if (cur.includes(path)) return;
    const byAccount = { ...get().byAccount, [accountId]: [...cur, path] };
    saveJson(KEY, byAccount);
    set({ byAccount });
  },

  markManyVisited: (accountId, paths) => {
    const cur = get().byAccount[accountId] ?? [];
    const merged = [...new Set([...cur, ...paths.filter(Boolean)])];
    if (merged.length === cur.length) return; // nothing new
    const byAccount = { ...get().byAccount, [accountId]: merged };
    saveJson(KEY, byAccount);
    set({ byAccount });
  },
}));
