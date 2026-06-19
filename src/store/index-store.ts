import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { indexStart, indexRecrawl, indexGet, indexRemove, type AccountIndex } from "../lib/account-index";
import type { Account } from "../lib/tauri/commands";

export type IndexStatus = "idle" | "loading" | "crawling" | "ready" | "error";

export interface IndexEntry {
  status: IndexStatus;
  progress: { done: number; total: number };
  index: AccountIndex | null;
  error?: string;
}

interface IndexState {
  byAccount: Record<string, IndexEntry>;
  ensure: (account: Account) => Promise<void>;
  recrawl: (account: Account) => Promise<void>;
  remove: (accountId: string) => Promise<void>;
}

const blank = (): IndexEntry => ({ status: "idle", progress: { done: 0, total: 0 }, index: null });

export const useIndex = create<IndexState>((set, get) => {
  // Register the Rust → JS index events exactly once.
  let listeners: Promise<void> | null = null;
  const patch = (id: string, e: Partial<IndexEntry>) =>
    set((s) => ({ byAccount: { ...s.byAccount, [id]: { ...(s.byAccount[id] ?? blank()), ...e } } }));

  function ensureListeners(): Promise<void> {
    if (listeners) return listeners;
    listeners = (async () => {
      try {
        await listen<{ accountId: string; done: number; total: number }>("index-progress", (ev) => {
          const { accountId, done, total } = ev.payload;
          patch(accountId, { status: total > 0 ? "crawling" : "loading", progress: { done, total } });
        });
        await listen<{ accountId: string }>("index-ready", async (ev) => {
          const idx = await indexGet(ev.payload.accountId);
          patch(ev.payload.accountId, { status: "ready", progress: { done: 0, total: 0 }, index: idx, error: undefined });
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
