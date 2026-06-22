import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  indexStart,
  indexRecrawl,
  indexGet,
  indexRemove,
  indexFolder,
  indexCancel,
  type AccountIndex,
} from "../lib/account-index";
import type { Account } from "../lib/tauri/commands";

export type IndexStatus = "idle" | "loading" | "crawling" | "ready" | "error";

/**
 * Live crawl progress. done/total = FOLDERS processed/discovered-so-far.
 * bytes/dateMin/dateMax are additive (extended from the original {done,total,files})
 * and optional so older payloads / seeded entries stay valid.
 */
export interface IndexProgressData {
  done: number;
  total: number;
  files: number;
  bytes?: number;
  dateMin?: string; // ISO modTime ("" when none)
  dateMax?: string; // ISO modTime ("" when none)
}

export interface IndexEntry {
  status: IndexStatus;
  progress: IndexProgressData;
  index: AccountIndex | null;
  error?: string;
}

interface IndexState {
  byAccount: Record<string, IndexEntry>;
  ensure: (account: Account) => Promise<void>;
  recrawl: (account: Account) => Promise<void>;
  indexFolder: (account: Account, folderPath: string) => Promise<void>;
  cancel: (accountId: string) => Promise<void>;
  remove: (accountId: string) => Promise<void>;
}

const blankProgress = (): IndexProgressData => ({ done: 0, total: 0, files: 0, bytes: 0, dateMin: "", dateMax: "" });

const blank = (): IndexEntry => ({ status: "idle", progress: blankProgress(), index: null });

export const useIndex = create<IndexState>((set, get) => {
  // Register the Rust → JS index events exactly once.
  let listeners: Promise<void> | null = null;
  const patch = (id: string, e: Partial<IndexEntry>) =>
    set((s) => ({ byAccount: { ...s.byAccount, [id]: { ...(s.byAccount[id] ?? blank()), ...e } } }));

  function ensureListeners(): Promise<void> {
    if (listeners) return listeners;
    listeners = (async () => {
      try {
        await listen<{
          accountId: string;
          done: number;
          total: number;
          files: number;
          bytes: number;
          dateMin: string;
          dateMax: string;
        }>("index-progress", (ev) => {
          const { accountId, done, total, files, bytes, dateMin, dateMax } = ev.payload;
          patch(accountId, {
            status: total > 0 ? "crawling" : "loading",
            progress: {
              done: done ?? 0,
              total: total ?? 0,
              files: files ?? 0,
              bytes: bytes ?? 0,
              dateMin: dateMin ?? "",
              dateMax: dateMax ?? "",
            },
          });
        });
        await listen<{ accountId: string }>("index-ready", async (ev) => {
          const idx = await indexGet(ev.payload.accountId);
          patch(ev.payload.accountId, { status: "ready", progress: blankProgress(), index: idx, error: undefined });
        });
        await listen<{ accountId: string; error: string }>("index-error", (ev) => {
          patch(ev.payload.accountId, { status: "error", error: ev.payload.error });
        });
      } catch {
        /* no Tauri event runtime (e.g. unit tests) */
      }
    })();
    return listeners;
  }

  return {
    byAccount: {},

    ensure: async (account) => {
      const cur = get().byAccount[account.id];
      if (cur && cur.status !== "idle" && cur.status !== "error") return;
      await ensureListeners();
      patch(account.id, { status: "loading" });
      await indexStart(account.id).catch((e) => patch(account.id, { status: "error", error: String(e) }));
    },

    recrawl: async (account) => {
      await ensureListeners();
      patch(account.id, { status: "loading", index: get().byAccount[account.id]?.index ?? null });
      await indexRecrawl(account.id).catch((e) => patch(account.id, { status: "error", error: String(e) }));
    },

    indexFolder: async (account, folderPath) => {
      await ensureListeners();
      // Keep the current index visible — the backend merges this subtree in.
      patch(account.id, {
        status: "crawling",
        progress: blankProgress(),
        index: get().byAccount[account.id]?.index ?? null,
        error: undefined,
      });
      await indexFolder(account.id, folderPath).catch((e) => patch(account.id, { status: "error", error: String(e) }));
    },

    cancel: async (accountId) => {
      // Optimistically settle the UI; a final index-ready/index-error still lands if the crawl flushes.
      const cur = get().byAccount[accountId];
      patch(accountId, { status: cur?.index ? "ready" : "idle", progress: blankProgress() });
      await indexCancel(accountId).catch(() => {});
    },

    remove: async (accountId) => {
      await indexRemove(accountId).catch(() => {});
      set((s) => {
        const b = { ...s.byAccount };
        delete b[accountId];
        return { byAccount: b };
      });
    },
  };
});
