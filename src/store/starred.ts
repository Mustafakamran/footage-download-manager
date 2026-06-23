import { create } from "zustand";
import { useToasts } from "./toast";

const KEY = "starred_v1";

function load(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}

interface StarState {
  byAccount: Record<string, string[]>;
  toggle: (accountId: string, path: string) => void;
  isStarred: (accountId: string, path: string) => boolean;
}

export const useStarred = create<StarState>((set, get) => ({
  byAccount: load(),

  // Optimistic: flip the star in the UI immediately, then persist. If the write
  // fails (e.g. storage quota), revert to the prior state so the UI stays honest.
  toggle: (accountId, path) =>
    set((s) => {
      const prev = s.byAccount;
      const cur = prev[accountId] ?? [];
      const next = cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path];
      const byAccount = { ...prev, [accountId]: next };
      try {
        localStorage.setItem(KEY, JSON.stringify(byAccount));
      } catch {
        // Revert the optimistic update and tell the user it didn't stick.
        useToasts.getState().push("Couldn't save star — storage full", "error");
        return { byAccount: prev };
      }
      return { byAccount };
    }),

  isStarred: (accountId, path) => (get().byAccount[accountId] ?? []).includes(path),
}));
