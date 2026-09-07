import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Download, Upload, Loader2, AlertCircle, List as ListIcon, LayoutGrid, Columns3, RefreshCw, Star, ChevronDown, ChevronLeft, ChevronRight, Check, Play, Eye, FolderSearch, FolderOpen, Folder, FileSearch, FileUp, FolderUp, ArrowUp, ArrowDown, FolderTree, Trash2, Calculator, Copy, Pause, HardDrive, Link2, FolderPlus, MoreHorizontal, Tag, PanelRight, PanelRightClose, Layers, FolderInput, ArrowDownUp } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useApp, type Section, type ReviewTarget } from "../store/app";
import { isVideo, isPreviewable, extOf } from "../lib/review";
import { useIndex } from "../store/index-store";
import { useBrowse, browseKey, browseSearchKey, browseRecentKey } from "../store/browse";
import { useTransfers } from "../store/transfers";
import { useToasts } from "../store/toast";
import { useStarred } from "../store/starred";
import { useSelection, totalSelectedCount, totalSelectedSize, selectedDriveCount, type SelectedItem } from "../store/selection";
import { usePreview } from "../store/preview";
import { useHighlight } from "../store/highlight";
import { useVisited } from "../store/visited";
import { useHistory } from "../store/history";
import { useSearch } from "../store/search";
import { useSettings } from "../store/settings";
import { useAccountMeta, accountLabel } from "../store/account-meta";
import { ProviderIcon } from "./icons";
import { Button, Skeleton, EmptyState } from "./ui";
import { ContextMenu, type MenuItem } from "./ui/ContextMenu";
import { useFolderStatus, FOLDER_STATUS_META, FOLDER_STATUS_ORDER, type FolderStatus } from "../store/folder-status";
import { StatusBadge } from "./ui/StatusBadge";
import { DownloadBadge } from "./ui/DownloadBadge";
import { useDownloadStatusMap, type DlStatus } from "../lib/download-status";
import { SharePopover } from "./SharePopover";
import { MoveDialog } from "./MoveDialog";
import { fileType } from "../lib/file-types";
import { itemAt } from "../lib/account-index";
import { formatBytes, formatDate } from "../lib/format";
import { sortItems, groupItems, DEFAULT_SORT, type SortField, type SortState, type GroupBy } from "../lib/sort";
import { computeVirtualRange } from "../lib/virtual-rows";
import type { RcItem } from "../lib/rc/browse";
import { createFolder } from "../lib/rc/browse";
import { deleteItem, moveItem } from "../lib/tauri/commands";
import type { Account, DownloadItem } from "../lib/tauri/commands";
import { pickDownloadDest } from "../lib/ingest";
import { openShortcutFolder, downloadShortcutFolder } from "../lib/drive-link";
import { loadJson, saveJson } from "../lib/persisted";

const SORT_KEY = "browse_sort";
const GROUP_KEY = "browse_group";
const VIEW_KEY = "browse_view";
const PREVIEW_KEY = "browse_preview";
const EMPTY: RcItem[] = [];

/** Replace the browser's default drag image (a snapshot of the whole row) with a
 *  compact name pill, so an in-app drag shows just what's being moved. */
function setDragGhost(e: React.DragEvent, name: string) {
  const el = document.createElement("div");
  el.textContent = name;
  el.style.cssText =
    "position:fixed;top:-1000px;left:-1000px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
    "padding:6px 12px;border-radius:9px;background:var(--card);border:1px solid var(--line2);" +
    "font:600 12.5px -apple-system,system-ui,sans-serif;color:var(--ink);box-shadow:var(--shadow-lg);pointer-events:none;z-index:9999;";
  document.body.appendChild(el);
  try { e.dataTransfer.setDragImage(el, 14, 16); } catch { /* WKWebView may ignore */ }
  setTimeout(() => el.remove(), 0);
}

/** Base clipping for a single-line name (no ellipsis). */
const NAME_CLIP = "min-w-0 overflow-hidden whitespace-nowrap";
/** Right-edge fade mask — applied ONLY when the name is actually clipped (see
 *  useOverflowFade), so short names never fade. Both props for WKWebView. */
const FADE_MASK =
  "[mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)] [-webkit-mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)]";
/** Columns view: content-sized names still want fade-on-overflow; the mask there
 *  is harmless because the size meta sits in its own shrink-0 cell after it. */
const FADE_NAME = `${NAME_CLIP} ${FADE_MASK}`;

/** True while `ref`'s element is horizontally clipped (scrollWidth > clientWidth).
 *  Lets a name fade only when it overflows, keeping the size/status badge right
 *  next to the text otherwise. */
function useOverflowFade<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [over, setOver] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setOver(el.scrollWidth - el.clientWidth > 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, over] as const;
}

/**
 * Where to place a row's hover actions, in three states (measured per row):
 *  - "fixed"  — the name clears the reserved zone, so anchor the cluster at a
 *               fixed ~64% centre (no shift row-to-row).
 *  - "inline" — the name passes the fixed centre but there's still room on the
 *               row after it: slide the cluster right, just past the name.
 *  - "flyout" — no room left on the row (very long name / narrow list): lift the
 *               cluster into a tab above the row.
 * Returns the computed `left` (px, cell-relative) for inline/flyout.
 */
const ACTION_CENTER = 0.64;
const ACTION_W = 156; // approx cluster width (widest: 6 file icons)
function useActionMode(nameRef: React.RefObject<HTMLElement | null>, cellRef: React.RefObject<HTMLElement | null>) {
  const [state, setState] = useState<{ mode: "fixed" | "inline" | "flyout"; left: number }>({ mode: "fixed", left: 0 });
  useLayoutEffect(() => {
    const name = nameRef.current, cell = cellRef.current;
    if (!name || !cell) return;
    const check = () => {
      const cw = cell.clientWidth;
      const nameRight = name.getBoundingClientRect().right - cell.getBoundingClientRect().left;
      const center = ACTION_CENTER * cw;
      const fixedLeft = center - ACTION_W / 2;
      const PAD = 14, RPAD = 10;
      if (nameRight + PAD <= fixedLeft) {
        setState({ mode: "fixed", left: fixedLeft });
      } else {
        const left = nameRight + PAD;
        if (left + ACTION_W <= cw - RPAD) setState({ mode: "inline", left });
        else setState({ mode: "flyout", left: Math.max(RPAD, cw - ACTION_W - RPAD) });
      }
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(cell);
    return () => ro.disconnect();
  }, [nameRef, cellRef]);
  return state;
}

/** Explorer view mode — Finder-style columns, a flat list, or a grid of cards. */
type ViewMode = "columns" | "list" | "grid";
function loadView(): ViewMode {
  const v = loadJson<ViewMode>(VIEW_KEY, "list");
  return v === "columns" || v === "grid" ? v : "list";
}
const EMPTY_STARS: string[] = [];

/** Restore the persisted sort (field + direction + folders-first), falling back to the default. */
function loadSort(): SortState {
  const p = loadJson<Partial<SortState>>(SORT_KEY, {});
  const fields: SortField[] = ["name", "size", "modified", "type"];
  if (fields.includes(p.field as SortField) && (p.dir === "asc" || p.dir === "desc")) {
    return { field: p.field as SortField, dir: p.dir, foldersFirst: p.foldersFirst !== false };
  }
  return DEFAULT_SORT;
}

const SECTION_TITLE: Record<Section, string> = {
  all: "All Files",
  recent: "Recent",
  starred: "Starred",
  shared: "Shared with me",
};

/** A folder's size: instant from the index, computed on demand, or unknown. */
type FolderSizeState =
  | { kind: "known"; bytes: number }
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "unknown" };

/** Size cell: instant from the index, a spinner while computing, or a
 *  "Calculate" action for folders whose size we don't auto-compute (shared).
 *  Shared between list and grid views so both stay in sync. */
function SizeCell({ item, folderSize, onCalcSize }: { item: RcItem; folderSize: FolderSizeState; onCalcSize: (p: string) => void }) {
  if (!item.IsDir) return <>{item.Size > 0 ? formatBytes(item.Size) : <span className="text-[var(--text-3)]">·</span>}</>;
  if (folderSize.kind === "known") return <>{folderSize.bytes > 0 ? formatBytes(folderSize.bytes) : <span className="text-[var(--text-3)]">·</span>}</>;
  if (folderSize.kind === "loading") return <Loader2 size={13} className="inline animate-spin text-[var(--text-3)]" />;
  return (
    <button
      onClick={() => onCalcSize(item.Path)}
      data-tip={folderSize.kind === "error" ? "Retry sizing" : "Calculate size"}
      className="-mr-1.5 rounded-[6px] px-1.5 py-0.5 text-xs text-[var(--text-3)] hover:bg-[var(--hover)] hover:text-[var(--accent)]"
    >
      {folderSize.kind === "error" ? "Retry" : "Calculate"}
    </button>
  );
}

/** Small corner badge on a folder's icon: a filled dot once something inside
 *  it has been downloaded, or a plain dot once it's just been opened. Shared
 *  between list and grid views so both stay in sync. */
function FolderBadge({ hasDownloads, visited }: { hasDownloads: boolean; visited: boolean }) {
  if (hasDownloads) {
    return (
      <span
        data-tip="Has downloads"
        className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[var(--dl)] ring-2 ring-[var(--surface)]"
      >
        <Check size={8} strokeWidth={3} className="text-white" />
      </span>
    );
  }
  if (visited) {
    return (
      <span
        data-tip="Opened"
        className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-[var(--text-3)] ring-2 ring-[var(--surface)]"
      />
    );
  }
  return null;
}

/** Section header shown above a group of items in the grid (and list via a
 *  spanning row) when grouping is on. */
function GroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 pb-1.5 pt-4">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--faint)]">{label}</span>
      <span className="font-mono text-[10px] text-[var(--faint)]">· {count}</span>
      <span className="h-px flex-1 bg-[var(--line)]" />
    </div>
  );
}

/** Stable-callback props every row/grid-item shares — identical shape so both
 * FileRow and FileGridItem can take the same object. */
interface RowActions {
  toggle: (p: string, shiftKey?: boolean, list?: RcItem[]) => void;
  openFolder: (p: string) => void;
  /** Open a folder ROW: routes a Drive folder-shortcut to its id-rooted linked
   *  folder, else navigates by path. Use for folder clicks (openFolder is still
   *  used for path-only nav like breadcrumbs). */
  openDir: (item: RcItem) => void;
  /** Single-click a file: show it in the right preview panel. */
  focus: (item: RcItem) => void;
  /** Lightweight preview overlay (from the panel / actions). */
  openPreview: (item: RcItem) => void;
  /** Right-click → Review: the full reviewer screen. */
  openReview: (item: RcItem) => void;
  download: (item: RcItem) => void;
  /** Open the copy/share-link popover for this item. */
  share: (item: RcItem, anchor: { x: number; y: number }) => void;
  indexFolder: (p: string) => void;
  calcSize: (p: string) => void;
  toggleStar: (p: string) => void;
  deleteOne: (item: RcItem) => void;
  contextMenu: (x: number, y: number, item: RcItem) => void;
  /** In-app drag-to-move/copy. dragStart records the dragged item; dragOverFolder
   *  returns true (and highlights) when `folder` is a valid drop target; drop
   *  performs the move (copy=true on ⌥/Alt); dragEnd clears state. */
  dragStart: (item: RcItem) => void;
  dragEnd: () => void;
  dragOverFolder: (folder: RcItem) => boolean;
  drop: (folder: RcItem, copy: boolean) => void;
}

function folderSizeEqual(a: FolderSizeState, b: FolderSizeState): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "known" && b.kind === "known" ? a.bytes === b.bytes : true;
}

export function BrowsePane({ account, section, path, onNavigate }: { account: Account; section: Section; path: string; onNavigate?: (section: Section, path: string) => void }) {
  const setView = useApp((s) => s.setView);
  const canGoBack = useApp((s) => s.back.length > 0);
  const canGoForward = useApp((s) => s.forward.length > 0);
  const goBack = useApp((s) => s.goBack);
  const goForward = useApp((s) => s.goForward);
  const openReview = useApp((s) => s.openReview);
  // Embedded mode (e.g. the Shared Drive slide-over): navigation is handled by the
  // host via onNavigate so it stays inside the panel instead of switching the
  // whole app's view. When absent, navigate the global view as usual.
  const embedded = !!onNavigate;
  const navigate = useCallback(
    (sec: Section, p: string) => {
      if (onNavigate) onNavigate(sec, p);
      else setView({ kind: "browse", accountId: account.id, section: sec, path: p });
    },
    [onNavigate, setView, account.id],
  );
  const entry = useIndex((s) => s.byAccount[account.id]);
  const enqueue = useTransfers((s) => s.enqueue);
  // Active downloads for THIS account — powers the status-footer "N DOWNLOADING".
  const activeDownloads = useTransfers((s) => s.jobs).filter((j) => j.accountId === account.id && !j.finished && !j.cancelled).length;
  const toast = useToasts((s) => s.push);
  const q = useSearch((s) => s.q);
  const starred = useStarred((s) => s.byAccount[account.id]) ?? EMPTY_STARS;
  const toggleStar = useStarred((s) => s.toggle);
  const folderStatusMap = useFolderStatus((s) => s.byAccount[account.id]);
  const setFolderStatus = useFolderStatus((s) => s.set);
  // Live transfer status per source path (Downloading %/Downloaded/Failed/…),
  // so a file/folder shows its download state right here in the browser.
  const dlStatusMap = useDownloadStatusMap(account.id);

  // Folder badges: "visited" (opened at least once) persists across restarts;
  // "has downloads" is derived from history rather than stored separately, so
  // it can never drift from what was actually downloaded.
  const visitedList = useVisited((s) => s.byAccount[account.id]) ?? EMPTY_STARS;
  const visitedSet = useMemo(() => new Set(visitedList), [visitedList]);
  const historyItems = useHistory((s) => s.items);
  const downloadedPaths = useMemo(() => {
    const set = new Set<string>();
    for (const h of historyItems) {
      if (h.accountId === account.id && h.status === "success" && h.item?.path) set.add(h.item.path);
    }
    return set;
  }, [historyItems, account.id]);
  const folderHasDownloads = (folderPath: string) => {
    if (downloadedPaths.has(folderPath)) return true;
    const prefix = `${folderPath}/`;
    for (const p of downloadedPaths) {
      if (p.startsWith(prefix)) return true;
    }
    return false;
  };
  const displayLabel = accountLabel(useAccountMeta((s) => s.byId[account.id]?.label), account);

  // Selection lives in a global store keyed by drive, so it PERSISTS across
  // folder and drive navigation — you can build up a selection across drives
  // and download it all at once.
  const selectionForAccount = useSelection((s) => s.byAccount[account.id]);
  const selected = useMemo(() => new Set(Object.keys(selectionForAccount ?? {})), [selectionForAccount]);
  const lastToggledPath = useRef<string | null>(null);
  const [view, setViewMode] = useState<ViewMode>(loadView);
  const [showPreview, setShowPreview] = useState<boolean>(() => loadJson<boolean>(PREVIEW_KEY, true));
  useEffect(() => { saveJson(PREVIEW_KEY, showPreview); }, [showPreview]);
  const grid = view === "grid";
  const columns = view === "columns";
  useEffect(() => { saveJson(VIEW_KEY, view); }, [view]);
  // Right preview panel target: the last single-clicked item (file or folder).
  // Cleared on folder navigation so the panel reflects where you are.
  const [focused, setFocused] = useState<RcItem | null>(null);
  useEffect(() => { setFocused(null); }, [path, section, account.id]);
  const [sort, setSort] = useState<SortState>(loadSort);
  const [groupBy, setGroupBy] = useState<GroupBy>(() => {
    const g = loadJson<GroupBy>(GROUP_KEY, "none");
    return g === "type" || g === "date" || g === "size" ? g : "none";
  });
  useEffect(() => { saveJson(GROUP_KEY, groupBy); }, [groupBy]);
  const [groupOpen, setGroupOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  // Drag-and-drop upload target while an OS drag hovers the browser: null = not
  // dragging, "" = the current folder (empty area), else the hovered folder's
  // path. Drives the drop highlight + where a dropped file/folder uploads to.
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dropTargetRef = useRef<string | null>(null);

  // List-view virtualization: a folder full of raw footage can hold thousands
  // of files, and rendering every row as a real DOM node is exactly what was
  // freezing the app on large folders. Only the rows in (or near) the
  // viewport are ever mounted — see the `computeVirtualRange` call below.
  const bodyRef = useRef<HTMLDivElement>(null);
  // Outer view container (list/grid/columns) — the drag-drop hit-test zone, so a
  // drop works in every view, not just the virtualized list body.
  const viewRef = useRef<HTMLDivElement>(null);
  const scrollRaf = useRef<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [rowHeight, setRowHeight] = useState(50); // corrected once a real row is measured below

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onScroll = () => {
      if (scrollRaf.current != null) return;
      scrollRaf.current = requestAnimationFrame(() => {
        scrollRaf.current = null;
        setScrollTop(el.scrollTop);
      });
    };
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    el.addEventListener("scroll", onScroll, { passive: true });
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (scrollRaf.current != null) cancelAnimationFrame(scrollRaf.current);
    };
  }, []);

  // Persist sort field + direction + folders-first so it sticks across sessions.
  useEffect(() => {
    saveJson(SORT_KEY, sort);
  }, [sort]);

  // Live, server-side Search + Recent — the "like the web" path. We NEVER crawl an
  // account into a local index automatically (Drive's "Shared with me" alone is
  // tens of TB). Search asks the provider directly (Drive files.list / Dropbox
  // search_v2); Recent uses Drive's modifiedTime sort. The store debounces the
  // outbound request and caches results per query, so typing fast doesn't fire
  // a request per keystroke and re-visiting a query is instant.
  const searching = q.trim().length > 0;
  const showingRecent = section === "recent" && !searching;
  const dropboxRecent = showingRecent && account.provider === "dropbox";
  const resultKey = searching ? browseSearchKey(account.id, q.trim()) : browseRecentKey(account.id);
  const serverItems = useBrowse((s) => (searching || showingRecent ? s.searchResults[resultKey] : undefined)) ?? EMPTY;
  const serverResultLoading = useBrowse((s) => s.searchLoading[resultKey]) ?? false;
  const serverResultError = useBrowse((s) => s.searchErrors[resultKey]);
  const serverState: "idle" | "loading" | "error" | "dropbox-recent" = !(searching || showingRecent)
    ? "idle"
    : dropboxRecent
      ? "dropbox-recent"
      : serverResultError
        ? "error"
        : serverResultLoading
          ? "loading"
          : "idle";

  useEffect(() => {
    if (dropboxRecent) return;
    if (searching) useBrowse.getState().search(account, q.trim());
    else if (showingRecent) useBrowse.getState().recent(account);
  }, [q, searching, showingRecent, dropboxRecent, account]);

  const index = entry?.index ?? null;
  const status = entry?.status ?? "idle";

  const browseSizes = useBrowse((s) => s.sizes);
  const aggOf = (p: string) => index?.agg[p];
  // A folder is "indexed" once the crawl captured its subtree (children or aggregate present).
  const folderIndexed = (p: string) => !!(index && (index.agg[p] || index.tree[p]));

  // Folder-size resolution. Owned accounts are crawled once at link time, so the
  // index aggregate gives an instant size. Shared ("Shared with me") folders are
  // NOT in the index and intentionally NOT auto-walked — they can be enormous or
  // not owned — so they read "unknown" until the user calculates one on demand.
  const folderSizeState = (p: string): FolderSizeState => {
    if (folderIndexed(p)) return { kind: "known", bytes: aggOf(p)?.size ?? 0 };
    const v = browseSizes[browseKey(account.id, p)];
    if (typeof v === "number") return { kind: "known", bytes: v };
    if (v === "loading") return { kind: "loading" };
    if (v === "error") return { kind: "error" };
    return { kind: "unknown" };
  };
  const calcSize = (p: string) => void useBrowse.getState().computeSize(account, p);

  const sizeOf = (i: RcItem): number => {
    if (!i.IsDir) return Math.max(0, i.Size);
    const st = folderSizeState(i.Path);
    return st.kind === "known" ? st.bytes : 0;
  };
  // A folder's size counts for sorting only once it's actually known — so
  // still-computing folders park stably at the bottom instead of jumping.
  const sizeKnownOf = (i: RcItem): boolean => (i.IsDir ? folderSizeState(i.Path).kind === "known" : true);
  // Folder date: index "latest file" if crawled, else the folder's own mod time
  // (instant from the live listing). Files use their own mod time.
  const dateOf = (i: RcItem) => (i.IsDir ? (aggOf(i.Path)?.latest || i.ModTime) : i.ModTime);
  // A folder's recursive file count, once the index has captured its subtree.
  const fileCountOf = (i: RcItem): number | undefined => (i.IsDir ? aggOf(i.Path)?.fileCount : undefined);
  // Recursive totals for a folder: ALL files + ALL subfolders anywhere beneath
  // it (not just direct children). Pulled from the crawl index; `indexed` is
  // false until the subtree has been captured (then the panel offers to index).
  const folderStats = (p: string): { files: number; folders: number; indexed: boolean } => {
    if (!folderIndexed(p)) return { files: 0, folders: 0, indexed: false };
    const files = aggOf(p)?.fileCount ?? 0;
    const pre = p ? `${p}/` : "";
    let folders = 0;
    if (index) for (const k in index.agg) if (k.startsWith(pre) && k !== p) folders++;
    return { files, folders, indexed: true };
  };
  const indexFolder = (folderPath: string) => void useIndex.getState().indexFolder(account, folderPath);

  // Delete (with confirm). Cloud deletes go to the provider Trash (recoverable).
  // pendingDelete holds one item (per-row trash) or many (selection-bar delete).
  const dropPath = useIndex((s) => s.dropPath);
  const [pendingDelete, setPendingDelete] = useState<RcItem[] | null>(null);
  // Right-click context menu (cursor-anchored, one item at a time).
  const [menu, setMenu] = useState<{ x: number; y: number; item: RcItem } | null>(null);
  // Background menu — right-clicking the empty space of a folder view.
  const [bgMenu, setBgMenu] = useState<{ x: number; y: number } | null>(null);
  // Marquee (click-drag rubber-band) selection rectangle, in viewport coords.
  // `leaving` drives the macOS-style fade-out on release.
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number; leaving?: boolean } | null>(null);
  const [share, setShare] = useState<{ item: RcItem; anchor: { x: number; y: number } } | null>(null);
  const [moveItems, setMoveItems] = useState<RcItem[] | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const submitNewFolder = async () => {
    const name = (newFolder ?? "").trim();
    if (!name || creatingFolder) return;
    setCreatingFolder(true);
    try {
      await createFolder(account, path, name);
      setNewFolder(null);
      await useBrowse.getState().ensure(account, path); // refresh so the new folder appears
    } catch (e) {
      useToasts.getState().push(`Couldn't create folder: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setCreatingFolder(false);
    }
  };
  const [deleting, setDeleting] = useState(false);
  async function confirmDelete() {
    const list = pendingDelete;
    if (!list || list.length === 0) return;
    setDeleting(true);
    let ok = 0;
    const fails: string[] = [];
    for (const it of list) {
      try {
        await deleteItem(account.id, it.Path, it.IsDir);
        dropPath(account.id, it.Path);
        ok++;
      } catch (e) {
        fails.push(`${it.Name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    useSelection.getState().clearAccount(account.id);
    if (ok) toast(`Deleted ${ok} item${ok > 1 ? "s" : ""} (moved to Trash)`, "success");
    if (fails.length) toast(`Delete failed: ${fails[0]}${fails.length > 1 ? ` (+${fails.length - 1} more)` : ""}`, "error");
    setDeleting(false);
    setPendingDelete(null);
  }
  const reviewTarget = (i: RcItem): ReviewTarget => ({ path: i.Path, name: i.Name, fileId: i.ID ?? "", size: sizeOf(i), ext: extOf(i.Name) });

  // Marquee selection: drag on empty space (list, grid, OR columns) to rubber-band
  // select. Holding Shift/Cmd adds to the existing selection. Hit-tests rendered
  // items by their DOM rects within the container the drag started in.
  const startMarquee = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest("[data-row],[data-item],button,input,a,thead")) return; // real interaction
    const container = e.currentTarget;
    e.preventDefault(); // don't start a native text selection
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    const additive = e.shiftKey || e.metaKey;
    const base = additive ? Object.values(useSelection.getState().byAccount[account.id] ?? {}) : [];
    // Resolve any hit path to its RcItem across ALL loaded listings of this
    // account (so the Columns view's ancestor columns resolve too).
    const byPath = new Map<string, RcItem>();
    const allListings = useBrowse.getState().listings;
    const prefix = `${account.id} `;
    for (const k in allListings) if (k.startsWith(prefix)) for (const it of allListings[k] ?? []) byPath.set(it.Path, it);
    for (const it of items) byPath.set(it.Path, it);
    // Keep the rectangle (and hit-test) inside the file section — never spill
    // over the sidebar or the preview panel.
    const cr = container.getBoundingClientRect();
    const clampX = (v: number) => Math.max(cr.left, Math.min(v, cr.right));
    const clampY = (v: number) => Math.max(cr.top, Math.min(v, cr.bottom));
    const sx = clampX(e.clientX), sy = clampY(e.clientY);
    let moved = false;
    const onMove = (ev: MouseEvent) => {
      if (Math.abs(ev.clientX - sx) < 4 && Math.abs(ev.clientY - sy) < 4) return; // ignore jitter
      moved = true;
      ev.preventDefault();
      window.getSelection()?.removeAllRanges();
      const cx = clampX(ev.clientX), cy = clampY(ev.clientY);
      const x0 = Math.min(sx, cx), y0 = Math.min(sy, cy);
      const x1 = Math.max(sx, cx), y1 = Math.max(sy, cy);
      setMarquee({ x0, y0, x1, y1 });
      const hits: SelectedItem[] = [];
      container.querySelectorAll<HTMLElement>("[data-path]").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.right > x0 && r.left < x1 && r.bottom > y0 && r.top < y1) {
          const it = byPath.get(el.dataset.path!);
          if (it) hits.push({ item: it, size: sizeOf(it) });
        }
      });
      useSelection.getState().setAccount(account.id, [...base, ...hits]);
    };
    const onUp = () => {
      // Fade the rectangle out (macOS-style) instead of snapping it away.
      if (moved) {
        setMarquee((m) => (m ? { ...m, leaving: true } : null));
        setTimeout(() => setMarquee(null), 340);
      } else {
        setMarquee(null);
      }
      document.body.style.userSelect = prevUserSelect;
      // A plain click on empty space (no drag) clears the selection AND the
      // focus, so the preview panel falls back to the current folder.
      if (!moved && !additive) { useSelection.getState().clearAccount(account.id); setFocused(null); }
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // In-app drag-to-move/copy. The dragged item lives in a ref (available during
  // dragover, unlike dataTransfer); `moveOver` is the folder path being hovered
  // (drives the drop highlight). Move/copy is server-side on Drive/Dropbox.
  const draggedRef = useRef<RcItem | null>(null);
  // True while an IN-APP drag (move/copy) is in flight. On macOS WKWebView an
  // element drag is a native drag session that comes through the OS drag handler
  // (HTML5 dragover/drop don't fire), so the OS handler routes to MOVE while this
  // is set — highlight the hovered folder, suppress the upload overlay, and move
  // on drop. `moveTargetRef` holds the valid folder path currently under cursor.
  const inAppDragRef = useRef(false);
  const moveTargetRef = useRef<string | null>(null);
  // Can the dragged item be dropped into folder `fp` (path-only, for the OS
  // handler which only has the path string)?
  const canDropOnPath = (fp: string): boolean => {
    const d = draggedRef.current;
    if (!d || d.Path === fp) return false;
    if (d.IsDir && (fp === d.Path || fp.startsWith(`${d.Path}/`))) return false;
    return fp !== parentOf(d.Path);
  };
  async function performMoveToPath(dstDir: string, copy: boolean) {
    const d = draggedRef.current;
    draggedRef.current = null;
    inAppDragRef.current = false;
    moveTargetRef.current = null;
    setMoveOver(null);
    if (!d || !canDropOnPath(dstDir)) return;
    try {
      await moveItem(account.id, d.Path, dstDir, d.IsDir, copy);
      if (!copy) dropPath(account.id, d.Path);
      void useBrowse.getState().ensure(account, parentOf(d.Path));
      void useBrowse.getState().ensure(account, dstDir);
      useSelection.getState().clearAccount(account.id);
      toast(`${copy ? "Copied" : "Moved"} ${d.Name} → ${dstDir === "" ? "root" : dstDir.split("/").pop()}`, "success");
    } catch (e) {
      toast(`${copy ? "Copy" : "Move"} failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }
  const [moveOver, setMoveOver] = useState<string | null>(null);
  const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const canDropOn = (folder: RcItem): boolean => {
    const d = draggedRef.current;
    if (!d || !folder.IsDir || d.Path === folder.Path) return false;
    // Not into itself/a descendant, and not a no-op onto its current parent.
    if (d.IsDir && (folder.Path === d.Path || folder.Path.startsWith(`${d.Path}/`))) return false;
    if (folder.Path === parentOf(d.Path)) return false;
    return true;
  };
  async function performMove(folder: RcItem, copy: boolean) {
    const d = draggedRef.current;
    draggedRef.current = null;
    setMoveOver(null);
    if (!d || !canDropOn(folder)) return;
    try {
      await moveItem(account.id, d.Path, folder.Path, d.IsDir, copy);
      if (!copy) dropPath(account.id, d.Path);
      void useBrowse.getState().ensure(account, parentOf(d.Path));
      void useBrowse.getState().ensure(account, folder.Path);
      useSelection.getState().clearAccount(account.id);
      toast(`${copy ? "Copied" : "Moved"} ${d.Name} → ${folder.Name}`, "success");
    } catch (e) {
      toast(`${copy ? "Copy" : "Move"} failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  // Browse is LIVE: each folder is listed on demand (instant), independent of the
  // background index (which now only powers Recent + Search). Index entries are a
  // fallback shown until the live listing arrives.
  const folderView = section === "all" || section === "shared";
  const indexItems = folderView ? index?.tree[path] : undefined;
  const liveItems = useBrowse((s) => (folderView ? s.listings[browseKey(account.id, path)] : undefined));
  const liveLoading = useBrowse((s) => (folderView ? s.loading[browseKey(account.id, path)] : false)) ?? false;
  const liveError = useBrowse((s) => (folderView ? s.errors[browseKey(account.id, path)] : undefined));

  // List the current folder live whenever it changes — never wait for the crawl.
  useEffect(() => {
    if (folderView) {
      void useBrowse.getState().ensure(account, path);
      useVisited.getState().markVisited(account.id, path);
    }
  }, [folderView, path, account]);

  // Restore the saved index from disk on every account open (no crawl) — so
  // folder sizes/counts persist across restarts and updates without re-indexing,
  // regardless of the auto-index setting. Only an explicit Re-index (or a new
  // upload's targeted per-folder index) re-crawls.
  useEffect(() => {
    void useIndex.getState().ensureLoaded(account);
  }, [account.id]);

  // Auto-index the drive in the background (when enabled) so every folder's
  // total SIZE + FILE COUNT is available by default. ensure() is idempotent
  // (serves from memory/disk, only crawls once) and runs on background threads,
  // so the main thread stays smooth — the crawl only shows a progress bar.
  const autoIndex = useSettings((s) => s.autoIndex);
  useEffect(() => {
    if (!autoIndex) return;
    // Don't auto-retry a crawl that ended in error — that would re-hammer the
    // provider on every visit to the account. The manual Re-index button still
    // lets the user retry. (ensure() itself skips loading/crawling/ready.)
    if (useIndex.getState().byAccount[account.id]?.status === "error") return;
    // ensureAuto() (not ensure()) so a crawl the user cancelled — which settles
    // status back to "idle" — is NOT silently restarted every time this pane
    // remounts (e.g. after a search or account switch).
    void useIndex.getState().ensureAuto(account);
  }, [account, autoIndex]);

  // Reset scroll position on navigation (selection now persists — it lives in
  // the global store, not here). Otherwise the virtualization window below would
  // briefly compute from the PREVIOUS folder's scroll offset.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [section, path, q]);

  // A pending highlight (e.g. jumped here from a search result): once this folder
  // has loaded the item, select it, scroll it into view, and flash it briefly so
  // you can see exactly which file the search meant.
  const [blinkPath, setBlinkPath] = useState<string | null>(null);

  const base: RcItem[] = useMemo(() => {
    // Search + Recent are LIVE server-side queries (no crawl). Starred reads from
    // an index ONLY if one was already built on demand (never auto-crawled).
    const pick = () => {
      if (q.trim()) return serverItems;
      if (section === "recent") return serverItems;
      if (section === "starred") return index ? (starred.map((p) => itemAt(index, p)).filter(Boolean) as RcItem[]) : EMPTY;
      // all / shared: the LIVE listing is the source of truth (instant). If it's
      // empty or failed, fall back to an already-built index so folders still show.
      if (liveItems && liveItems.length) return liveItems;
      if (indexItems && indexItems.length) return indexItems;
      return liveItems ?? EMPTY;
    };
    // Drop exact double-listings of the SAME object (same provider id). Genuinely
    // distinct files that share a name (Drive allows this) are kept — they're
    // real duplicates in the drive, not a listing artifact.
    const seen = new Set<string>();
    return pick().filter((it) => {
      const k = it.ID ? `id:${it.ID}` : `p:${it.Path}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [index, q, section, starred, indexItems, liveItems, serverItems]);

  const items = useMemo(() => {
    return sortItems(base, sort, { sizeOf, dateOf, sizeKnown: sizeKnownOf });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, sort, index, browseSizes]);

  // Optional grouping (Type / Date / Size) over the sorted list — opt-in; "none"
  // yields a single unlabeled group so the render path is uniform.
  const grouped = groupBy !== "none";
  const groups = useMemo(
    () => groupItems(items, groupBy, { sizeOf, dateOf, sizeKnown: sizeKnownOf }, Date.now()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, groupBy, index, browseSizes],
  );
  // Apply the current sort to any listing (used by the Columns view's columns).
  const sortList = useCallback(
    (list: RcItem[]) => sortItems(list, sort, { sizeOf, dateOf, sizeKnown: sizeKnownOf }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sort, index, browseSizes],
  );
  // Sort + group any listing into sections (Columns view; macOS groups every view).
  const arrange = useCallback(
    (list: RcItem[]) => groupItems(sortList(list), groupBy, { sizeOf, dateOf, sizeKnown: sizeKnownOf }, Date.now()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sortList, groupBy, index, browseSizes],
  );

  // Row / card renderers shared by the flat and grouped paths (so grouping never
  // duplicates the per-item wiring).
  const renderGrid = (item: RcItem, gi: number) => (
    <FileGridItem
      key={item.ID ?? item.Path}
      item={item}
      gridIndex={gi}
      isSelected={selected.has(item.Path)}
      isDropTarget={item.IsDir && (item.Path === dropTarget || item.Path === moveOver)}
      blink={item.Path === blinkPath}
      folderSize={folderSizeState(item.Path)}
      folderCount={fileCountOf(item)}
      visited={item.IsDir && visitedSet.has(item.Path)}
      hasDownloads={item.IsDir && folderHasDownloads(item.Path)}
      status={folderStatusMap?.[item.Path] ?? (item.IsDir && folderHasDownloads(item.Path) ? ("downloaded" as const) : undefined)}
      dl={dlStatusMap.get(item.Path)}
      actions={rowActions}
    />
  );
  const renderRow = (item: RcItem) => (
    <FileRow
      key={item.ID ?? item.Path}
      item={item}
      isSelected={selected.has(item.Path)}
      isDropTarget={item.IsDir && (item.Path === dropTarget || item.Path === moveOver)}
      blink={item.Path === blinkPath}
      isStarred={starred.includes(item.Path)}
      dateStr={formatDate(dateOf(item))}
      folderSize={folderSizeState(item.Path)}
      folderCount={fileCountOf(item)}
      showCrawl={showCrawl}
      folderIndexedFlag={folderIndexed(item.Path)}
      visited={item.IsDir && visitedSet.has(item.Path)}
      hasDownloads={item.IsDir && folderHasDownloads(item.Path)}
      status={folderStatusMap?.[item.Path] ?? (item.IsDir && folderHasDownloads(item.Path) ? ("downloaded" as const) : undefined)}
      dl={dlStatusMap.get(item.Path)}
      actions={rowActions}
    />
  );

  // NOTE: folder sizes are no longer auto-computed for every visible folder.
  // Owned folders get an instant size from the persisted index; shared / unindexed
  // folders show a "Calculate" action (renderFolderSize) so we never silently
  // recursive-walk a huge shared drive the user didn't ask about.

  // Correct the ROW_HEIGHT guess against a real rendered row so the virtual
  // spacer heights (below) match actual scroll height instead of drifting.
  useLayoutEffect(() => {
    if (grid) return;
    const row = bodyRef.current?.querySelector<HTMLElement>("tbody tr[data-row]");
    const h = row?.getBoundingClientRect().height;
    if (h && h > 0 && Math.abs(h - rowHeight) > 0.5) setRowHeight(h);
  }, [items, grid, rowHeight]);

  const virtualRange = grid || columns ? { start: 0, end: items.length } : computeVirtualRange(scrollTop, viewportH, rowHeight, items.length);
  const visibleItems = items.slice(virtualRange.start, virtualRange.end);

  // Consume a pending highlight for THIS folder: select the item, scroll it into
  // view, and flash it. Runs once the target is present in `items`.
  const hlAccount = useHighlight((s) => s.accountId);
  const hlPath = useHighlight((s) => s.path);
  useEffect(() => {
    if (hlAccount !== account.id || !hlPath) return;
    const idx = items.findIndex((i) => i.Path === hlPath);
    if (idx === -1) return; // not loaded yet — wait for items to fill in
    const it = items[idx];
    useSelection.getState().add(account.id, [{ item: it, size: sizeOf(it) }]);
    // Center the row in the viewport (list view is virtualized by scrollTop).
    if (!grid && bodyRef.current && rowHeight > 0) {
      const target = Math.max(0, idx * rowHeight - bodyRef.current.clientHeight / 2 + rowHeight);
      bodyRef.current.scrollTop = target;
      setScrollTop(target);
    }
    setBlinkPath(hlPath);
    useHighlight.getState().clear();
    const t = setTimeout(() => setBlinkPath(null), 1800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hlAccount, hlPath, items, rowHeight, grid, account.id]);

  const allSelected = items.length > 0 && items.every((i) => selected.has(i.Path));
  // Totals span EVERY drive's selection (the bar aggregates cross-drive).
  const selectionAll = useSelection((s) => s.byAccount);
  const globalCount = totalSelectedCount(selectionAll);
  const globalSize = totalSelectedSize(selectionAll);
  const globalDrives = selectedDriveCount(selectionAll);

  // Shift+Click selects everything between the last-toggled row and this one
  // (inclusive) — the conventional Finder/Explorer/Gmail range-select. Only a
  // ref, not state: it doesn't need to trigger a render on its own. `list`
  // scopes the lookup + range to a specific listing (the columns view passes
  // the clicked column's items; list/grid default to the current folder).
  function toggle(p: string, shiftKey?: boolean, list?: RcItem[]) {
    const scope = list ?? items;
    const entryFor = (pp: string): SelectedItem | null => {
      const it = scope.find((i) => i.Path === pp);
      return it ? { item: it, size: sizeOf(it) } : null;
    };
    if (shiftKey && lastToggledPath.current) {
      const paths = scope.map((i) => i.Path);
      const a = paths.indexOf(lastToggledPath.current);
      const b = paths.indexOf(p);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const range = paths.slice(lo, hi + 1).map(entryFor).filter((e): e is SelectedItem => !!e);
        useSelection.getState().add(account.id, range);
        lastToggledPath.current = p;
        return;
      }
    }
    const e = entryFor(p);
    if (e) useSelection.getState().toggle(account.id, e);
    lastToggledPath.current = p;
  }

  // Upload local renders into the CURRENT folder. Editors connect their own
  // account and upload into a folder the owner shared with them (Editor
  // permission) — no credentials change hands. Dropbox links are read-only.
  const canUpload =
    folderView &&
    !searching &&
    !account.id.startsWith("dropboxlink_") &&
    (account.provider === "drive" || account.provider === "dropbox");
  async function pickUpload(directory: boolean) {
    setUploadOpen(false);
    const picked = await open(directory ? { directory: true, multiple: true } : { multiple: true });
    if (!picked) return;
    const paths = (Array.isArray(picked) ? picked : [picked]).filter((p): p is string => typeof p === "string");
    if (paths.length === 0) return;
    void useTransfers.getState().startUploads(account.id, paths, path);
  }

  // OS drag-and-drop upload: drop files/folders onto the browser to upload them.
  // Hovering a folder row targets THAT folder; the empty area targets the current
  // folder. Tauri reports the pointer in physical px, so divide by devicePixelRatio
  // before elementFromPoint (which wants CSS px).
  useEffect(() => {
    if (!canUpload) return;
    let un: (() => void) | undefined;
    let disposed = false;
    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const unlisten = await getCurrentWebview().onDragDropEvent((ev) => {
          const pl = ev.payload;
          const inApp = inAppDragRef.current; // an in-app move drag (vs external upload)
          if (pl.type === "leave") {
            dropTargetRef.current = null; setDropTarget(null);
            moveTargetRef.current = null; setMoveOver(null);
            return;
          }
          if (pl.type === "enter" || pl.type === "over") {
            // Tauri reports the pointer in PHYSICAL px on some platforms and
            // already-logical px on others. elementFromPoint wants CSS (logical)
            // px, so only scale an axis down when it exceeds the CSS viewport
            // (i.e. it's physical) — dividing an already-logical coord would
            // land the hit-test on the wrong (higher/left) row.
            const dpr = window.devicePixelRatio || 1;
            const x = pl.position.x > window.innerWidth ? pl.position.x / dpr : pl.position.x;
            const y = pl.position.y > window.innerHeight ? pl.position.y / dpr : pl.position.y;
            const el = document.elementFromPoint(x, y) as HTMLElement | null;
            const body = viewRef.current;
            const folderEl = el && body && body.contains(el) ? (el.closest("[data-folder-path]") as HTMLElement | null) : null;
            const folderPath = folderEl?.getAttribute("data-folder-path") ?? null;
            if (inApp) {
              // Move: highlight ONLY a valid destination folder — never the
              // background (dropping a folder into its own folder is a no-op).
              const tgt = folderPath !== null && canDropOnPath(folderPath) ? folderPath : null;
              if (tgt !== moveTargetRef.current) { moveTargetRef.current = tgt; setMoveOver(tgt); }
              return;
            }
            // Upload: folder under cursor, else the current folder (background).
            const inBody = !!(el && body && body.contains(el));
            const tgt = inBody ? (folderPath ?? "") : null;
            if (tgt !== dropTargetRef.current) { dropTargetRef.current = tgt; setDropTarget(tgt); }
            return;
          }
          if (pl.type === "drop") {
            if (inApp) {
              const dragged = draggedRef.current;
              // Dropped on the Transfers drawer → download it (like Download).
              const dpr = window.devicePixelRatio || 1;
              const dx = pl.position.x > window.innerWidth ? pl.position.x / dpr : pl.position.x;
              const dy = pl.position.y > window.innerHeight ? pl.position.y / dpr : pl.position.y;
              const onDrawer = (document.elementFromPoint(dx, dy) as HTMLElement | null)?.closest("[data-transfer-drop]");
              if (onDrawer && dragged) {
                void enqueueItems([dragged]);
              } else if (moveTargetRef.current !== null) {
                void performMoveToPath(moveTargetRef.current, false);
              }
              inAppDragRef.current = false; draggedRef.current = null;
              moveTargetRef.current = null; setMoveOver(null);
              useTransfers.getState().setDragActive(false);
              return;
            }
            const tgt = dropTargetRef.current;
            dropTargetRef.current = null; setDropTarget(null);
            if (tgt === null) return; // dropped outside the browser body
            const paths = (pl.paths ?? []).filter((p): p is string => typeof p === "string");
            if (paths.length === 0) return;
            void useTransfers.getState().startUploads(account.id, paths, tgt === "" ? path : tgt);
          }
        });
        if (disposed) unlisten(); else un = unlisten;
      } catch { /* not running inside a Tauri webview (e.g. tests) */ }
    })();
    return () => { disposed = true; un?.(); dropTargetRef.current = null; setDropTarget(null); };
  }, [canUpload, account.id, path]);

  // Queue a set of items, always prompting for a destination folder.
  async function enqueueItems(its: RcItem[]) {
    if (its.length === 0) return;
    const dest = await pickDownloadDest();
    if (!dest) return;
    // Drive folder-shortcuts download via their id-rooted linked folder (their
    // Path can't be reached over shared_with_me); everything else queues directly.
    for (const l of its.filter((i) => i.LinkFolderId)) {
      await downloadShortcutFolder(account.id, l.Name, l.LinkFolderId!, dest);
    }
    const normal = its.filter((i) => !i.LinkFolderId);
    if (normal.length === 0) return;
    const chosen: DownloadItem[] = normal.map((i) => ({ path: i.Path, name: i.Name, isDir: i.IsDir, size: sizeOf(i), id: i.ID ?? "" }));
    enqueue(account.id, chosen, dest);
    toast(`Queued ${chosen.length} download${chosen.length === 1 ? "" : "s"}`, "success");
  }

  // Download EVERY selected item across ALL drives (the selection persists across
  // drives), then clear the whole selection.
  async function download() {
    const byAccount = useSelection.getState().byAccount;
    if (totalSelectedCount(byAccount) === 0) return;
    const dest = await pickDownloadDest();
    if (!dest) return;
    let queued = 0;
    for (const [accId, map] of Object.entries(byAccount)) {
      const entries = Object.values(map);
      if (entries.length === 0) continue;
      // Drive folder-shortcuts route through their id-rooted linked folder.
      for (const e of entries.filter((e) => e.item.LinkFolderId)) {
        await downloadShortcutFolder(accId, e.item.Name, e.item.LinkFolderId!, dest);
        queued += 1;
      }
      const normal = entries.filter((e) => !e.item.LinkFolderId);
      if (normal.length === 0) continue;
      const chosen: DownloadItem[] = normal.map((e) => ({ path: e.item.Path, name: e.item.Name, isDir: e.item.IsDir, size: e.size, id: e.item.ID ?? "" }));
      enqueue(accId, chosen, dest);
      queued += chosen.length;
    }
    useSelection.getState().clearAll();
    toast(`Queued ${queued} download${queued === 1 ? "" : "s"}`, "success");
  }

  // Stable row-facing callbacks: FileRow/FileGridItem are memoized, and every
  // closure above (enqueueItems, reviewTarget, indexFolder, etc.) is recreated
  // on every render, so passing them straight through would defeat the memo.
  // The ref always holds the LATEST closures; the wrappers below never change
  // identity, so rows only re-render when their own props actually change.
  const actionsRef = useRef<RowActions>(null!);
  actionsRef.current = {
    toggle,
    openFolder: (p) => navigate("all", p),
    openDir: (item) =>
      item.LinkFolderId
        ? void openShortcutFolder(account.id, item.Name, item.LinkFolderId)
        : navigate("all", item.Path),
    focus: (item) => setFocused(item),
    openPreview: (item) => usePreview.getState().open(account.id, reviewTarget(item)),
    openReview: (item) => openReview(account.id, reviewTarget(item)),
    download: (item) => void enqueueItems([item]),
    share: (item, anchor) => setShare({ item, anchor }),
    indexFolder,
    calcSize,
    toggleStar: (p) => toggleStar(account.id, p),
    deleteOne: (item) => setPendingDelete([item]),
    contextMenu: (x, y, item) => setMenu({ x, y, item }),
    dragStart: (item) => { draggedRef.current = item; inAppDragRef.current = true; useTransfers.getState().setDragActive(true); },
    dragEnd: () => { draggedRef.current = null; inAppDragRef.current = false; setMoveOver(null); useTransfers.getState().setDragActive(false); },
    dragOverFolder: (folder) => {
      if (!canDropOn(folder)) return false;
      if (moveOver !== folder.Path) setMoveOver(folder.Path);
      return true;
    },
    drop: (folder, copy) => void performMove(folder, copy),
  };
  const rowActions = useRef<RowActions>({
    toggle: (p, shiftKey, list) => actionsRef.current.toggle(p, shiftKey, list),
    openFolder: (p) => actionsRef.current.openFolder(p),
    openDir: (item) => actionsRef.current.openDir(item),
    focus: (item) => actionsRef.current.focus(item),
    openPreview: (item) => actionsRef.current.openPreview(item),
    openReview: (item) => actionsRef.current.openReview(item),
    download: (item) => actionsRef.current.download(item),
    share: (item, anchor) => actionsRef.current.share(item, anchor),
    indexFolder: (p) => actionsRef.current.indexFolder(p),
    calcSize: (p) => actionsRef.current.calcSize(p),
    toggleStar: (p) => actionsRef.current.toggleStar(p),
    deleteOne: (item) => actionsRef.current.deleteOne(item),
    contextMenu: (x, y, item) => actionsRef.current.contextMenu(x, y, item),
    dragStart: (item) => actionsRef.current.dragStart(item),
    dragEnd: () => actionsRef.current.dragEnd(),
    dragOverFolder: (folder) => actionsRef.current.dragOverFolder(folder),
    drop: (folder, copy) => actionsRef.current.drop(folder, copy),
  }).current;

  // Build the right-click menu for one item — reuses every existing row action.
  const menuItems = (item: RcItem): MenuItem[] => {
    const isStar = starred.includes(item.Path);
    const out: MenuItem[] = [];
    if (item.IsDir) {
      out.push({ label: "Open", icon: FolderOpen, onClick: () => actionsRef.current.openDir(item) });
      out.push({ label: "Calculate size", icon: Calculator, onClick: () => calcSize(item.Path) });
      out.push({ label: folderIndexed(item.Path) ? "Re-index folder" : "Index folder", icon: FolderSearch, disabled: showCrawl, onClick: () => indexFolder(item.Path) });
      // Manual workflow status — nested submenu keeps the parent menu tidy.
      // Clicking the active status clears it.
      const cur = folderStatusMap?.[item.Path];
      const STATUS_ICON = { downloading: Download, on_hold: Pause, downloaded: Check, copied: HardDrive } as const;
      out.push({
        label: cur ? `Status: ${FOLDER_STATUS_META[cur].label}` : "Status",
        icon: cur ? STATUS_ICON[cur] : Tag,
        separator: true,
        children: FOLDER_STATUS_ORDER.map((st) => ({
          label: cur === st ? `${FOLDER_STATUS_META[st].label} ✓` : FOLDER_STATUS_META[st].label,
          icon: STATUS_ICON[st],
          onClick: () => setFolderStatus(account.id, item.Path, cur === st ? null : st),
        })),
      });
    } else if (isPreviewable(item.Name)) {
      out.push({ label: "Preview", icon: Eye, onClick: () => usePreview.getState().open(account.id, reviewTarget(item)) });
      out.push({ label: "Review", icon: Play, onClick: () => openReview(account.id, reviewTarget(item)) });
    }
    out.push({ label: "Download", icon: Download, onClick: () => void enqueueItems([item]) });
    out.push({ label: isStar ? "Unstar" : "Star", icon: Star, onClick: () => toggleStar(account.id, item.Path) });
    if (canUpload) out.push({ label: "Move to…", icon: FolderInput, separator: true, onClick: () => setMoveItems(selected.has(item.Path) && selected.size > 1 ? items.filter((i) => selected.has(i.Path)) : [item]) });
    out.push({ label: "Copy link", icon: Link2, separator: !canUpload, onClick: () => setShare({ item, anchor: { x: menu?.x ?? window.innerWidth / 2, y: menu?.y ?? window.innerHeight / 2 } }) });
    out.push({ label: "Copy name", icon: Copy, onClick: () => void navigator.clipboard?.writeText(item.Name) });
    out.push({ label: "Delete", icon: Trash2, danger: true, separator: true, onClick: () => setPendingDelete([item]) });
    return out;
  };

  // Menu for right-clicking the empty space of a folder view (no item under it).
  const bgMenuItems = (): MenuItem[] => {
    const out: MenuItem[] = [];
    // Sort + Group submenus — the only way to sort in Columns view (no headers).
    const SORT_FIELDS: { f: SortField; label: string }[] = [
      { f: "name", label: "Name" }, { f: "modified", label: "Date modified" },
      { f: "size", label: "Size" }, { f: "type", label: "Type" },
    ];
    out.push({
      label: "Sort by",
      icon: ArrowDownUp,
      children: [
        ...SORT_FIELDS.map((s) => ({
          label: sort.field === s.f ? `${s.label} ✓` : s.label,
          onClick: () => setSort((cur) => ({ ...cur, field: s.f })),
        })),
        { label: sort.dir === "asc" ? "Ascending ✓" : "Ascending", icon: ArrowUp, separator: true, onClick: () => setSort((cur) => ({ ...cur, dir: "asc" })) },
        { label: sort.dir === "desc" ? "Descending ✓" : "Descending", icon: ArrowDown, onClick: () => setSort((cur) => ({ ...cur, dir: "desc" })) },
        { label: sort.foldersFirst ? "Folders first ✓" : "Folders first", icon: FolderTree, separator: true, onClick: () => setSort((cur) => ({ ...cur, foldersFirst: !cur.foldersFirst })) },
      ],
    });
    out.push({
      label: "Group by",
      icon: Layers,
      children: ([
        { g: "none" as const, label: "None" }, { g: "type" as const, label: "Type" },
        { g: "date" as const, label: "Date modified" }, { g: "size" as const, label: "Size" },
      ]).map(({ g, label }) => ({ label: groupBy === g ? `${label} ✓` : label, onClick: () => setGroupBy(g) })),
    });
    if (folderView) out.push({ label: "New folder", icon: FolderPlus, separator: true, onClick: () => setNewFolder("") });
    if (canUpload) {
      out.push({ label: "Upload files…", icon: FileUp, separator: out.length > 0, onClick: () => void pickUpload(false) });
      out.push({ label: "Upload folder…", icon: FolderUp, onClick: () => void pickUpload(true) });
    }
    if (items.length > 0) {
      out.push({ label: "Select all", icon: Check, separator: out.length > 0, onClick: () => useSelection.getState().add(account.id, items.map((i) => ({ item: i, size: sizeOf(i) }))) });
    }
    out.push({ label: "Refresh", icon: RefreshCw, separator: out.length > 0, onClick: () => void useBrowse.getState().ensure(account, path) });
    return out;
  };

  const segments = path ? path.split("/") : [];
  const showCrawl = status === "crawling" || status === "loading";
  // Folder views spin only while the LIVE listing is loading; Recent/Starred/Search
  // spin while their background index is still building.
  // Search + Recent spin on the live server query; folder views on the live list;
  // Starred never spins (it reads an already-built index or shows empty).
  const onServerQuery = q.trim().length > 0 || section === "recent";
  const spinner = onServerQuery
    ? serverState === "loading"
    : folderView
      ? liveLoading && items.length === 0
      : false;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Indexing/crawl progress is shown by the floating IndexBanner, not here. */}

      {/* Live-listing error (so a failed folder list isn't a silent empty screen). */}
      {folderView && liveError && (
        <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-5 py-2.5 text-sm text-[var(--error)]">
          <AlertCircle size={15} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={liveError}>
            {/not found/i.test(liveError)
              ? "This folder isn’t available anymore — it may have been unshared, renamed, or moved on the cloud. Go back and Refresh."
              : `Couldn’t list this folder: ${liveError}`}
          </span>
          <button className="shrink-0 underline hover:text-[var(--text)]" onClick={() => void useBrowse.getState().ensure(account, path)}>Retry</button>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-3 px-6 py-4">
        {/* Back / Forward / Up — history-based navigation (also Alt+←/→ and the
            mouse back/forward buttons, wired globally in AppShell). Hidden when
            embedded — global history would fight the host panel's own navigation. */}
        {!embedded && (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              onClick={goBack}
              disabled={!canGoBack}
              aria-label="Back"
              data-tip="Back"
              className="flex h-8 w-8 items-center justify-center rounded-[7px] text-[var(--mut)] transition-colors hover:bg-[var(--soft)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <ChevronLeft size={17} />
            </button>
            <button
              onClick={goForward}
              disabled={!canGoForward}
              aria-label="Forward"
              data-tip="Forward"
              className="flex h-8 w-8 items-center justify-center rounded-[7px] text-[var(--mut)] transition-colors hover:bg-[var(--soft)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <ChevronRight size={17} />
            </button>
          </div>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden px-1 py-1.5 font-mono text-[11.5px]">
          <ProviderIcon provider={account.provider} size={13} />
          {q.trim() ? (
            <span className="truncate text-[var(--mut)]">Search results for “{q}”</span>
          ) : folderView ? (
            <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
              <button
                className={`min-w-0 shrink-[2] truncate hover:text-[var(--ink)] ${segments.length === 0 ? "font-semibold text-[var(--ink)]" : "text-[var(--mut)]"}`}
                onClick={() => navigate(section, "")}
                data-tip={displayLabel}
              >
                {displayLabel}
              </button>
              {/* Very deep paths collapse to root / … / current so the bar never
                  overflows. "…" jumps to the parent folder (full path in its
                  tooltip). Shallower paths show every segment. */}
              {segments.length > 4 && (
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className="text-[var(--faint)]">/</span>
                  <button
                    className="text-[var(--mut)] hover:text-[var(--ink)]"
                    data-tip={segments.slice(0, -1).join(" / ")}
                    aria-label="Parent folders"
                    onClick={() => navigate(section, segments.slice(0, -1).join("/"))}
                  >
                    …
                  </button>
                </span>
              )}
              {(segments.length > 4 ? [segments.length - 1] : segments.map((_, i) => i)).map((i) => {
                const seg = segments[i];
                const last = i === segments.length - 1;
                return (
                  <span key={i} className="flex min-w-0 items-center gap-1.5">
                    <span className="text-[var(--faint)]">/</span>
                    <button
                      className={`truncate hover:text-[var(--ink)] ${last ? "font-semibold text-[var(--ink)]" : "max-w-[160px] shrink-[2] text-[var(--mut)]"}`}
                      onClick={() => setView({ kind: "browse", accountId: account.id, section, path: segments.slice(0, i + 1).join("/") })}
                      data-tip={seg}
                    >
                      {seg}
                    </button>
                  </span>
                );
              })}
            </div>
          ) : (
            <span className="truncate font-semibold text-[var(--ink)]">{SECTION_TITLE[section]}</span>
          )}
        </div>
      </div>

      {/* Second toolbar row: section pills left, action controls right — the
          controls live here so the breadcrumb above gets the full width. */}
      <div className="flex items-center gap-3 px-6 pb-3">
        {!embedded && !q.trim() && (
          <div className="flex items-center gap-1.5">
            {/* "Shared with me" pill dropped — the Shared Drives screen covers it. */}
            {(Object.keys(SECTION_TITLE) as Section[]).filter((k) => k !== "shared").map((k) => {
              const on = section === k;
              return (
                <button
                  key={k}
                  onClick={() => navigate(k, "")}
                  className={`h-8 rounded-full border px-[15px] text-[12.5px] font-semibold ${
                    on
                      ? "border-[var(--acc)] bg-[var(--acc)] text-[var(--onacc)]"
                      : "border-[var(--line)] bg-[var(--card)] text-[var(--mut)] hover:border-[var(--line2)]"
                  }`}
                >
                  {SECTION_TITLE[k]}
                </button>
              );
            })}
          </div>
        )}
        <div className="flex-1" />

        {/* Upload local files/folders into the current folder (files land where
            you're looking). Hidden on read-only sources (Dropbox links). */}
        {canUpload && (
          <div className="relative">
            <button
              onClick={() => setUploadOpen((o) => !o)}
              data-tip="Upload here"
              className="flex items-center gap-2 rounded-[8px] border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            >
              <Upload size={15} /> Upload <ChevronDown size={13} />
            </button>
            {uploadOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setUploadOpen(false)} />
                <div className="animate-pop absolute right-0 top-9 z-20 w-44 overflow-hidden rounded-[8px] border border-[var(--border-strong)] bg-[var(--card)] py-1 shadow-[var(--shadow-lg)]" style={{ transformOrigin: "top right" }}>
                  <button
                    onClick={() => void pickUpload(false)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                  >
                    <FileUp size={14} /> Upload files…
                  </button>
                  <button
                    onClick={() => void pickUpload(true)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                  >
                    <FolderUp size={14} /> Upload folder…
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Sorting moved into the list-view column headers (click a header to
            sort, click again to flip). Only folders-first stays as a toggle. */}
        <button
          onClick={() => setSort((s) => ({ ...s, foldersFirst: !s.foldersFirst }))}
          title="Folders first"
          aria-label="Folders first"
          className={`rounded-[8px] border border-[var(--border)] p-1.5 transition-colors hover:text-[var(--text)] ${sort.foldersFirst ? "text-[var(--text)]" : "text-[var(--text-3)]"}`}
        >
          <FolderTree size={15} />
        </button>

        <div className="flex rounded-[9px] border border-[var(--border)] bg-[var(--soft)] p-0.5">
          {([
            { m: "columns" as const, Icon: Columns3, label: "Columns" },
            { m: "list" as const, Icon: ListIcon, label: "List" },
            { m: "grid" as const, Icon: LayoutGrid, label: "Grid" },
          ]).map(({ m, Icon, label }) => (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              aria-label={`${label} view`}
              title={`${label} view`}
              className={`flex h-[26px] items-center gap-1.5 rounded-[7px] px-2.5 text-[11.5px] font-semibold transition-colors ${view === m ? "bg-[var(--card)] text-[var(--ink)] shadow-[var(--shadow)]" : "text-[var(--faint)] hover:text-[var(--mut)]"}`}
            >
              <Icon size={13} /> <span className="hidden lg:inline">{label}</span>
            </button>
          ))}
        </div>
        {/* Group by — Type / Date / Size (or none). Applies to List + Grid. */}
        <div className="relative">
          <button
            onClick={() => setGroupOpen((o) => !o)}
            title="Group by"
            aria-label="Group by"
            className={`rounded-[8px] border border-[var(--border)] p-1.5 transition-colors hover:text-[var(--text)] ${groupBy !== "none" ? "text-[var(--acc)]" : "text-[var(--text-3)]"}`}
          >
            <Layers size={15} />
          </button>
          {groupOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setGroupOpen(false)} />
              <div className="animate-pop absolute right-0 top-9 z-20 w-40 overflow-hidden rounded-[8px] border border-[var(--border-strong)] bg-[var(--card)] py-1 shadow-[var(--shadow-lg)]" style={{ transformOrigin: "top right" }}>
                {([
                  { g: "none" as const, label: "No grouping" },
                  { g: "type" as const, label: "Type" },
                  { g: "date" as const, label: "Date modified" },
                  { g: "size" as const, label: "Size" },
                ]).map(({ g, label }) => (
                  <button
                    key={g}
                    onClick={() => { setGroupBy(g); setGroupOpen(false); }}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                  >
                    {label} {groupBy === g && <Check size={14} className="text-[var(--acc)]" />}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <button
          className={`rounded-[8px] border border-[var(--border)] p-1.5 transition-colors hover:text-[var(--text)] ${showPreview ? "text-[var(--text)]" : "text-[var(--text-3)]"}`}
          onClick={() => setShowPreview((v) => !v)}
          aria-label={showPreview ? "Hide preview" : "Show preview"}
          title={showPreview ? "Hide preview" : "Show preview"}
        >
          {showPreview ? <PanelRightClose size={15} /> : <PanelRight size={15} />}
        </button>
        <button className="rounded-[8px] border border-[var(--border)] p-1.5 text-[var(--text-3)] hover:text-[var(--text)] disabled:opacity-50" onClick={() => useIndex.getState().recrawl(account)} disabled={showCrawl} aria-label="Re-index" title="Re-index"><RefreshCw size={15} className={showCrawl ? "animate-spin" : ""} /></button>
        {folderView && (
          <button className="rounded-[8px] border border-[var(--border)] p-1.5 text-[var(--text-3)] transition-colors hover:text-[var(--text)]" onClick={() => setNewFolder("")} aria-label="New folder" title="New folder"><FolderPlus size={15} /></button>
        )}
      </div>

      {/* Main area: file view + right preview panel */}
      <div ref={viewRef} className="flex min-h-0 flex-1 border-t border-[var(--line)]">
      <div
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        onContextMenu={(e) => {
          // Only when right-clicking empty space — rows/cards handle their own.
          if ((e.target as HTMLElement).closest("[data-row],[data-item]")) return;
          if (!folderView && !canUpload && items.length === 0) return;
          e.preventDefault();
          setBgMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {status === "error" && (
          <div className="mb-3 flex items-center gap-2 rounded-[8px] border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--error)]">
            <AlertCircle size={16} /> {entry?.error}
            <button className="ml-2 underline" onClick={() => useIndex.getState().recrawl(account)}>retry</button>
          </div>
        )}

        {spinner && !(columns && folderView && !q.trim()) ? (
          <FileListSkeleton />
        ) : serverState === "error" ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-sm text-[var(--mut)]">
            <AlertCircle size={18} className="text-[var(--err)]" /> Couldn’t search this account. Check the connection and try again.
          </div>
        ) : serverState === "dropbox-recent" ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-sm text-[var(--mut)]">
            Recent isn’t available for Dropbox. Use <span className="font-semibold text-[var(--ink)]">Search</span> or browse <span className="font-semibold text-[var(--ink)]">All Files</span>.
          </div>
        ) : columns && folderView && !q.trim() ? (
          // Columns handles its own loading/empty per column, so parent columns
          // stay visible while a newly opened folder loads. Search/Recent/Starred
          // results always render as a flat list.
          <ColumnsView account={account} rootLabel={displayLabel} path={path} focusedPath={focused?.Path ?? null} selectedPaths={selected} folderSizeState={folderSizeState} dropTarget={dropTarget ?? moveOver} actions={rowActions} visitedSet={visitedSet} folderHasDownloads={folderHasDownloads} folderStatusMap={folderStatusMap} dlStatusMap={dlStatusMap} arrange={arrange} onMarquee={startMarquee} />
        ) : items.length === 0 ? (
          <div className="flex-1 px-6 pt-4"><BrowseEmptyState q={q} section={section} /></div>
        ) : (
          <div ref={bodyRef} onMouseDown={startMarquee} className="@container min-h-0 flex-1 overflow-auto px-6 pb-2" data-testid="file-list">
          {grid ? (
          grouped ? (
            groups.map((g) => (
              <section key={g.key}>
                <GroupHeader label={g.label} count={g.items.length} />
                <div className="grid grid-cols-[repeat(auto-fill,minmax(136px,1fr))] gap-1 pb-3 pt-1">
                  {g.items.map((item, gi) => renderGrid(item, gi))}
                </div>
              </section>
            ))
          ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(136px,1fr))] gap-1 py-2">
            {items.map((item, gi) => renderGrid(item, gi))}
          </div>
        )) : (
          <table className="w-full table-fixed border-collapse text-sm">
            <thead>
              <tr className="sticky top-0 z-10 bg-[var(--surface)] text-left text-xs text-[var(--text-3)]">
                <th className="w-9 py-2.5 pl-1"><input type="checkbox" aria-label="Select all" checked={allSelected} onChange={() => (allSelected ? useSelection.getState().clearAccount(account.id) : useSelection.getState().add(account.id, items.map((i) => ({ item: i, size: sizeOf(i) }))))} /></th>
                {/* Clickable headers: click to sort by that column, click again
                    to flip ascending/descending. Arrow marks the active field. */}
                {([
                  { f: "name" as const, label: "Name", th: "py-2.5 font-medium" },
                  { f: "modified" as const, label: "Modified", th: "hidden w-32 whitespace-nowrap py-2.5 font-medium lg:table-cell" },
                  { f: "size" as const, label: "Size", th: "w-24 whitespace-nowrap py-2.5 text-right font-medium" },
                  { f: "type" as const, label: "Type", th: "hidden w-24 py-2.5 pl-6 font-medium lg:table-cell" },
                ]).map(({ f, label, th }) => (
                  <th key={f} className={th}>
                    <button
                      onClick={() => setSort((s) => (s.field === f ? { ...s, dir: s.dir === "asc" ? "desc" : "asc" } : { ...s, field: f, dir: "asc" }))}
                      title={`Sort by ${label.toLowerCase()}`}
                      className={`inline-flex items-center gap-1 font-medium transition-colors hover:text-[var(--text)] ${sort.field === f ? "text-[var(--text)]" : ""}`}
                    >
                      {label}
                      {sort.field === f && (sort.dir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grouped ? (
                // Grouped: header rows + all items (virtualization off — opt-in).
                groups.map((g) => (
                  <Fragment key={g.key}>
                    <tr className="bg-[var(--surface)]">
                      <td colSpan={5} className="pb-1 pl-1 pt-4">
                        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--faint)]">{g.label} · {g.items.length}</span>
                      </td>
                    </tr>
                    {g.items.map((item) => renderRow(item))}
                  </Fragment>
                ))
              ) : (
                <>
                  {/* Spacer rows reserve the scroll height of the rows scrolled past
                      above/below the window, so the scrollbar and sticky header stay
                      accurate without every row actually being mounted. */}
                  {virtualRange.start > 0 && (
                    <tr aria-hidden style={{ height: virtualRange.start * rowHeight }}>
                      <td colSpan={5} />
                    </tr>
                  )}
                  {visibleItems.map((item) => renderRow(item))}
                  {virtualRange.end < items.length && (
                    <tr aria-hidden style={{ height: (items.length - virtualRange.end) * rowHeight }}>
                      <td colSpan={5} />
                    </tr>
                  )}
                </>
              )}
            </tbody>
          </table>
          )}
          </div>
        )}

        {/* Marquee rubber-band rectangle (viewport-anchored). Fades + shrinks
            slightly on release, like macOS. */}
        {marquee && (
          <div
            className="pointer-events-none fixed z-[55] border border-[var(--acc)] bg-[var(--acc)]/10 ease-out"
            style={{
              left: marquee.x0, top: marquee.y0,
              width: marquee.x1 - marquee.x0, height: marquee.y1 - marquee.y0,
              opacity: marquee.leaving ? 0 : 1,
              transition: marquee.leaving ? "opacity 320ms ease-out" : "none",
            }}
          />
        )}

        {/* Drop overlay — shown while dragging over the background (upload to the
            CURRENT folder). Hovering a folder row highlights that row instead. */}
        {dropTarget === "" && (
          <div className="animate-fade pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-[14px] border-2 border-dashed border-[var(--acc)] bg-[var(--accw)]">
            <div className="animate-pop flex items-center gap-2.5 rounded-[13px] border border-[var(--line2)] bg-[var(--card)] px-4 py-2.5 shadow-[var(--shadow-lg)]">
              <FileUp size={15} className="text-[var(--acc)]" />
              <span className="text-[12.5px] font-semibold text-[var(--ink)]">
                Drop to upload to <span className="text-[var(--acc)]">{segments.length ? segments[segments.length - 1] : displayLabel}</span>
              </span>
            </div>
          </div>
        )}

        {/* Floating selection pill — spans EVERY drive's selection. */}
        {globalCount > 0 && (
          <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3.5 rounded-[13px] border border-[var(--line2)] bg-[var(--card)] py-2 pl-4 pr-2.5 shadow-[var(--shadow-lg)]">
            <span className="whitespace-nowrap font-mono text-[11.5px] text-[var(--ink)]">
              <span className="font-semibold">{globalCount} selected</span>
              <span className="text-[var(--faint)]"> · {formatBytes(globalSize)}{globalDrives > 1 ? ` · ${globalDrives} drives` : ""}</span>
            </span>
            <button onClick={() => useSelection.getState().clearAll()} className="text-[12px] font-semibold text-[var(--mut)] hover:text-[var(--ink)]">Clear</button>
            {selected.size > 0 && canUpload && (
              <button onClick={() => setMoveItems(items.filter((i) => selected.has(i.Path)))} className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--mut)] hover:text-[var(--ink)]">
                <FolderInput size={13} /> Move
              </button>
            )}
            {selected.size > 0 && (
              <button onClick={() => setPendingDelete(items.filter((i) => selected.has(i.Path)))} className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--mut)] hover:text-[var(--err)]">
                <Trash2 size={13} /> Delete
              </button>
            )}
            <button onClick={download} className="flex items-center gap-2 rounded-[9px] bg-[var(--acc)] px-3.5 py-1.5 text-[12.5px] font-semibold text-[var(--onacc)] hover:opacity-90">
              <Download size={14} /> Download{globalDrives > 1 ? " all" : ""}
            </button>
          </div>
        )}
      </div>

      {/* Right preview panel — toggleable so it doesn't obstruct browsing */}
      {showPreview && (
      <PreviewPanel
        item={focused}
        rootLabel={displayLabel}
        currentFolderName={segments.length ? segments[segments.length - 1] : displayLabel}
        size={focused ? sizeOf(focused) : 0}
        dateStr={focused ? formatDate(dateOf(focused)) : ""}
        parentName={segments.length ? segments[segments.length - 1] : "ROOT"}
        isStarred={focused ? starred.includes(focused.Path) : false}
        dl={focused ? dlStatusMap.get(focused.Path) : undefined}
        folderSize={focused && focused.IsDir ? folderSizeState(focused.Path) : undefined}
        folderStats={folderStats(focused && focused.IsDir ? focused.Path : path)}
        onIndexFolder={() => indexFolder(focused && focused.IsDir ? focused.Path : path)}
        indexing={showCrawl}
        actions={rowActions}
      />
      )}
      </div>

      {/* Status footer */}
      <div className="flex items-center justify-between border-t border-[var(--line)] px-4 py-1.5 font-mono text-[10px]">
        <span className="text-[var(--faint)]">
          {items.filter((i) => i.IsDir).length} FOLDERS · {items.filter((i) => !i.IsDir).length} FILES
        </span>
        <span style={{ color: activeDownloads > 0 ? "var(--acc)" : "var(--faint)" }}>
          {activeDownloads > 0 ? `${activeDownloads} DOWNLOADING` : "IDLE"}
        </span>
      </div>

      {/* Delete confirmation (cloud deletes go to the provider Trash — recoverable). */}
      {pendingDelete && pendingDelete.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-6" onClick={() => !deleting && setPendingDelete(null)}>
          <div className="w-full max-w-md rounded-[12px] border border-[var(--border-strong)] bg-[var(--card)] p-5 shadow-[var(--shadow-lg)]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 text-[var(--text)]">
              <Trash2 size={18} className="text-[var(--error)]" />
              <h2 className="text-base font-semibold">
                Delete {pendingDelete.length === 1 ? pendingDelete[0].Name : `${pendingDelete.length} items`}?
              </h2>
            </div>
            <p className="mt-2 text-sm text-[var(--text-2)]">
              {pendingDelete.some((i) => i.IsDir) ? "This includes folders and everything inside them. " : ""}
              It's removed from <span className="text-[var(--text)]">{displayLabel}</span> and moved to the provider's Trash
              (Google Drive Trash / Dropbox history), recoverable there for a limited time.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPendingDelete(null)} disabled={deleting}>Cancel</Button>
              <Button variant="danger" onClick={confirmDelete} disabled={deleting}>
                {deleting ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />} Delete
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* New-folder dialog — name it, then create in the current folder. */}
      {newFolder !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-6" onClick={() => !creatingFolder && setNewFolder(null)}>
          <div className="animate-pop w-full max-w-sm rounded-[12px] border border-[var(--border-strong)] bg-[var(--card)] p-5 shadow-[var(--shadow-lg)]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 text-[var(--text)]">
              <FolderPlus size={18} className="text-[var(--acc)]" />
              <h2 className="text-base font-semibold">New folder</h2>
            </div>
            <p className="mt-1.5 text-[12.5px] text-[var(--text-2)]">
              In <span className="font-mono text-[var(--text)]">{segments.length ? segments[segments.length - 1] : displayLabel}</span>
            </p>
            <input
              autoFocus
              value={newFolder}
              placeholder="Folder name"
              onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitNewFolder();
                else if (e.key === "Escape") setNewFolder(null);
              }}
              className="mt-3 w-full rounded-[9px] border border-[var(--line2)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-3)] focus:border-[var(--acc)]"
            />
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setNewFolder(null)} disabled={creatingFolder}>Cancel</Button>
              <Button variant="download" onClick={() => void submitNewFolder()} disabled={!newFolder.trim() || creatingFolder}>
                {creatingFolder ? <Loader2 size={16} className="animate-spin" /> : <FolderPlus size={16} />} Create
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Right-click context menu (an item, or the empty background) */}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.item)} onClose={() => setMenu(null)} />}
      {bgMenu && <ContextMenu x={bgMenu.x} y={bgMenu.y} items={bgMenuItems()} onClose={() => setBgMenu(null)} />}
      {share && <SharePopover account={account} item={share.item} anchor={share.anchor} onClose={() => setShare(null)} />}
      {moveItems && moveItems.length > 0 && <MoveDialog account={account} items={moveItems} onClose={() => setMoveItems(null)} onMoved={() => setMoveItems(null)} />}
    </div>
  );
}

/** A single hover-revealed row action (index / star / delete). Fixed 28px box so
 *  the cluster reserves consistent width and toggling opacity never shifts layout. */
function RowAction({
  onClick,
  disabled,
  tip,
  label,
  active,
  danger,
  green,
  children,
}: {
  onClick: (e: React.MouseEvent) => void;
  disabled?: boolean;
  tip: string;
  label: string;
  active?: boolean;
  danger?: boolean;
  green?: boolean;
  children: ReactNode;
}) {
  const hover = danger ? "hover:text-[var(--err)]" : green ? "hover:text-[var(--dl)]" : "hover:text-[var(--acc)]";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      data-rowbtn
      data-tip={tip}
      aria-label={label}
      className={`flex h-6 w-6 items-center justify-center rounded-[6px] hover:bg-[var(--soft)] disabled:opacity-40 ${
        active ? "text-[var(--acc)]" : `text-[var(--faint)] ${hover}`
      }`}
    >
      {children}
    </button>
  );
}

/**
 * One list-view row. Memoized: without this, resolving a folder's size (which
 * updates `browseSizes` and re-triggers the `items` sort) or ticking the
 * selection Set for one row re-rendered every visible row on every folder in
 * the account. Props are per-row primitives/derived values (not raw store
 * state) precisely so the comparator can tell "did THIS row change".
 */
const FileRow = memo(function FileRow({
  item,
  isSelected,
  isDropTarget,
  blink,
  isStarred,
  dateStr,
  folderSize,
  folderCount,
  showCrawl,
  folderIndexedFlag,
  visited,
  hasDownloads,
  status,
  dl,
  actions,
}: {
  item: RcItem;
  isSelected: boolean;
  isDropTarget: boolean;
  blink: boolean;
  isStarred: boolean;
  dateStr: string;
  folderSize: FolderSizeState;
  folderCount: number | undefined;
  showCrawl: boolean;
  folderIndexedFlag: boolean;
  visited: boolean;
  hasDownloads: boolean;
  status: FolderStatus | undefined;
  dl: DlStatus | undefined;
  actions: RowActions;
}) {
  const ft = fileType(item.Name, item.IsDir);
  const ext = extOf(item.Name).replace(/^\./, "").slice(0, 4).toUpperCase();
  const sub = item.IsDir
    ? folderCount != null
      ? `${folderCount.toLocaleString()} file${folderCount === 1 ? "" : "s"}`
      : ""
    : `${ext || "FILE"}${item.Size > 0 ? ` · ${formatBytes(item.Size)}` : ""}`;
  const video = !item.IsDir && isVideo(item.Name);
  const previewableFlag = !item.IsDir && isPreviewable(item.Name);
  const [nameRef, nameOver] = useOverflowFade<HTMLSpanElement>();
  const cellRef = useRef<HTMLTableCellElement>(null);
  const action = useActionMode(nameRef, cellRef);

  const tile = item.IsDir ? (
    <span className="relative flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[11px] bg-[var(--accw)]">
      <Folder size={18} className="text-[var(--acc)]" />
      <FolderBadge hasDownloads={hasDownloads} visited={visited} />
    </span>
  ) : (
    <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[11px] font-mono text-[9.5px] font-semibold" style={{ background: "var(--accw)", color: ft.color }}>
      {ext || "FILE"}
    </span>
  );
  const body = (
    <>
      {tile}
      <span className="min-w-0 flex-1">
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <span ref={nameRef} className={`${NAME_CLIP} text-[13.5px] font-medium text-[var(--ink)] ${nameOver ? FADE_MASK : ""}`}>{item.Name}</span>
          {isStarred && <Star size={11} fill="currentColor" className="shrink-0 text-[var(--warn)]" />}
          {video && <Play size={11} className="shrink-0 text-[var(--faint)] opacity-0 group-hover:opacity-100" />}
        </span>
        {/* Status/download badge sits on the sub-line (with the size/count) so it
            never collides with the fixed hover actions in the Name column. */}
        {(dl || status || sub) && (
          <span className="mt-0.5 flex items-center gap-1.5">
            {dl ? <DownloadBadge status={dl} /> : status ? <StatusBadge status={status} /> : null}
            {sub && <span className="min-w-0 truncate text-[11.5px] text-[var(--faint)]">{sub}</span>}
          </span>
        )}
      </span>
    </>
  );
  const nameCell = <span className="flex min-w-0 items-center gap-3 text-left">{body}</span>;
  // Clicking anywhere on the row (not an interactive child) acts like clicking
  // the name: open a folder, focus a file (double-click previews it).
  const primaryClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button,input,a,[data-rowbtn]")) return;
    if (e.shiftKey) { actions.toggle(item.Path, true); return; }
    if (item.IsDir) actions.openDir(item); else actions.focus(item);
  };
  const primaryDouble = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button,input,a,[data-rowbtn]")) return;
    if (!item.IsDir && previewableFlag) actions.openPreview(item);
  };
  return (
    <tr
      data-row
      data-path={item.Path}
      data-folder-path={item.IsDir ? item.Path : undefined}
      draggable
      onClick={primaryClick}
      onDoubleClick={primaryDouble}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "copyMove"; setDragGhost(e, item.Name); actions.dragStart(item); }}
      onDragEnd={() => actions.dragEnd()}
      onDragOver={item.IsDir ? (e) => { if (actions.dragOverFolder(item)) { e.preventDefault(); e.dataTransfer.dropEffect = e.altKey ? "copy" : "move"; } } : undefined}
      onDrop={item.IsDir ? (e) => { e.preventDefault(); actions.drop(item, e.altKey); } : undefined}
      onContextMenu={(e) => { e.preventDefault(); actions.contextMenu(e.clientX, e.clientY, item); }}
      className={`group cursor-pointer select-none border-b border-[var(--border)]/60 transition-colors duration-100 active:bg-[var(--accw)] ${isDropTarget ? "bg-[var(--accw)] outline-dashed outline-1 -outline-offset-1 outline-[var(--acc)]" : isSelected ? "bg-[var(--accw)]" : blink ? "animate-flash" : "hover:bg-[var(--hover)]"}`}
    >
      <td className="w-9 py-2.5 pl-1">
        <input
          type="checkbox"
          aria-label={`Select ${item.Name}`}
          checked={isSelected}
          onChange={() => {}}
          onClick={(e) => { actions.toggle(item.Path, e.shiftKey); actions.focus(item); }}
        />
      </td>
      <td ref={cellRef} className="relative min-w-0 py-1.5 pr-3">
        <div className="flex min-w-0 items-center gap-3">
          {nameCell}
        </div>
        {/* Hover actions — 3 states from useActionMode (fixed / inline-shift /
            flyout). All share the same measured horizontal `left`; flyout lifts
            above the row with a merged tab background. */}
        {action.mode === "flyout" ? (
          <div
            className="absolute bottom-full z-20 hidden items-center gap-0.5 whitespace-nowrap rounded-t-[9px] px-1.5 pb-1.5 pt-1 group-hover:flex"
            style={{ left: action.left, background: isSelected || isDropTarget ? "var(--accw)" : "var(--hover)" }}
          >
            <ActionButtons />
          </div>
        ) : (
          <div
            className="absolute top-1/2 z-10 hidden -translate-y-1/2 items-center gap-0.5 group-hover:flex"
            style={{ left: action.left }}
          >
            <ActionButtons />
          </div>
        )}
      </td>
      <td className="hidden whitespace-nowrap py-2 text-[var(--text-3)] lg:table-cell">{dateStr}</td>
      <td className="tnum whitespace-nowrap py-2 text-right text-[var(--text-2)]">
        <SizeCell item={item} folderSize={folderSize} onCalcSize={actions.calcSize} />
      </td>
      <td className="hidden py-2.5 pl-6 text-[var(--text-3)] lg:table-cell">{ft.label}</td>
    </tr>
  );

  function ActionButtons() {
    return (
      <>
            {previewableFlag && (
              <RowAction onClick={() => actions.openPreview(item)} tip="Preview" label={`Preview ${item.Name}`}>
                <Eye size={14} />
              </RowAction>
            )}
            {video && (
              <RowAction onClick={() => actions.openReview(item)} tip="Review" label={`Review ${item.Name}`}>
                <Play size={14} />
              </RowAction>
            )}
            <RowAction onClick={() => actions.download(item)} tip="Download" label={`Download ${item.Name}`} green>
              <Download size={14} />
            </RowAction>
            <RowAction onClick={(e) => actions.share(item, { x: e.clientX, y: e.clientY })} tip="Copy link" label={`Copy link to ${item.Name}`}>
              <Link2 size={14} />
            </RowAction>
            {item.IsDir && (
              <RowAction
                onClick={() => actions.indexFolder(item.Path)}
                disabled={showCrawl}
                tip={folderIndexedFlag ? "Re-index folder" : "Index folder"}
                label={`Index ${item.Name}`}
              >
                <FolderSearch size={14} />
              </RowAction>
            )}
            <RowAction
              onClick={() => actions.toggleStar(item.Path)}
              tip={isStarred ? "Unstar" : "Star"}
              label="Star"
              active={isStarred}
            >
              <Star size={14} fill={isStarred ? "currentColor" : "none"} />
            </RowAction>
            <RowAction onClick={() => actions.deleteOne(item)} tip="Move to Trash" label={`Delete ${item.Name}`} danger>
              <Trash2 size={14} />
            </RowAction>
      </>
    );
  }
},
(prev, next) =>
  prev.item === next.item &&
  prev.isSelected === next.isSelected &&
  prev.isDropTarget === next.isDropTarget &&
  prev.blink === next.blink &&
  prev.isStarred === next.isStarred &&
  prev.dateStr === next.dateStr &&
  prev.folderCount === next.folderCount &&
  prev.showCrawl === next.showCrawl &&
  prev.folderIndexedFlag === next.folderIndexedFlag &&
  prev.visited === next.visited &&
  prev.hasDownloads === next.hasDownloads &&
  prev.status === next.status &&
  prev.dl?.state === next.dl?.state &&
  prev.dl?.pct === next.dl?.pct &&
  folderSizeEqual(prev.folderSize, next.folderSize));

/** One grid-view card — same memoization rationale as FileRow. */
const FileGridItem = memo(function FileGridItem({
  item,
  isSelected,
  isDropTarget,
  blink,
  folderSize,
  folderCount,
  visited,
  hasDownloads,
  status,
  dl,
  gridIndex,
  actions,
}: {
  item: RcItem;
  isSelected: boolean;
  isDropTarget: boolean;
  blink: boolean;
  folderSize: FolderSizeState;
  folderCount: number | undefined;
  visited: boolean;
  hasDownloads: boolean;
  status: FolderStatus | undefined;
  dl: DlStatus | undefined;
  gridIndex: number;
  actions: RowActions;
}) {
  const ft = fileType(item.Name, item.IsDir);
  // Size + count line (gray, under the name). macOS-style: shown only when known.
  const sizeStr = !item.IsDir
    ? (item.Size > 0 ? formatBytes(item.Size) : "")
    : (folderSize.kind === "known" && folderSize.bytes > 0 ? formatBytes(folderSize.bytes) : "");
  const countStr = item.IsDir && folderCount != null ? `${folderCount.toLocaleString()} file${folderCount === 1 ? "" : "s"}` : "";
  const meta = [sizeStr, countStr].filter(Boolean).join(" · ");
  return (
    <div
      data-item
      data-path={item.Path}
      data-folder-path={item.IsDir ? item.Path : undefined}
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "copyMove"; setDragGhost(e, item.Name); actions.dragStart(item); }}
      onDragEnd={() => actions.dragEnd()}
      onDragOver={item.IsDir ? (e) => { if (actions.dragOverFolder(item)) { e.preventDefault(); e.dataTransfer.dropEffect = e.altKey ? "copy" : "move"; } } : undefined}
      onDrop={item.IsDir ? (e) => { e.preventDefault(); actions.drop(item, e.altKey); } : undefined}
      onContextMenu={(e) => { e.preventDefault(); actions.contextMenu(e.clientX, e.clientY, item); }}
      style={{ animationDelay: `${Math.min(gridIndex, 16) * 22}ms` }}
      className={`animate-item group relative flex select-none flex-col items-center rounded-[12px] px-1 pb-2.5 pt-3 transition-colors duration-100 ${isDropTarget ? "bg-[var(--accw)] outline-dashed outline-1 -outline-offset-1 outline-[var(--acc)]" : blink ? "animate-flash" : ""}`}
    >
      <input
        type="checkbox"
        aria-label={`Select ${item.Name}`}
        checked={isSelected}
        onChange={() => {}}
        onClick={(e) => { actions.toggle(item.Path, e.shiftKey); actions.focus(item); }}
        className={`absolute left-2 top-2 z-10 transition-opacity ${isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
      />
      <button
        className="flex w-full flex-col items-center gap-1.5"
        onClick={(e) => (e.shiftKey ? actions.toggle(item.Path, true) : item.IsDir ? actions.openDir(item) : actions.focus(item))}
        onDoubleClick={() => !item.IsDir && isPreviewable(item.Name) && actions.openPreview(item)}
      >
        {/* Icon "container" — big glyph on a rounded tile that lights up on
            hover/selection (the macOS Finder look). The name sits BELOW it. */}
        <span className={`relative flex h-[64px] w-[64px] items-center justify-center rounded-[16px] transition-colors ${isSelected ? "bg-[var(--accw)]" : "group-hover:bg-[var(--soft)]"}`}>
          <ft.Icon size={38} style={{ color: ft.color }} />
          {item.IsDir && <FolderBadge hasDownloads={hasDownloads} visited={visited} />}
        </span>
        {/* Name under the icon; selected name gets a macOS-style pill. */}
        <span className={`mt-0.5 line-clamp-2 max-w-full rounded-[6px] px-1.5 text-center text-[12.5px] leading-tight ${isSelected ? "bg-[var(--acc)] text-[var(--onacc)]" : "text-[var(--text)]"}`}>{item.Name}</span>
        {meta && <span className="tnum text-[11px] text-[var(--text-3)]">{meta}</span>}
        {dl ? <DownloadBadge status={dl} /> : status ? <StatusBadge status={status} /> : null}
      </button>
    </div>
  );
},
(prev, next) =>
  prev.item === next.item &&
  prev.isSelected === next.isSelected &&
  prev.isDropTarget === next.isDropTarget &&
  prev.blink === next.blink &&
  prev.folderCount === next.folderCount &&
  prev.visited === next.visited &&
  prev.hasDownloads === next.hasDownloads &&
  prev.status === next.status &&
  prev.dl?.state === next.dl?.state &&
  prev.dl?.pct === next.dl?.pct &&
  prev.gridIndex === next.gridIndex &&
  folderSizeEqual(prev.folderSize, next.folderSize));

/** Shimmer placeholder rows shown while a folder/index loads, shaped like the
 *  file table so the transition to real rows reads as instant. */
/** One TYPE/SIZE/… row in the preview panel. */
function PvRow({ k, v, mono, wrap }: { k: string; v: string; mono?: boolean; wrap?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 text-[11.5px] ${wrap ? "" : "items-center"}`}>
      <span className="shrink-0 font-mono text-[10px] tracking-[0.06em] text-[var(--faint)]">{k}</span>
      <span className={`${mono ? "font-mono text-[10.5px]" : ""} text-[var(--mut)] ${wrap ? "break-all text-right" : "truncate"}`}>{v}</span>
    </div>
  );
}

/** Right preview panel — a focused file's details + actions, or a folder card. */
function PreviewPanel({
  item, rootLabel, currentFolderName, size, dateStr, parentName, isStarred, dl, folderSize, folderStats, onIndexFolder, indexing, actions,
}: {
  item: RcItem | null;
  rootLabel: string;
  currentFolderName: string;
  size: number;
  dateStr: string;
  parentName: string;
  isStarred: boolean;
  dl: DlStatus | undefined;
  folderSize: FolderSizeState | undefined;
  folderStats: { files: number; folders: number; indexed: boolean };
  onIndexFolder: () => void;
  indexing: boolean;
  actions: RowActions;
}) {
  if (item && !item.IsDir) {
    const ft = fileType(item.Name, false);
    const previewable = isPreviewable(item.Name);
    const kind = isVideo(item.Name) ? "VIDEO PREVIEW" : previewable ? "PREVIEW" : (extOf(item.Name).replace(/^\./, "").toUpperCase() || "FILE");
    const downloading = dl?.state === "downloading";
    return (
      <div className="flex w-[296px] shrink-0 flex-col overflow-y-auto border-l border-[var(--line)]">
        <div className="px-4 pt-4">
          <div
            className="relative flex aspect-video flex-col items-center justify-center gap-2 overflow-hidden rounded-[11px] border border-[var(--line)]"
            style={{ background: "repeating-linear-gradient(45deg,var(--soft) 0 10px,var(--card) 10px 20px)" }}
          >
            {previewable ? (
              <button onClick={() => actions.openPreview(item)} className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--acc)] hover:opacity-90" aria-label="Preview">
                <Play size={15} className="text-[var(--onacc)]" fill="currentColor" />
              </button>
            ) : (
              <ft.Icon size={26} style={{ color: ft.color }} />
            )}
            <span className="font-mono text-[9.5px] tracking-[0.1em] text-[var(--faint)]">{kind}</span>
          </div>
          <div className="mt-3 break-all text-[13.5px] font-semibold text-[var(--ink)]">{item.Name}</div>
          <div className="mt-0.5 font-mono text-[10px] text-[var(--faint)]">{rootLabel.toUpperCase()} · {parentName.toUpperCase()}</div>
        </div>
        <div className="flex flex-col gap-2 px-4 py-3">
          <PvRow k="TYPE" v={ft.label} />
          <PvRow k="SIZE" v={size > 0 ? formatBytes(size) : "—"} mono />
          <PvRow k="MODIFIED" v={dateStr || "—"} mono />
          <PvRow k="PATH" v={"/" + item.Path} mono wrap />
        </div>
        <div className="mt-auto flex flex-col gap-2 px-4 pb-4">
          {downloading && dl && (
            <div className="flex items-center gap-2">
              <span className="block h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--soft)]"><span className="block h-full rounded-full bg-[var(--acc)]" style={{ width: `${dl.pct ?? 0}%` }} /></span>
              <span className="font-mono text-[10.5px] font-semibold text-[var(--acc)]">{dl.pct ?? 0}%</span>
            </div>
          )}
          <button onClick={() => actions.download(item)} className="flex items-center justify-center gap-2 rounded-[11px] bg-[var(--acc)] py-2.5 text-[12.5px] font-semibold text-[var(--onacc)] hover:opacity-90">
            <Download size={14} /> Download
          </button>
          <div className="flex gap-2">
            {previewable && (
              <button onClick={() => actions.openReview(item)} className="flex flex-1 items-center justify-center gap-1.5 rounded-[11px] border border-[var(--line2)] py-2 text-[12px] font-semibold text-[var(--mut)] hover:text-[var(--ink)]">
                <Eye size={13} /> Review
              </button>
            )}
            <button onClick={() => actions.toggleStar(item.Path)} className="flex flex-1 items-center justify-center gap-1.5 rounded-[11px] border border-[var(--line2)] py-2 text-[12px] font-semibold text-[var(--mut)] hover:text-[var(--ink)]">
              <Star size={13} fill={isStarred ? "currentColor" : "none"} className={isStarred ? "text-[var(--warn)]" : ""} /> Star
            </button>
          </div>
          <button onClick={(e) => actions.share(item, { x: e.clientX, y: e.clientY })} className="flex items-center justify-center gap-1.5 rounded-[11px] border border-[var(--line2)] py-2 text-[12px] font-semibold text-[var(--mut)] hover:text-[var(--ink)]">
            <Link2 size={13} /> Copy link
          </button>
        </div>
      </div>
    );
  }
  // Folder focused, or nothing focused → show the current/selected folder with
  // its RECURSIVE totals (all files + all subfolders anywhere beneath it).
  const name = item ? item.Name : currentFolderName;
  const sizeStr = folderSize?.kind === "known" && folderSize.bytes > 0 ? formatBytes(folderSize.bytes) : folderSize?.kind === "loading" ? "…" : "—";
  const fmt = (n: number) => n.toLocaleString();
  return (
    <div className="flex w-[296px] shrink-0 flex-col overflow-y-auto border-l border-[var(--line)]">
      <div className="flex flex-col items-center gap-2.5 px-6 pt-6 text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-[16px] bg-[var(--accw)]"><Folder size={28} className="text-[var(--acc)]" /></span>
        <div className="break-all text-[14px] font-semibold text-[var(--ink)]">{name}</div>
        <div className="font-mono text-[10px] text-[var(--faint)]">{rootLabel.toUpperCase()}</div>
      </div>

      <div className="flex flex-col gap-2 px-5 py-4">
        <PvRow k="TYPE" v="Folder" />
        <PvRow k="SIZE" v={sizeStr} mono />
        {/* Recursive totals — every file/subfolder anywhere beneath this folder,
            not just its direct children. Available once the subtree is indexed. */}
        {folderStats.indexed ? (
          <>
            <PvRow k="FILES" v={fmt(folderStats.files)} mono />
            <PvRow k="FOLDERS" v={fmt(folderStats.folders)} mono />
          </>
        ) : (
          <div className="flex items-center justify-between gap-3 text-[11.5px]">
            <span className="font-mono text-[10px] tracking-[0.06em] text-[var(--faint)]">CONTENTS</span>
            <button onClick={onIndexFolder} disabled={indexing} className="flex items-center gap-1.5 rounded-[7px] border border-[var(--line2)] px-2 py-0.5 text-[11px] font-semibold text-[var(--mut)] hover:text-[var(--ink)] disabled:opacity-50">
              {indexing ? <Loader2 size={11} className="animate-spin" /> : <FolderSearch size={11} />} Count all
            </button>
          </div>
        )}
      </div>

      <div className="mt-auto flex flex-col gap-2 px-5 pb-5">
        {item ? (
          <button onClick={() => actions.download(item)} className="flex items-center justify-center gap-2 rounded-[11px] bg-[var(--acc)] py-2.5 text-[12.5px] font-semibold text-[var(--onacc)] hover:opacity-90">
            <Download size={13} /> Download folder
          </button>
        ) : (
          <div className="py-4 text-center text-[11px] text-[var(--faint)]">Select a file to preview it here</div>
        )}
      </div>
    </div>
  );
}

/** Finder-style Miller-columns view: one column per path level, the active
 *  child highlighted; click a folder to descend, a file to preview it. Each
 *  ancestor level is listed on demand from the browse cache. */
function ColumnsView({
  account, rootLabel, path, focusedPath, selectedPaths, folderSizeState, dropTarget, actions,
  visitedSet, folderHasDownloads, folderStatusMap, dlStatusMap, arrange, onMarquee,
}: {
  account: Account;
  rootLabel: string;
  path: string;
  focusedPath: string | null;
  selectedPaths: Set<string>;
  folderSizeState: (p: string) => FolderSizeState;
  dropTarget: string | null;
  actions: RowActions;
  visitedSet: Set<string>;
  folderHasDownloads: (p: string) => boolean;
  folderStatusMap: Record<string, FolderStatus> | undefined;
  dlStatusMap: Map<string, DlStatus>;
  arrange: (items: RcItem[]) => { key: string; label: string; items: RcItem[] }[];
  onMarquee: (e: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const listings = useBrowse((s) => s.listings);
  const segs = path ? path.split("/") : [];
  const prefixes: string[] = [];
  for (let i = 0; i <= segs.length; i++) prefixes.push(segs.slice(0, i).join("/"));
  const scrollerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    for (const p of prefixes) void useBrowse.getState().ensure(account, p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, path]);
  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [path]);

  return (
    <div ref={scrollerRef} onMouseDown={onMarquee} data-testid="file-list" className="flex min-h-0 flex-1 overflow-x-auto">
      {prefixes.map((prefix, i) => {
        const raw = listings[browseKey(account.id, prefix)];
        const groups = raw ? arrange(raw) : undefined;
        const list = groups ? groups.flatMap((g) => g.items) : undefined;
        const activeName = segs[i]; // the child descended into (undefined in the last column)
        const header = i === 0 ? rootLabel : (segs[i - 1] ?? "");
        return (
          <div key={prefix || "root"} className="w-[250px] shrink-0 overflow-y-auto border-r border-[var(--line)] p-2">
            <div className="flex justify-between px-2 pb-2 pt-1">
              <span className="truncate font-mono text-[9.5px] font-semibold tracking-[0.1em] text-[var(--faint)]">{(header || "DRIVE").toUpperCase()}</span>
              <span className="shrink-0 font-mono text-[9.5px] text-[var(--faint)]">{list?.length ?? ""}</span>
            </div>
            {list === undefined ? (
              // Skeleton confined to THIS column — already-loaded columns stay visible.
              <div data-testid="column-skeleton">
                {Array.from({ length: 7 }).map((_, si) => (
                  <div key={si} className="flex items-center gap-2 px-2 py-[7px]">
                    <Skeleton className="h-3.5 w-3.5 shrink-0 rounded" />
                    <Skeleton className="h-3" style={{ width: `${45 + ((si * 19) % 40)}%` }} />
                  </div>
                ))}
              </div>
            ) : list.length === 0 ? (
              <div className="px-2 py-2 text-[11px] text-[var(--faint)]">Empty</div>
            ) : (
              groups!.map((g) => (
                <Fragment key={g.key}>
                  {g.label && (
                    <div className="flex items-center gap-2 px-2 pb-1 pt-2.5">
                      <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.1em] text-[var(--faint)]">{g.label}</span>
                      <span className="font-mono text-[9px] text-[var(--faint)]">· {g.items.length}</span>
                    </div>
                  )}
                  {g.items.map((it) => {
                const active = it.IsDir && it.Name === activeName;
                const focused = it.Path === focusedPath;
                const checked = selectedPaths.has(it.Path);
                const ft = fileType(it.Name, it.IsDir);
                const fs = it.IsDir ? folderSizeState(it.Path) : undefined;
                const meta = it.IsDir
                  ? (fs?.kind === "known" && fs.bytes > 0 ? formatBytes(fs.bytes) : "")
                  : (it.Size > 0 ? formatBytes(it.Size) : "");
                const hi = active || focused || checked;
                const hasDl = it.IsDir && folderHasDownloads(it.Path);
                const visited = it.IsDir && visitedSet.has(it.Path);
                const dl = dlStatusMap.get(it.Path);
                const st = folderStatusMap?.[it.Path] ?? (hasDl ? ("downloaded" as const) : undefined);
                return (
                  <div
                    key={it.ID ?? it.Path}
                    data-item
                    data-path={it.Path}
                    data-folder-path={it.IsDir ? it.Path : undefined}
                    draggable
                    onDragStart={(e) => { e.dataTransfer.effectAllowed = "copyMove"; setDragGhost(e, it.Name); actions.dragStart(it); }}
                    onDragEnd={() => actions.dragEnd()}
                    onDragOver={it.IsDir ? (e) => { if (actions.dragOverFolder(it)) { e.preventDefault(); e.dataTransfer.dropEffect = e.altKey ? "copy" : "move"; } } : undefined}
                    onDrop={it.IsDir ? (e) => { e.preventDefault(); actions.drop(it, e.altKey); } : undefined}
                    onClick={(e) => (e.shiftKey ? actions.toggle(it.Path, true, list) : it.IsDir ? actions.openDir(it) : actions.focus(it))}
                    onDoubleClick={() => !it.IsDir && isPreviewable(it.Name) && actions.openPreview(it)}
                    onContextMenu={(e) => { e.preventDefault(); actions.contextMenu(e.clientX, e.clientY, it); }}
                    className={`group flex cursor-pointer select-none items-center gap-2 rounded-[8px] px-2 py-1.5 ${it.Path === dropTarget ? "bg-[var(--accw)] outline-dashed outline-1 outline-[var(--acc)]" : hi ? "bg-[var(--accw)]" : "hover:bg-[var(--soft)]"}`}
                  >
                    {/* Selection tick — folders too. Shift ranges within this column. */}
                    <button
                      onClick={(e) => { e.stopPropagation(); actions.toggle(it.Path, e.shiftKey, list); actions.focus(it); }}
                      aria-label={`Select ${it.Name}`}
                      className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border ${checked ? "border-[var(--acc)] bg-[var(--acc)]" : "border-[var(--line2)] opacity-0 group-hover:opacity-100"}`}
                    >
                      {checked && <Check size={8} strokeWidth={4} className="text-[var(--onacc)]" />}
                    </button>
                    <span className="relative shrink-0">
                      {it.IsDir ? <Folder size={14} className={hi ? "text-[var(--acc)]" : "text-[var(--mut)]"} /> : <ft.Icon size={14} style={{ color: ft.color }} />}
                      {/* Mini open/downloaded dot — column-sized version of FolderBadge. */}
                      {(hasDl || visited) && (
                        <span
                          data-tip={hasDl ? "Has downloads" : "Opened"}
                          className={`absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full ring-2 ring-[var(--surface)] ${hasDl ? "bg-[var(--dl)]" : "bg-[var(--text-3)]"}`}
                        />
                      )}
                    </span>
                    <span className={`min-w-0 flex-1 text-[12.5px] ${FADE_NAME} ${hi ? "font-semibold text-[var(--acc)]" : "text-[var(--ink)]"}`}>{it.Name}</span>
                    {dl ? <DownloadBadge status={dl} /> : st ? <StatusBadge status={st} /> : meta ? <span className="shrink-0 font-mono text-[10px] text-[var(--faint)]">{meta}</span> : null}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const r = e.currentTarget.getBoundingClientRect();
                        actions.contextMenu(r.left, r.bottom + 2, it);
                      }}
                      aria-label={`Actions for ${it.Name}`}
                      className="hidden shrink-0 rounded-[5px] p-0.5 text-[var(--faint)] hover:bg-[var(--line)] hover:text-[var(--ink)] group-hover:block"
                    >
                      <MoreHorizontal size={13} />
                    </button>
                    {it.IsDir && <ChevronRight size={12} className={`shrink-0 ${active ? "text-[var(--acc)]" : "text-[var(--faint)]"}`} />}
                  </div>
                );
                  })}
                </Fragment>
              ))
            )}
          </div>
        );
      })}
      <div className="min-w-[24px] flex-1" />
    </div>
  );
}

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
function BrowseEmptyState({ q, section }: { q: string; section: Section }) {
  const Icon = q ? FileSearch : section === "starred" ? Star : FolderOpen;
  const title = q ? "No matches" : section === "starred" ? "No starred items yet" : "This folder is empty";
  const body = q
    ? `Nothing here matches “${q}”. Try a different search.`
    : section === "starred"
      ? "Star files and folders to pin them here for quick access."
      : "Nothing to show in this folder.";
  return <EmptyState icon={<Icon size={20} />} title={title} body={body} />;
}
