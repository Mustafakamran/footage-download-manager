import { create } from "zustand";
import { listAccounts, removeAccount, type Account } from "../lib/tauri/commands";
import { useIndex } from "./index-store";
import { useToasts } from "./toast";
import { prettyLabel } from "./account-meta";

export type Section = "all" | "recent" | "starred" | "shared";

export type View =
  | { kind: "browse"; accountId: string; section: Section; path: string }
  | { kind: "downloads"; filter: DownloadFilter }
  | { kind: "review"; accountId: string; target: ReviewTarget }
  | { kind: "accounts" };

export type DownloadFilter = "all" | "active" | "completed" | "failed";

/** A video file opened in the review player. */
export interface ReviewTarget {
  path: string;
  name: string;
  /** Backend file id — required for Drive/Drive-link streaming (empty otherwise). */
  fileId: string;
  size: number;
  ext: string;
}

interface AppState {
  view: View;
  accounts: Account[];
  accountsLoaded: boolean;

  setView: (view: View) => void;
  selectAccount: (accountId: string) => void;
  openReview: (accountId: string, target: ReviewTarget) => void;
  showDownloads: (filter: DownloadFilter) => void;
  setSection: (section: Section) => void;
  setPath: (path: string) => void;
  loadAccounts: () => Promise<void>;
  removeAccount: (id: string) => Promise<void>;
}

export const useApp = create<AppState>((set, get) => ({
  view: { kind: "accounts" },
  accounts: [],
  accountsLoaded: false,

  setView: (view) => set({ view }),

  selectAccount: (accountId) => set({ view: { kind: "browse", accountId, section: "all", path: "" } }),

  openReview: (accountId, target) => set({ view: { kind: "review", accountId, target } }),

  showDownloads: (filter) => set({ view: { kind: "downloads", filter } }),

  setSection: (section) =>
    set((s) =>
      s.view.kind === "browse" ? { view: { ...s.view, section, path: "" } } : s,
    ),

  setPath: (path) => set((s) => (s.view.kind === "browse" ? { view: { ...s.view, path } } : s)),

  loadAccounts: async () => {
    const accounts = await listAccounts();
    set((s) => {
      let view = s.view;
      const first = (): View => ({ kind: "browse", accountId: accounts[0].id, section: "all", path: "" });
      if (accounts.length === 0) {
        view = { kind: "accounts" };
      } else if (view.kind === "accounts") {
        view = first();
      } else if (view.kind === "browse") {
        const id = view.accountId;
        if (!accounts.some((a) => a.id === id)) view = first();
      }
      return { accounts, accountsLoaded: true, view };
    });
  },

  removeAccount: async (id) => {
    const acct = get().accounts.find((a) => a.id === id);
    await removeAccount(id);
    await useIndex.getState().remove(id);
    await get().loadAccounts();
    useToasts.getState().push(`Removed ${acct ? prettyLabel(acct.label) : "account"}`, "success");
  },
}));
