import { useEffect, useMemo, useState } from "react";
import { Download, Loader2, AlertCircle, List as ListIcon, LayoutGrid, RefreshCw, Star, ChevronDown, Check, Play, FolderSearch, FolderOpen, FileSearch, ArrowUp, ArrowDown, FolderTree } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useApp, type Section, type ReviewTarget } from "../store/app";
import { isVideo, extOf } from "../lib/review";
import { useIndex } from "../store/index-store";
import { useBrowse, browseKey } from "../store/browse";
import { useTransfers } from "../store/transfers";
import { useToasts } from "../store/toast";
import { useStarred } from "../store/starred";
import { useSearch } from "../store/search";
import { useAccountMeta, prettyLabel } from "../store/account-meta";
import { ProviderIcon } from "./icons";
import { Button, Skeleton } from "./ui";
import { fileType } from "../lib/file-types";
import { recentFiles, itemAt } from "../lib/account-index";
import { IndexProgress } from "./IndexProgress";
import { formatBytes, formatDate } from "../lib/format";
import { sortItems, DEFAULT_SORT, type SortField, type SortState } from "../lib/sort";
import type { RcItem } from "../lib/rc/browse";
import type { Account, DownloadItem } from "../lib/tauri/commands";

const FOLDER_KEY = "default_download_folder";
const SORT_KEY = "browse_sort";
const EMPTY: RcItem[] = [];
const EMPTY_STARS: string[] = [];

/** Restore the persisted sort (field + direction + folders-first), falling back to the default. */
function loadSort(): SortState {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<SortState>;
      const field: SortField[] = ["name", "size", "modified", "type"];
      if (field.includes(p.field as SortField) && (p.dir === "asc" || p.dir === "desc")) {
        return { field: p.field as SortField, dir: p.dir, foldersFirst: p.foldersFirst !== false };
      }
    }
  } catch {
    /* corrupt value — ignore and use default */
  }
  return DEFAULT_SORT;
}

const SECTION_TITLE: Record<Section, string> = {
  all: "All Files",
  recent: "Recent",
  starred: "Starred",
  shared: "Shared with me",
};

export function BrowsePane({ account, section, path }: { account: Account; section: Section; path: string }) {
  const setView = useApp((s) => s.setView);
  const openReview = useApp((s) => s.openReview);
  const entry = useIndex((s) => s.byAccount[account.id]);
  const enqueue = useTransfers((s) => s.enqueue);
  const toast = useToasts((s) => s.push);
  const q = useSearch((s) => s.q);
  const starred = useStarred((s) => s.byAccount[account.id]) ?? EMPTY_STARS;
  const toggleStar = useStarred((s) => s.toggle);
  const displayLabel = useAccountMeta((s) => s.byId[account.id]?.label) ?? prettyLabel(account.label);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [grid, setGrid] = useState(false);
  const [sort, setSort] = useState<SortState>(loadSort);
  const [sortOpen, setSortOpen] = useState(false);

  // Persist sort field + direction + folders-first so it sticks across sessions.
  useEffect(() => {
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify(sort));
    } catch {
      /* storage unavailable — non-fatal */
    }
  }, [sort]);

  useEffect(() => {
    void useIndex.getState().ensure(account);
  }, [account]);

  const index = entry?.index ?? null;
  const status = entry?.status ?? "idle";

  const aggOf = (p: string) => index?.agg[p];
  const sizeOf = (i: RcItem) => (i.IsDir ? aggOf(i.Path)?.size ?? 0 : Math.max(0, i.Size));
  const dateOf = (i: RcItem) => (i.IsDir ? aggOf(i.Path)?.latest ?? "" : i.ModTime);
  // A folder is "indexed" once the crawl has captured its subtree (children or aggregate present).
  const folderIndexed = (p: string) => !!(index && (index.agg[p] || index.tree[p]));
  const indexFolder = (folderPath: string) => void useIndex.getState().indexFolder(account, folderPath);
  const reviewTarget = (i: RcItem): ReviewTarget => ({ path: i.Path, name: i.Name, fileId: i.ID ?? "", size: sizeOf(i), ext: extOf(i.Name) });

  // Live fallback for folder views the crawl didn't capture.
  const folderView = section === "all" || section === "shared";
  const indexItems = folderView ? index?.tree[path] : undefined;
  const liveItems = useBrowse((s) => (folderView ? s.listings[browseKey(account.id, path)] : undefined));
  const liveLoading = useBrowse((s) => (folderView ? s.loading[browseKey(account.id, path)] : false)) ?? false;
  const usingIndex = !!(indexItems && indexItems.length);

  useEffect(() => {
    if (folderView && status === "ready" && (!indexItems || indexItems.length === 0)) {
      void useBrowse.getState().ensure(account, path);
    }
  }, [folderView, status, path, indexItems, account]);

  useEffect(() => setSelected(new Set()), [section, path, q]);

  const base: RcItem[] = useMemo(() => {
    if (!index) return folderView ? ((usingIndex ? indexItems : liveItems) ?? EMPTY) : EMPTY;
    if (q.trim()) {
      const needle = q.toLowerCase();
      return Object.values(index.tree).flat().filter((i) => i.Name.toLowerCase().includes(needle));
    }
    if (section === "recent") return recentFiles(index);
    if (section === "starred") return starred.map((p) => itemAt(index, p)).filter(Boolean) as RcItem[];
    return (usingIndex ? indexItems : liveItems) ?? EMPTY;
  }, [index, q, section, starred, usingIndex, indexItems, liveItems, folderView]);

  const items = useMemo(() => {
    // Resolvers honor folder aggregates from the index (recursive size / latest
    // mod time), falling back to the entry's own values when not indexed.
    return sortItems(base, sort, { sizeOf, dateOf });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, sort, index]);

  const allSelected = items.length > 0 && items.every((i) => selected.has(i.Path));
  const totalSelected = items.filter((i) => selected.has(i.Path)).reduce((s, i) => s + sizeOf(i), 0);

  function toggle(p: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(p) ? n.delete(p) : n.add(p);
      return n;
    });
  }

  async function download() {
    if (selected.size === 0) return;
    let dest = localStorage.getItem(FOLDER_KEY) ?? "";
    if (!dest) {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked !== "string") return;
      dest = picked;
    }
    const chosen: DownloadItem[] = items
      .filter((i) => selected.has(i.Path))
      .map((i) => ({ path: i.Path, name: i.Name, isDir: i.IsDir, size: sizeOf(i), id: i.ID ?? "" }));
    enqueue(account.id, chosen, dest);
    toast(`Queued ${chosen.length} download${chosen.length === 1 ? "" : "s"}`, "success");
    setSelected(new Set());
  }

  const segments = path ? path.split("/") : [];
  const showCrawl = status === "crawling" || status === "loading";
  const spinner = (!index && status !== "error") || (folderView && !usingIndex && liveLoading && items.length === 0);

  const SORTS: { key: SortField; label: string }[] = [
    { key: "name", label: "Name" },
    { key: "modified", label: "Date modified" },
    { key: "size", label: "Size" },
    { key: "type", label: "Type" },
  ];
  const sortLabel = SORTS.find((s) => s.key === sort.field)?.label ?? "Name";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Crawl progress */}
      {status === "loading" && (
        <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-5 py-2.5 text-sm text-[var(--text-2)]">
          <Loader2 size={15} className="animate-spin text-[var(--accent)]" />
          <span>Loading cached index…</span>
          <Skeleton className="ml-1 h-2 w-24" />
        </div>
      )}
      {status === "crawling" && entry && <IndexProgress accountId={account.id} entry={entry} />}

      {/* Toolbar */}
      <div className="flex items-center gap-3 px-6 py-4">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-[15px]">
          <ProviderIcon provider={account.provider} size={18} />
          {q.trim() ? (
            <span className="ml-1 text-[var(--text-2)]">Search results for “{q}”</span>
          ) : folderView ? (
            <>
              <button className="ml-1 font-medium text-[var(--text)] hover:text-[var(--accent)]" onClick={() => setView({ kind: "browse", accountId: account.id, section, path: "" })}>
                {displayLabel}
              </button>
              {segments.map((seg, i) => (
                <span key={i} className="flex items-center gap-1.5 text-[var(--text-2)]">
                  <ChevronDown size={14} className="-rotate-90 text-[var(--text-3)]" />
                  <button className="hover:text-[var(--text)]" onClick={() => setView({ kind: "browse", accountId: account.id, section, path: segments.slice(0, i + 1).join("/") })}>
                    {seg}
                  </button>
                </span>
              ))}
            </>
          ) : (
            <span className="ml-1 font-medium text-[var(--text)]">{SECTION_TITLE[section]}</span>
          )}
        </div>

        {/* Sort: field picker + asc/desc toggle (+ folders-first). No overflow-hidden
            on the group — it would clip the dropdown; edge buttons are rounded instead. */}
        <div className="flex rounded-[8px] border border-[var(--border)]">
          <div className="relative">
            <button
              onClick={() => setSortOpen((o) => !o)}
              title="Sort by"
              className="flex items-center gap-2 rounded-l-[7px] px-3 py-1.5 text-sm text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            >
              {sortLabel} <ChevronDown size={14} />
            </button>
            {sortOpen && (
              <>
                {/* click-outside backdrop */}
                <div className="fixed inset-0 z-10" onClick={() => setSortOpen(false)} />
              <div className="absolute right-0 top-9 z-20 w-44 overflow-hidden rounded-[8px] border border-[var(--border-strong)] bg-[var(--card)] py-1 shadow-[var(--shadow-lg)]">
                {SORTS.map((o) => (
                  <button
                    key={o.key}
                    onClick={() => {
                      setSort((s) => ({ ...s, field: o.key }));
                      setSortOpen(false);
                    }}
                    title={`Sort by ${o.label.toLowerCase()}`}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                  >
                    {o.label} {sort.field === o.key && <Check size={14} className="text-[var(--accent)]" />}
                  </button>
                ))}
                <div className="my-1 border-t border-[var(--border)]" />
                <button
                  onClick={() => {
                    setSort((s) => ({ ...s, foldersFirst: !s.foldersFirst }));
                    setSortOpen(false);
                  }}
                  title="Group folders above files regardless of sort field"
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                >
                  <span className="flex items-center gap-2"><FolderTree size={14} /> Folders first</span>
                  {sort.foldersFirst && <Check size={14} className="text-[var(--accent)]" />}
                </button>
              </div>
              </>
            )}
          </div>
          <button
            onClick={() => setSort((s) => ({ ...s, dir: s.dir === "asc" ? "desc" : "asc" }))}
            title={sort.dir === "asc" ? "Ascending — click for descending" : "Descending — click for ascending"}
            aria-label={`Sort direction: ${sort.dir === "asc" ? "ascending" : "descending"}`}
            className="rounded-r-[7px] border-l border-[var(--border)] px-2 py-1.5 text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            {sort.dir === "asc" ? <ArrowUp size={15} /> : <ArrowDown size={15} />}
          </button>
        </div>

        <div className="flex overflow-hidden rounded-[8px] border border-[var(--border)]">
          <button className={`px-2 py-1.5 ${!grid ? "bg-[var(--hover)] text-[var(--text)]" : "text-[var(--text-3)]"}`} onClick={() => setGrid(false)} aria-label="List view"><ListIcon size={15} /></button>
          <button className={`px-2 py-1.5 ${grid ? "bg-[var(--hover)] text-[var(--text)]" : "text-[var(--text-3)]"}`} onClick={() => setGrid(true)} aria-label="Grid view"><LayoutGrid size={15} /></button>
        </div>
        <button className="rounded-[8px] border border-[var(--border)] p-1.5 text-[var(--text-3)] hover:text-[var(--text)] disabled:opacity-50" onClick={() => useIndex.getState().recrawl(account)} disabled={showCrawl} aria-label="Re-index" title="Re-index (full refresh — picks up new/changed files)"><RefreshCw size={15} /></button>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto px-6 pb-2" data-testid="file-list">
        {status === "error" && (
          <div className="mb-3 flex items-center gap-2 rounded-[8px] border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--error)]">
            <AlertCircle size={16} /> {entry?.error}
            <button className="ml-2 underline" onClick={() => useIndex.getState().recrawl(account)}>retry</button>
          </div>
        )}

        {spinner ? (
          <FileListSkeleton />
        ) : items.length === 0 ? (
          <EmptyState q={q} section={section} />
        ) : grid ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3 py-2">
            {items.map((item) => {
              const ft = fileType(item.Name, item.IsDir);
              return (
                <div key={item.Path} className={`relative flex flex-col items-center gap-3 rounded-[11px] border p-5 ${selected.has(item.Path) ? "border-[var(--accent)] bg-[var(--card)]" : "border-[var(--border)] hover:bg-[var(--hover)]"}`}>
                  <input type="checkbox" aria-label={`Select ${item.Name}`} checked={selected.has(item.Path)} onChange={() => toggle(item.Path)} className="absolute left-3 top-3" />
                  <button
                    className="flex flex-col items-center gap-2 text-center"
                    onClick={() =>
                      item.IsDir
                        ? setView({ kind: "browse", accountId: account.id, section: "all", path: item.Path })
                        : isVideo(item.Name) && openReview(account.id, reviewTarget(item))
                    }
                  >
                    <ft.Icon size={30} style={{ color: ft.color }} />
                    <span className="line-clamp-2 text-sm text-[var(--text)]">{item.Name}</span>
                  </button>
                  <span className="tnum text-xs text-[var(--text-3)]">{sizeOf(item) > 0 ? formatBytes(sizeOf(item)) : "—"}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="sticky top-0 z-10 bg-[var(--surface)] text-left text-xs text-[var(--text-3)]">
                <th className="w-9 py-2.5"><input type="checkbox" aria-label="Select all" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.Path)))} /></th>
                <th className="py-2.5 font-medium">Name</th>
                <th className="w-44 py-2.5 font-medium">Modified</th>
                <th className="w-28 py-2.5 text-right font-medium">Size</th>
                <th className="w-28 py-2.5 pl-6 font-medium">Type</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const ft = fileType(item.Name, item.IsDir);
                const isStar = starred.includes(item.Path);
                return (
                  <tr key={item.Path} className={`group border-b border-[var(--border)]/60 ${selected.has(item.Path) ? "bg-[var(--card)]" : "hover:bg-[var(--hover)]"}`}>
                    <td className="py-2.5 pl-1"><input type="checkbox" aria-label={`Select ${item.Name}`} checked={selected.has(item.Path)} onChange={() => toggle(item.Path)} /></td>
                    <td className="min-w-0 py-2.5 pr-3">
                      <div className="flex min-w-0 items-center gap-3">
                        {item.IsDir ? (
                          <>
                            <button className="flex min-w-0 items-center gap-3 text-left text-[var(--text)] hover:text-[var(--accent)]" onClick={() => setView({ kind: "browse", accountId: account.id, section: "all", path: item.Path })}>
                              <ft.Icon size={18} style={{ color: ft.color }} className="shrink-0" />
                              <span className="truncate">{item.Name}</span>
                            </button>
                            {!folderIndexed(item.Path) ? (
                              <button
                                onClick={() => indexFolder(item.Path)}
                                disabled={showCrawl}
                                title="This folder isn't indexed yet — index it now"
                                className="shrink-0 whitespace-nowrap text-xs text-[var(--text-3)] hover:text-[var(--accent)] disabled:opacity-50"
                              >
                                Not indexed — Index now
                              </button>
                            ) : (
                              <button
                                onClick={() => indexFolder(item.Path)}
                                disabled={showCrawl}
                                title="Re-index this folder"
                                aria-label={`Index ${item.Name}`}
                                className="shrink-0 text-[var(--text-3)] opacity-0 group-hover:opacity-100 hover:text-[var(--accent)] disabled:opacity-50"
                              >
                                <FolderSearch size={14} />
                              </button>
                            )}
                          </>
                        ) : isVideo(item.Name) ? (
                          <button
                            className="flex min-w-0 items-center gap-3 text-left text-[var(--text)] hover:text-[var(--accent)]"
                            onClick={() => openReview(account.id, reviewTarget(item))}
                            title="Open in review"
                          >
                            <ft.Icon size={18} style={{ color: ft.color }} className="shrink-0" />
                            <span className="truncate">{item.Name}</span>
                            <Play size={12} className="shrink-0 text-[var(--text-3)] opacity-0 group-hover:opacity-100" />
                          </button>
                        ) : (
                          <span className="flex min-w-0 items-center gap-3 text-[var(--text)]">
                            <ft.Icon size={18} style={{ color: ft.color }} className="shrink-0" />
                            <span className="truncate">{item.Name}</span>
                          </span>
                        )}
                        <button onClick={() => toggleStar(account.id, item.Path)} aria-label="Star" className={`shrink-0 ${isStar ? "text-[var(--accent)]" : "text-[var(--text-3)] opacity-0 group-hover:opacity-100 hover:text-[var(--text)]"}`}>
                          <Star size={14} fill={isStar ? "currentColor" : "none"} />
                        </button>
                      </div>
                    </td>
                    <td className="py-2.5 text-[var(--text-3)]">{formatDate(dateOf(item))}</td>
                    <td className="tnum py-2.5 text-right text-[var(--text-2)]">{sizeOf(item) > 0 ? formatBytes(sizeOf(item)) : "—"}</td>
                    <td className="py-2.5 pl-6 text-[var(--text-3)]">{ft.label}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Selection bar */}
      {selected.size > 0 && (
        <div className="flex items-center justify-between gap-4 border-t border-[var(--border)] bg-[var(--surface)] px-6 py-3">
          <span className="text-sm text-[var(--text-2)]">
            Selected: <span className="tnum text-[var(--text)]">{selected.size}</span> items · <span className="tnum text-[var(--text)]">{formatBytes(totalSelected)}</span>
          </span>
          <Button variant="primary" onClick={download}><Download size={16} /> Download</Button>
        </div>
      )}
    </div>
  );
}

/** Shimmer placeholder rows shown while a folder/index loads — shaped like the
 *  file table so the transition to real rows reads as instant. */
function FileListSkeleton() {
  return (
    <div className="py-2" data-testid="file-list-skeleton">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 border-b border-[var(--border)]/40 py-3">
          <Skeleton className="h-[18px] w-[18px] shrink-0 rounded" />
          <Skeleton className="h-3.5" style={{ width: `${30 + ((i * 13) % 45)}%` }} />
          <div className="flex-1" />
          <Skeleton className="h-3 w-28 shrink-0" />
          <Skeleton className="h-3 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** Friendly empty-state copy for the three empty cases (search / starred / folder). */
function EmptyState({ q, section }: { q: string; section: Section }) {
  const Icon = q ? FileSearch : section === "starred" ? Star : FolderOpen;
  const title = q ? "No matches" : section === "starred" ? "No starred items yet" : "This folder is empty";
  const body = q
    ? `Nothing here matches “${q}”. Try a different search.`
    : section === "starred"
      ? "Star files and folders to pin them here for quick access."
      : "Nothing to show in this folder.";
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--accent-weak)] text-[var(--text-3)]">
        <Icon size={20} />
      </div>
      <div className="text-sm font-medium text-[var(--text)]">{title}</div>
      <p className="max-w-xs text-xs text-[var(--text-3)]">{body}</p>
    </div>
  );
}
