import { create } from "zustand";
import { loadJson, saveJson } from "../lib/persisted";
import type { RcItem } from "../lib/rc/browse";

const KEY = "new_folders_baseline_v1";
const SEEN_KEY = "new_folders_seen_at_v1";

const load = () => loadJson<Record<string, string[]>>(KEY, {});
const loadSeen = () => loadJson<Record<string, Record<string, number>>>(SEEN_KEY, {});

interface BaselineState {
  /** Per-account snapshot of top-level folder paths known as of first sighting.
   *  A root folder counts as "new" only if it's NOT in this set (see
   *  {@link pickNewFolders}). */
  baseline: Record<string, string[]>;
  /** Per-account map of folderPath → epoch-ms when FDM first identified it as new.
   *  Drives the "Identified <date, time>" label and newest-first ordering. */
  seenAt: Record<string, Record<string, number>>;
  /** Seed an account's baseline the first time we see its root listing, so a
   *  freshly-connected drive doesn't dump every existing folder as "new". No-op
   *  once seeded — later-appearing folders are then genuinely new. */
  seed: (accountId: string, rootFolderPaths: string[]) => void;
  /** Stamp first-seen time for newly-identified folders (no-op for known ones). */
  markSeen: (accountId: string, paths: string[]) => void;
  /** Dismiss the given new folders for an account: fold them into the baseline so
   *  they're no longer "new", and drop their seen-at stamps. Powers "Clear all". */
  acknowledge: (accountId: string, paths: string[]) => void;
  /** Forget an account's baseline (on removal). */
  reset: (accountId: string) => void;
}

export const useNewFoldersBaseline = create<BaselineState>((set, get) => ({
  baseline: load(),
  seenAt: loadSeen(),

  seed: (accountId, rootFolderPaths) => {
    if (get().baseline[accountId] !== undefined) return; // already seeded
    const baseline = { ...get().baseline, [accountId]: rootFolderPaths };
    saveJson(KEY, baseline);
    set({ baseline });
  },

  markSeen: (accountId, paths) => {
    const cur = get().seenAt[accountId] ?? {};
    const missing = paths.filter((p) => cur[p] === undefined);
    if (missing.length === 0) return; // all already stamped
    const now = Date.now();
    const forAccount = { ...cur };
    for (const p of missing) forAccount[p] = now;
    const seenAt = { ...get().seenAt, [accountId]: forAccount };
    saveJson(SEEN_KEY, seenAt);
    set({ seenAt });
  },

  acknowledge: (accountId, paths) => {
    if (paths.length === 0) return;
    const prev = get().baseline[accountId] ?? [];
    const baseline = { ...get().baseline, [accountId]: [...new Set([...prev, ...paths])] };
    saveJson(KEY, baseline);
    const forAccount = { ...(get().seenAt[accountId] ?? {}) };
    for (const p of paths) delete forAccount[p];
    const seenAt = { ...get().seenAt, [accountId]: forAccount };
    saveJson(SEEN_KEY, seenAt);
    set({ baseline, seenAt });
  },

  reset: (accountId) => {
    const baseline = { ...get().baseline };
    delete baseline[accountId];
    saveJson(KEY, baseline);
    const seenAt = { ...get().seenAt };
    delete seenAt[accountId];
    saveJson(SEEN_KEY, seenAt);
    set({ baseline, seenAt });
  },
}));

/**
 * The "newly added" root folders from a drive's top-level listing: a folder that
 * is (a) NOT in the seeded baseline — i.e. appeared since we first saw this drive
 * — AND (b) not already downloaded.
 *
 * Detection is deliberately NOT gated on the folder's modified-time: a folder a
 * client newly *shares* keeps its original content date (a 3-month-old shoot
 * shared today still reads as 3 months old), so a modified-time window wrongly
 * hides exactly the folders this screen exists to surface. "Appeared since we
 * started watching this drive" (the baseline diff) is the correct signal.
 *
 * Pure, so it's unit-tested without the store.
 */
export function pickNewFolders(
  rootItems: RcItem[],
  baseline: Set<string>,
  isDownloaded: (path: string) => boolean,
): RcItem[] {
  return rootItems.filter((i) => i.IsDir && !baseline.has(i.Path) && !isDownloaded(i.Path));
}
