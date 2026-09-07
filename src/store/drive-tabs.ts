import { create } from "zustand";
import type { Section } from "./app";
import type { Account, SharedDrive } from "../lib/tauri/commands";

/** One open Shared Drive, browsed in the app-wide slide-over dock. Its browse
 *  position (section/path) is remembered so refocusing a tab restores it. */
export interface DriveTab {
  id: string;
  base: Account;
  drive: SharedDrive;
  section: Section;
  path: string;
}

const tabId = (baseId: string, driveId: string) => `${baseId}:${driveId}`;

interface DriveTabsState {
  tabs: DriveTab[];
  /** The tab shown in the open drawer; null = all minimized (drawer hidden). */
  activeId: string | null;
  /** Open a Shared Drive: focus its tab if already open, else add + focus it. */
  open: (base: Account, drive: SharedDrive) => void;
  /** Bring a tab's drawer to the front. */
  focus: (id: string) => void;
  /** Minimize the drawer (keep every tab on the rail). */
  minimize: () => void;
  /** Close (remove) a tab entirely. */
  close: (id: string) => void;
  /** Persist a tab's browse position as the user navigates inside it. */
  setNav: (id: string, section: Section, path: string) => void;
}

export const useDriveTabs = create<DriveTabsState>((set, get) => ({
  tabs: [],
  activeId: null,

  open: (base, drive) => {
    const id = tabId(base.id, drive.id);
    const existing = get().tabs.find((t) => t.id === id);
    if (existing) { set({ activeId: id }); return; }
    set((s) => ({ tabs: [...s.tabs, { id, base, drive, section: "all", path: "" }], activeId: id }));
  },

  focus: (id) => set({ activeId: id }),

  minimize: () => set({ activeId: null }),

  close: (id) =>
    set((s) => ({
      tabs: s.tabs.filter((t) => t.id !== id),
      activeId: s.activeId === id ? null : s.activeId,
    })),

  setNav: (id, section, path) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, section, path } : t)) })),
}));
