import { RcClient } from "./rc/client";
import { buildFs, listFolder, type RcItem } from "./rc/browse";
import { saveIndex, loadIndex, type Account } from "./tauri/commands";

/** Recursive aggregate for a folder: total size, newest descendant date, file count. */
export interface Aggregate {
  size: number;
  latest: string; // ISO of the newest file anywhere beneath the folder
  fileCount: number;
}

export interface AccountIndex {
  tree: Record<string, RcItem[]>; // parent path -> direct children
  agg: Record<string, Aggregate>; // folder path -> recursive aggregate
  crawledAt: number;
}

function sortItems(items: RcItem[]): RcItem[] {
  return items.sort((a, b) => {
    if (a.IsDir !== b.IsDir) return a.IsDir ? -1 : 1;
    return a.Name.toLowerCase().localeCompare(b.Name.toLowerCase());
  });
}

/**
 * Pure: turn a flat list of root-relative entries into a browseable tree plus
 * per-folder recursive aggregates (size, newest date, file count).
 */
export function buildIndex(flat: RcItem[], crawledAt: number): AccountIndex {
  const tree: Record<string, RcItem[]> = {};
  const agg: Record<string, Aggregate> = {};

  for (const it of flat) {
    const slash = it.Path.lastIndexOf("/");
    const parent = slash === -1 ? "" : it.Path.slice(0, slash);
    (tree[parent] ||= []).push(it);

    if (it.IsDir) {
      agg[it.Path] ||= { size: 0, latest: "", fileCount: 0 };
    } else {
      // Roll the file up into every ancestor folder.
      let p = it.Path;
      while (p.includes("/")) {
        p = p.slice(0, p.lastIndexOf("/"));
        const a = (agg[p] ||= { size: 0, latest: "", fileCount: 0 });
        a.size += Math.max(0, it.Size);
        a.fileCount += 1;
        if (it.ModTime > a.latest) a.latest = it.ModTime; // ISO strings compare lexically
      }
    }
  }

  for (const k in tree) sortItems(tree[k]);
  return { tree, agg, crawledAt };
}

async function listRecurse(account: Account, remote: string): Promise<RcItem[]> {
  const res = await new RcClient().call<{ list?: RcItem[] }>("operations/list", {
    fs: buildFs(account),
    remote,
    opt: { recurse: true },
  });
  return res?.list ?? [];
}

/** Run async tasks with a concurrency cap, reporting progress as each completes. */
async function pool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  onDone: (done: number) => void,
): Promise<void> {
  let i = 0;
  let done = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try {
        await fn(items[idx]);
      } catch {
        /* skip a failed subtree, keep indexing */
      }
      onDone(++done);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Crawl an account into a flat entry list. Lists the root, then recursively
 * lists each top-level folder (concurrently) so progress can be reported as
 * folders-done / total. Paths are normalized to be root-relative.
 */
export async function crawlAccount(
  account: Account,
  onProgress: (done: number, total: number) => void,
): Promise<RcItem[]> {
  const root = await listFolder(account, "");
  const rootDirs = root.filter((d) => d.IsDir);
  const flat: RcItem[] = [...root];
  onProgress(0, rootDirs.length);

  await pool(
    rootDirs,
    5,
    async (dir) => {
      const sub = await listRecurse(account, dir.Path);
      for (const it of sub) flat.push({ ...it, Path: `${dir.Path}/${it.Path}` });
    },
    (done) => onProgress(done, rootDirs.length),
  );

  return flat;
}

/** Crawl + persist; returns the built index. */
export async function crawlAndSave(
  account: Account,
  onProgress: (done: number, total: number) => void,
  crawledAt: number,
): Promise<AccountIndex> {
  const flat = await crawlAccount(account, onProgress);
  await saveIndex(account.id, JSON.stringify({ flat, crawledAt })).catch(() => {});
  return buildIndex(flat, crawledAt);
}

/** Load a cached index from disk, or null if none. */
export async function loadCachedIndex(accountId: string): Promise<AccountIndex | null> {
  const raw = await loadIndex(accountId).catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { flat: RcItem[]; crawledAt: number };
    return buildIndex(parsed.flat ?? [], parsed.crawledAt ?? 0);
  } catch {
    return null;
  }
}
