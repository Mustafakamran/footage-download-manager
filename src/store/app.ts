import { create } from "zustand";
import { listAccounts, removeAccount, type Account } from "../lib/tauri/commands";
import { useIndex } from "./index-store";

export type View =
  | { kind: "accounts" }
  | { kind: "settings" }
  | { kind: "profile"; id: string };

interface AppState {
  view: View;
  accounts: Account[];
  openTabs: string[];
  accountsLoaded: boolean;

  setView: (view: View) => void;
  loadAccounts: () => Promise<void>;
  openProfile: (id: string) => void;
  closeTab: (id: string) => void;
  removeAccount: (id: string) => Promise<void>;
}

export const useApp = create<AppState>((set, get) => ({
  view: { kind: "accounts" },
  accounts: [],
  openTabs: [],
  accountsLoaded: false,

  setView: (view) => set({ view }),

  loadAccounts: async () => {
    const accounts = await listAccounts();
    set((s) => ({
      accounts,
      accountsLoaded: true,
      // Drop tabs whose account no longer exists.
      openTabs: s.openTabs.filter((id) => accounts.some((a) => a.id === id)),
    }));
  },

  openProfile: (id) =>
    set((s) => ({
      view: { kind: "profile", id },
      openTabs: s.openTabs.includes(id) ? s.openTabs : [...s.openTabs, id],
    })),

  closeTab: (id) =>
    set((s) => {
      const openTabs = s.openTabs.filter((t) => t !== id);
      const stillOnIt = s.view.kind === "profile" && s.view.id === id;
      return {
        openTabs,
        view: stillOnIt ? { kind: "accounts" } : s.view,
      };
    }),

  removeAccount: async (id) => {
    await removeAccount(id);
    await useIndex.getState().remove(id);
    get().closeTab(id);
    await get().loadAccounts();
  },
}));
