import { invoke } from "@tauri-apps/api/core";
import type { RcItem } from "./rc/browse";

export interface Aggregate {
  size: number;
  latest: string; // ISO of the newest file anywhere beneath the folder
  fileCount: number;
}

export interface AccountIndex {
  tree: Record<string, RcItem[]>; // parent path -> direct children
  agg: Record<string, Aggregate>; // folder path -> recursive aggregate
}

/** Pure tree+aggregate builder — kept for tests/seeding (production builds in Rust). */
export function buildIndex(flat: RcItem[]): AccountIndex {
  const tree: Record<string, RcItem[]> = {};
  const agg: Record<string, Aggregate> = {};
  for (const it of flat) {
    const slash = it.Path.lastIndexOf("/");
    const parent = slash === -1 ? "" : it.Path.slice(0, slash);
    (tree[parent] ||= []).push(it);
    if (it.IsDir) {
      agg[it.Path] ||= { size: 0, latest: "", fileCount: 0 };
    } else {
      let p = it.Path;
      while (p.includes("/")) {
        p = p.slice(0, p.lastIndexOf("/"));
        const a = (agg[p] ||= { size: 0, latest: "", fileCount: 0 });
        a.size += Math.max(0, it.Size);
        a.fileCount += 1;
        if (it.ModTime > a.latest) a.latest = it.ModTime;
      }
    }
  }
  for (const k in tree)
    tree[k].sort((a, b) =>
      a.IsDir !== b.IsDir ? (a.IsDir ? -1 : 1) : a.Name.toLowerCase().localeCompare(b.Name.toLowerCase()),
    );
  return { tree, agg };
}

/** All files across the whole index, newest first (Recent view). */
export function recentFiles(index: AccountIndex, limit = 200): RcItem[] {
  const files: RcItem[] = [];
  for (const k in index.tree) for (const it of index.tree[k]) if (!it.IsDir) files.push(it);
  files.sort((a, b) => (a.ModTime < b.ModTime ? 1 : a.ModTime > b.ModTime ? -1 : 0));
  return files.slice(0, limit);
}

/** Resolve an entry by full path (for starred items). */
export function itemAt(index: AccountIndex, path: string): RcItem | undefined {
  const slash = path.lastIndexOf("/");
  const parent = slash === -1 ? "" : path.slice(0, slash);
  return (index.tree[parent] ?? []).find((i) => i.Path === path);
}

/** Kick the Rust background indexer (serve from memory / disk / crawl). */
export function indexStart(accountId: string): Promise<void> {
  return invoke("index_start", { accountId });
}

/** Force a fresh crawl. */
export function indexRecrawl(accountId: string): Promise<void> {
  return invoke("index_recrawl", { accountId });
}

/** Manually (re)index just one subtree (BFS) and merge it into the account index. */
export function indexFolder(accountId: string, folderPath: string): Promise<void> {
  return invoke("index_folder", { accountId, folderPath });
}

/** Ask an in-progress crawl for this account to stop promptly. */
export function indexCancel(accountId: string): Promise<void> {
  return invoke("index_cancel", { accountId });
}

/** Fetch the built index ({tree, agg}) once ready. */
export function indexGet(accountId: string): Promise<AccountIndex | null> {
  return invoke<AccountIndex | null>("index_get", { accountId });
}

/** Drop an account's index. */
export function indexRemove(accountId: string): Promise<void> {
  return invoke("index_remove", { accountId });
}
