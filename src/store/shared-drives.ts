import { create } from "zustand";
import { loadJson, saveJson } from "../lib/persisted";
import { listSharedDrives, type SharedDrive } from "../lib/tauri/commands";

const KEY = "shared_drives_cache_v1";

interface Cached {
  list: SharedDrive[];
  /** Epoch-ms of the last successful fetch. */
  at: number;
}

const load = () => loadJson<Record<string, Cached>>(KEY, {});

// Coalesce concurrent refreshes for the same account (mount + manual retry).
const inflight = new Set<string>();

interface SharedDrivesState {
  /** Per parent-account cache of its reachable Shared Drives. */
  byAccount: Record<string, Cached>;
  /** Whether a live fetch is currently running for an account. */
  loading: Record<string, boolean>;
  /** Fetch + cache an account's Shared Drives. Cached data is served instantly by
   *  the view; this refreshes it in the background (stale-while-revalidate). */
  refresh: (accountId: string) => Promise<void>;
}

export const useSharedDrives = create<SharedDrivesState>((set, get) => ({
  byAccount: load(),
  loading: {},

  refresh: async (accountId) => {
    if (inflight.has(accountId)) return;
    inflight.add(accountId);
    // Only show a spinner when there's nothing cached to display yet.
    if (get().byAccount[accountId] === undefined) set((s) => ({ loading: { ...s.loading, [accountId]: true } }));
    try {
      const list = await listSharedDrives(accountId);
      const byAccount = { ...get().byAccount, [accountId]: { list, at: Date.now() } };
      saveJson(KEY, byAccount);
      set((s) => ({ byAccount, loading: { ...s.loading, [accountId]: false } }));
    } catch {
      // Keep any stale cache; just drop the spinner. A retry can try again.
      set((s) => ({ loading: { ...s.loading, [accountId]: false } }));
    } finally {
      inflight.delete(accountId);
    }
  },
}));
