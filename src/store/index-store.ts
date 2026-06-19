import { create } from "zustand";
import { crawlAndSave, loadCachedIndex, type AccountIndex } from "../lib/account-index";
import { deleteIndex, type Account } from "../lib/tauri/commands";

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

const inflight = new Set<string>();

function setEntry(
  set: (fn: (s: IndexState) => Partial<IndexState>) => void,
  id: string,
  entry: IndexEntry,
) {
  set((s) => ({ byAccount: { ...s.byAccount, [id]: entry } }));
}

async function doCrawl(account: Account, get: () => IndexState, set: Parameters<typeof setEntry>[0]) {
  setEntry(set, account.id, {
    status: "crawling",
    progress: { done: 0, total: 0 },
    index: get().byAccount[account.id]?.index ?? null,
  });
  const idx = await crawlAndSave(
    account,
    (done, total) =>
      setEntry(set, account.id, {
        status: "crawling",
        progress: { done, total },
        index: get().byAccount[account.id]?.index ?? null,
      }),
    Date.now(),
  );
  setEntry(set, account.id, { status: "ready", progress: { done: 0, total: 0 }, index: idx });
}

export const useIndex = create<IndexState>((set, get) => ({
  byAccount: {},

  ensure: async (account) => {
    const cur = get().byAccount[account.id];
    if (cur && cur.status !== "idle" && cur.status !== "error") return;
    if (inflight.has(account.id)) return;
    inflight.add(account.id);
    setEntry(set, account.id, { status: "loading", progress: { done: 0, total: 0 }, index: null });
    try {
      const cached = await loadCachedIndex(account.id);
      if (cached) {
        setEntry(set, account.id, { status: "ready", progress: { done: 0, total: 0 }, index: cached });
      } else {
        await doCrawl(account, get, set);
      }
    } catch (e) {
      setEntry(set, account.id, {
        status: "error",
        progress: { done: 0, total: 0 },
        index: null,
        error: String(e),
      });
    } finally {
      inflight.delete(account.id);
    }
  },

  recrawl: async (account) => {
    if (inflight.has(account.id)) return;
    inflight.add(account.id);
    try {
      await doCrawl(account, get, set);
    } catch (e) {
      const prev = get().byAccount[account.id];
      setEntry(set, account.id, {
        status: "error",
        progress: { done: 0, total: 0 },
        index: prev?.index ?? null,
        error: String(e),
      });
    } finally {
      inflight.delete(account.id);
    }
  },

  remove: async (accountId) => {
    await deleteIndex(accountId).catch(() => {});
    set((s) => {
      const b = { ...s.byAccount };
      delete b[accountId];
      return { byAccount: b };
    });
  },
}));
