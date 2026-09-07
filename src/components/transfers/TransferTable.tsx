import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pause, Play, X, Square, Zap, Trash2, RotateCcw, Copy, FolderOpen, FolderSymlink, AlertCircle } from "lucide-react";
import { formatBytes, formatSpeed, formatEta } from "../../lib/format";
import { laneOf } from "../../lib/lane";
import { fileType } from "../../lib/file-types";
import { SpeedGraph } from "../ui/SpeedGraph";
import { ContextMenu, type MenuItem } from "../ui/ContextMenu";
import type { TransferRow, TransferState } from "./row";

/** Per-job stats the info panel can show when available (downloads only). */
export interface RowStats {
  startedAt?: number;
  peakSpeed?: number;
  minSpeed?: number;
}

interface TransferTableProps {
  rows: TransferRow[];
  /** Live speed samples per jobId, for the info-panel graph. */
  speedHistory?: Record<number, number[]>;
  statsFor?: (jobId: number) => RowStats | undefined;
  onPause?: (jobId: number) => void;
  onCancel?: (jobId: number) => void;
  onResumeQueued?: (queueId: string) => void;
  onRemoveQueued?: (queueId: string) => void;
  onForceStart?: (queueId: string) => void;
  onResumeFailed?: (row: TransferRow) => void;
  /** Navigate the app to the source folder (Drive/Dropbox downloads). */
  onGoToSource?: (row: TransferRow) => void;
  /** Open the local destination folder in the OS file manager. */
  onOpenDest?: (row: TransferRow) => void;
  /** Remove the transfer; `withFiles` also deletes its files from disk. */
  onDelete?: (row: TransferRow, withFiles: boolean) => void;
}

type RowActions = Omit<TransferTableProps, "rows" | "speedHistory" | "statsFor">;

/** Right-click menu items for a row, based on its state. `onRequestDelete` opens
 *  the confirm dialog (list-only vs list + files). */
function buildMenu(row: TransferRow, a: RowActions, onRequestDelete: (r: TransferRow) => void): MenuItem[] {
  const items: MenuItem[] = [];
  const active = row.state === "downloading" || row.state === "uploading";
  const done = row.state === "completed" || row.state === "failed" || row.state === "cancelled";
  const copy = (t: string) => { if (t) void navigator.clipboard?.writeText(t).catch(() => {}); };

  if (active && row.jobId != null) {
    if (a.onPause && !row.upload) items.push({ label: "Pause", icon: Pause, onClick: () => a.onPause!(row.jobId!) });
    if (a.onCancel) items.push({ label: "Stop", icon: Square, danger: true, onClick: () => a.onCancel!(row.jobId!) });
  }
  if (row.queueId) {
    if (a.onForceStart) items.push({ label: "Force download now", icon: Zap, onClick: () => a.onForceStart!(row.queueId!) });
    if (row.state === "paused" && a.onResumeQueued) items.push({ label: "Resume", icon: Play, onClick: () => a.onResumeQueued!(row.queueId!) });
    if (row.state === "blocked" && !row.autoRetry && a.onResumeQueued) items.push({ label: "Retry", icon: RotateCcw, onClick: () => a.onResumeQueued!(row.queueId!) });
  }
  if (done && row.item && a.onResumeFailed) {
    items.push({ label: row.state === "failed" ? "Retry" : "Download again", icon: RotateCcw, onClick: () => a.onResumeFailed!(row) });
  }
  // Navigate to source (in-app, Drive/Dropbox only) and open the local
  // destination in the OS file manager.
  const primary = !row.upload && laneOf(row.accountId) === "primary";
  if (a.onGoToSource && primary) items.push({ label: "Go to source folder", icon: FolderSymlink, separator: items.length > 0, onClick: () => a.onGoToSource!(row) });
  if (a.onOpenDest && !row.upload && row.dest) items.push({ label: "Open destination folder", icon: FolderOpen, separator: items.length > 0 && !primary, onClick: () => a.onOpenDest!(row) });
  items.push({ label: "Copy source", icon: Copy, separator: true, onClick: () => copy(row.source) });
  items.push({ label: "Copy destination", icon: Copy, onClick: () => copy(row.dest) });
  if (a.onDelete) items.push({ label: "Delete…", icon: Trash2, danger: true, separator: true, onClick: () => onRequestDelete(row) });
  return items;
}

const isRetryable = (r: TransferRow) =>
  (r.state === "blocked" && !r.autoRetry && !!r.queueId) || (r.state === "failed" && !!r.item);
const isPausable = (r: TransferRow) =>
  (r.state === "downloading" || r.state === "uploading") && r.jobId != null && !r.upload;
const isResumable = (r: TransferRow) => r.state === "paused" && !!r.queueId;

/** Apply a retry/resume to a single row (blocked queue → resume, failed → re-enqueue). */
function retryRow(r: TransferRow, a: RowActions) {
  if (r.state === "failed" && r.item) a.onResumeFailed?.(r);
  else if (r.queueId) a.onResumeQueued?.(r.queueId);
}

/** Right-click menu when multiple rows are selected — batch actions across all. */
function buildBatchMenu(sel: TransferRow[], a: RowActions, onRequestBulkDelete: () => void): MenuItem[] {
  const items: MenuItem[] = [];
  const retry = sel.filter(isRetryable);
  const pause = sel.filter(isPausable);
  const resume = sel.filter(isResumable);
  if (retry.length) items.push({ label: `Retry ${retry.length}`, icon: RotateCcw, onClick: () => retry.forEach((r) => retryRow(r, a)) });
  if (resume.length) items.push({ label: `Resume ${resume.length}`, icon: Play, onClick: () => resume.forEach((r) => a.onResumeQueued?.(r.queueId!)) });
  if (pause.length) items.push({ label: `Pause ${pause.length}`, icon: Pause, onClick: () => pause.forEach((r) => a.onPause?.(r.jobId!)) });
  if (a.onDelete) items.push({ label: `Delete ${sel.length}…`, icon: Trash2, danger: true, separator: items.length > 0, onClick: onRequestBulkDelete });
  return items;
}

// Shared grid so the header and every row line up. Columns:
// #  Name  Size  Status  Speed  ETA  Source  Actions
const COLS = "28px minmax(0,1fr) 84px 188px 92px 78px minmax(120px,168px) 66px";

const STATE_COLOR: Record<TransferState, string> = {
  downloading: "var(--dl)",
  uploading: "var(--dl)",
  queued: "var(--faint)",
  paused: "var(--faint)",
  gated: "var(--faint)",
  blocked: "var(--warn)",
  completed: "var(--ok)",
  failed: "var(--err)",
  cancelled: "var(--faint)",
};

const BLOCK_LABEL: Record<string, string> = {
  disk: "Needs space",
  network: "Network issue",
  auth: "Access issue",
  rate: "Rate-limited",
  unknown: "Needs attention",
};

function stateLabel(r: TransferRow): string {
  switch (r.state) {
    case "downloading": return `Downloading ${r.pct}%`;
    case "uploading": return `Uploading ${r.pct}%`;
    case "queued": return "Queued";
    case "paused": return `Paused ${r.pct}%`;
    case "gated": return "Waiting…";
    case "blocked": return r.autoRetry ? "Retrying…" : BLOCK_LABEL[r.blockedKind ?? "unknown"];
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
  }
}

/** uTorrent-style status cell: translucent progress fill with centred label. */
function StatusCell({ row }: { row: TransferRow }) {
  const color = STATE_COLOR[row.state];
  const fill = row.state === "completed" ? 100 : row.pct;
  return (
    <div className="relative h-[16px] w-full overflow-hidden rounded-[5px] bg-[var(--soft)]">
      <div
        className="absolute inset-y-0 left-0 transition-[width] duration-300"
        style={{ width: `${fill}%`, background: color, opacity: 0.26 }}
      />
      <div className="absolute inset-0 flex items-center justify-center whitespace-nowrap text-[10.5px] font-semibold" style={{ color }}>
        {stateLabel(row)}
      </div>
    </div>
  );
}

function IconBtn({ title, onClick, danger, children }: { title: string; onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      aria-label={title}
      data-tip={title}
      className={`flex h-[24px] w-[24px] items-center justify-center rounded-[7px] text-[var(--faint)] hover:bg-[var(--soft)] ${danger ? "hover:text-[var(--err)]" : "hover:text-[var(--ink)]"}`}
    >
      {children}
    </button>
  );
}

const Row = memo(function Row({
  row, index, selected, onSelect, onContext, onRequestDelete, actions,
}: {
  row: TransferRow;
  index: number;
  selected: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onContext: (e: React.MouseEvent) => void;
  onRequestDelete: (row: TransferRow) => void;
  actions: RowActions;
}) {
  const ft = fileType(row.name, false);
  const active = row.state === "downloading" || row.state === "uploading";
  return (
    <div
      role="row"
      onClick={onSelect}
      onContextMenu={onContext}
      className={`group grid cursor-pointer select-none items-center gap-2 border-b border-[var(--line)] px-4 py-[7px] text-[12px] transition-colors ${selected ? "bg-[var(--accw)]" : "hover:bg-[var(--soft)]"}`}
      style={{ gridTemplateColumns: COLS }}
    >
      <span className="tnum text-right text-[11px] text-[var(--faint)]">{index + 1}</span>

      <span className="flex min-w-0 items-center gap-2">
        <ft.Icon size={15} style={{ color: ft.color }} className="shrink-0" />
        <span className="truncate font-medium text-[var(--ink)]" data-tip={row.name}>{row.name}</span>
      </span>

      <span className="tnum text-right text-[var(--mut)]">{formatBytes(row.size)}</span>

      <StatusCell row={row} />

      <span className="tnum text-right" style={{ color: active && row.speed > 0 ? "var(--dl)" : "var(--faint)" }}>
        {active ? formatSpeed(row.speed) : "·"}
      </span>

      <span className="tnum text-right text-[var(--faint)]">{active ? formatEta(row.eta) : "·"}</span>

      <span className="truncate text-right text-[11px] text-[var(--faint)]" data-tip={row.error || row.source}>
        {row.state === "failed" && row.error ? <span className="text-[var(--err)]">{row.error}</span>
          : row.state === "blocked" && row.error ? <span className="text-[var(--warn)]">{row.error}</span>
          : row.source}
      </span>

      <span className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {row.jobId != null && active && actions.onPause && (
          <IconBtn title="Pause" onClick={() => actions.onPause!(row.jobId!)}><Pause size={13} /></IconBtn>
        )}
        {row.jobId != null && active && actions.onCancel && (
          <IconBtn title="Cancel" danger onClick={() => actions.onCancel!(row.jobId!)}><X size={13} /></IconBtn>
        )}
        {row.queueId && row.state === "paused" && actions.onResumeQueued && (
          <IconBtn title="Resume" onClick={() => actions.onResumeQueued!(row.queueId!)}><Play size={13} /></IconBtn>
        )}
        {row.queueId && row.state === "blocked" && !row.autoRetry && actions.onResumeQueued && (
          <IconBtn title="Retry" onClick={() => actions.onResumeQueued!(row.queueId!)}><RotateCcw size={13} /></IconBtn>
        )}
        {row.queueId && actions.onRemoveQueued && (
          <IconBtn title="Remove" danger onClick={() => actions.onRemoveQueued!(row.queueId!)}><X size={13} /></IconBtn>
        )}
        {row.state === "failed" && row.item && actions.onResumeFailed && (
          <IconBtn title="Resume" onClick={() => actions.onResumeFailed!(row)}><Play size={13} /></IconBtn>
        )}
        {!row.queueId && !active && row.jobId != null && actions.onDelete && (
          <IconBtn title="Delete" danger onClick={() => onRequestDelete(row)}><X size={13} /></IconBtn>
        )}
      </span>
    </div>
  );
});

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

function Stat({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div className="min-w-0">
      <div className="mb-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] text-[var(--faint)]">{label}</div>
      <div className="tnum select-text truncate text-[12.5px] font-medium" style={{ color: color ?? "var(--ink)" }} data-tip={typeof value === "string" ? value : undefined}>{value}</div>
    </div>
  );
}

/** uTorrent-style "pieces" bar: segmented blocks filled to the collected pct. */
function CollectedBar({ pct, color }: { pct: number; color: string }) {
  const N = 64;
  const filled = Math.round((pct / 100) * N);
  return (
    <div className="flex h-[11px] gap-px overflow-hidden rounded-[3px] bg-[var(--soft)]">
      {Array.from({ length: N }, (_, i) => (
        <div key={i} className="flex-1" style={{ background: i < filled ? color : "transparent", opacity: i < filled ? 0.9 : 1 }} />
      ))}
    </div>
  );
}

/** Bottom "Info" panel for the selected transfer — the torrent-client detail. */
function InfoPanel({ row, samples, stats }: { row: TransferRow; samples: number[]; stats?: RowStats }) {
  const ft = fileType(row.name, false);
  const color = STATE_COLOR[row.state];
  const active = row.state === "downloading" || row.state === "uploading";
  const done = row.state === "completed" || row.state === "failed" || row.state === "cancelled";
  const completed = row.state === "completed";
  const pct = completed ? 100 : row.pct;
  const downloaded = completed ? row.size : row.bytes;
  const remaining = Math.max(0, row.size - downloaded);
  // Prefer the persisted finished stats (they outlive the in-flight job and its
  // live stats); fall back to live in-flight stats while it's still running.
  const liveElapsed = stats?.startedAt ? Date.now() - stats.startedAt : undefined;
  const elapsedMs = done ? row.durationMs : liveElapsed;
  const avg = done ? row.avgSpeed : liveElapsed && liveElapsed > 0 ? row.bytes / (liveElapsed / 1000) : undefined;
  const peak = done ? row.peakSpeed : stats?.peakSpeed;
  return (
    <div className="flex min-h-0 flex-col border-t border-[var(--line)] bg-[var(--card)]">
      <div className="flex items-center gap-2 px-5 pt-3">
        <ft.Icon size={16} style={{ color: ft.color }} className="shrink-0" />
        <span className="select-text truncate text-[13px] font-semibold text-[var(--ink)]">{row.name}</span>
        <span className="ml-1 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ color, background: "var(--soft)" }}>{stateLabel(row)}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-5 pb-4 pt-3">
        {/* Progress + collected-data (pieces) bar */}
        <div className="mb-3">
          <div className="mb-1 flex items-center justify-between font-mono text-[10px]">
            <span className="tnum text-[var(--mut)]">{formatBytes(downloaded)} <span className="text-[var(--faint)]">/ {formatBytes(row.size)}</span></span>
            <span className="tnum font-semibold" style={{ color }}>{pct}%</span>
          </div>
          <CollectedBar pct={pct} color={color} />
        </div>
        {active && samples.length > 1 && (
          <div className="mb-3 h-14">
            <SpeedGraph samples={samples} height={56} speed={row.speed} peak={peak} />
          </div>
        )}
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
          <Stat label="Progress" value={`${pct}%`} color={color} />
          <Stat label="Size" value={formatBytes(row.size)} />
          <Stat label="Downloaded" value={formatBytes(downloaded)} />
          <Stat label="Remaining" value={completed ? "0 B" : formatBytes(remaining)} />
          <Stat label="Speed" value={active ? formatSpeed(row.speed) : "·"} color={active && row.speed > 0 ? "var(--dl)" : undefined} />
          <Stat label="ETA" value={active ? formatEta(row.eta) : completed ? "Done" : "·"} />
          <Stat label="Avg speed" value={avg ? formatSpeed(avg) : "·"} />
          <Stat label="Peak speed" value={peak ? formatSpeed(peak) : "·"} />
          <Stat label="Elapsed" value={elapsedMs != null ? fmtDur(elapsedMs) : "·"} />
          <Stat label="Account" value={row.account} />
          <Stat label="Source" value={row.source} />
          <Stat label="Destination" value={row.dest || "·"} />
          {row.at && <Stat label="Finished" value={new Date(row.at).toLocaleString()} />}
        </div>
        {row.error && (
          <div className="mt-3 flex items-start gap-2 rounded-[9px] border border-[var(--line)] bg-[var(--soft)] p-2.5 text-[11.5px] text-[var(--err)]">
            <AlertCircle size={13} className="mt-0.5 shrink-0" /> <span className="min-w-0">{row.error}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Confirm dialog: remove from the list only, or also delete files from disk. */
function DeleteDialog({ row, onClose, onConfirm }: { row: TransferRow; onClose: () => void; onConfirm: (withFiles: boolean) => void }) {
  return createPortal(
    <div className="fixed inset-0 z-[160] flex items-center justify-center bg-black/40 p-4" onMouseDown={onClose}>
      <div className="animate-pop w-[420px] max-w-full rounded-[14px] border border-[var(--line)] bg-[var(--card)] p-5 shadow-[var(--shadow-lg)]" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <Trash2 size={16} className="text-[var(--err)]" />
          <h2 className="text-[15px] font-semibold text-[var(--ink)]">Delete transfer</h2>
        </div>
        <p className="mt-2 truncate text-[13px] font-medium text-[var(--ink)]" data-tip={row.name}>{row.name}</p>
        <p className="mt-1 text-[12.5px] text-[var(--faint)]">Remove it from the list only, or also delete the downloaded files from disk? Deleting files can’t be undone.</p>
        <div className="mt-4 flex flex-col gap-2">
          <button onClick={() => onConfirm(false)} className="w-full rounded-[9px] border border-[var(--line)] px-3 py-2 text-[13px] font-semibold text-[var(--ink)] hover:bg-[var(--soft)]">
            Remove from list
          </button>
          {!row.upload && (
            <button onClick={() => onConfirm(true)} className="w-full rounded-[9px] border border-[var(--err)] bg-[var(--errw)] px-3 py-2 text-[13px] font-semibold text-[var(--err)] hover:opacity-90">
              Delete from list and files
            </button>
          )}
          <button onClick={onClose} className="w-full rounded-[9px] px-3 py-2 text-[13px] font-medium text-[var(--faint)] hover:text-[var(--ink)]">
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Confirm dialog for removing many transfers at once. */
function BulkDeleteDialog({ rows, onClose, onConfirm }: { rows: TransferRow[]; onClose: () => void; onConfirm: (withFiles: boolean) => void }) {
  const anyFiles = rows.some((r) => !r.upload);
  return createPortal(
    <div className="fixed inset-0 z-[160] flex items-center justify-center bg-black/40 p-4" onMouseDown={onClose}>
      <div className="animate-pop w-[420px] max-w-full rounded-[14px] border border-[var(--line)] bg-[var(--card)] p-5 shadow-[var(--shadow-lg)]" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <Trash2 size={16} className="text-[var(--err)]" />
          <h2 className="text-[15px] font-semibold text-[var(--ink)]">Delete {rows.length} transfers</h2>
        </div>
        <p className="mt-1 text-[12.5px] text-[var(--faint)]">Remove them from the list only, or also delete the downloaded files from disk? Deleting files can’t be undone.</p>
        <div className="mt-4 flex flex-col gap-2">
          <button onClick={() => onConfirm(false)} className="w-full rounded-[9px] border border-[var(--line)] px-3 py-2 text-[13px] font-semibold text-[var(--ink)] hover:bg-[var(--soft)]">
            Remove from list
          </button>
          {anyFiles && (
            <button onClick={() => onConfirm(true)} className="w-full rounded-[9px] border border-[var(--err)] bg-[var(--errw)] px-3 py-2 text-[13px] font-semibold text-[var(--err)] hover:opacity-90">
              Delete from list and files
            </button>
          )}
          <button onClick={onClose} className="w-full rounded-[9px] px-3 py-2 text-[13px] font-medium text-[var(--faint)] hover:text-[var(--ink)]">
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function TransferTable({ rows, speedHistory, statsFor, ...actions }: TransferTableProps) {
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const anchorRef = useRef<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; batch: boolean } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TransferRow | null>(null);
  const [pendingBulk, setPendingBulk] = useState<TransferRow[] | null>(null);

  // Prune ids that no longer exist (rows finished/removed) so the selection and
  // its derived UI (info panel, batch bar) never point at a stale row.
  useEffect(() => {
    setSel((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(rows.map((r) => r.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) { if (live.has(id)) next.add(id); else changed = true; }
      return changed ? next : prev;
    });
  }, [rows]);

  const selectedRows = useMemo(() => rows.filter((r) => sel.has(r.id)), [rows, sel]);
  const single = sel.size === 1 ? selectedRows[0] : undefined;

  const selectRow = (e: React.MouseEvent, r: TransferRow, i: number) => {
    const id = r.id;
    if (e.metaKey || e.ctrlKey) {
      setSel((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
      anchorRef.current = id;
    } else if (e.shiftKey && anchorRef.current) {
      const ai = rows.findIndex((x) => x.id === anchorRef.current);
      if (ai >= 0) {
        const [lo, hi] = ai < i ? [ai, i] : [i, ai];
        setSel(new Set(rows.slice(lo, hi + 1).map((x) => x.id)));
      } else { setSel(new Set([id])); anchorRef.current = id; }
    } else {
      setSel((prev) => (prev.size === 1 && prev.has(id) ? new Set() : new Set([id])));
      anchorRef.current = id;
    }
  };

  const openMenu = (e: React.MouseEvent, r: TransferRow) => {
    e.preventDefault();
    // Right-clicking a row already inside a multi-selection keeps it and opens a
    // batch menu; otherwise the click selects just that row.
    const batch = sel.has(r.id) && sel.size > 1;
    if (!batch) { setSel(new Set([r.id])); anchorRef.current = r.id; }
    setMenu({ x: e.clientX, y: e.clientY, batch });
  };

  // Keyboard: Escape clears, Cmd/Ctrl+A selects all, Delete removes the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "Escape") { setSel(new Set()); setMenu(null); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && rows.length) {
        e.preventDefault();
        setSel(new Set(rows.map((r) => r.id)));
      } else if ((e.key === "Delete" || e.key === "Backspace") && sel.size && actions.onDelete) {
        e.preventDefault();
        const rs = rows.filter((r) => sel.has(r.id));
        if (rs.length === 1) setPendingDelete(rs[0]); else if (rs.length) setPendingBulk(rs);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, sel, actions]);

  const menuRows = menu?.batch ? selectedRows : single ? [single] : [];
  const menuItems = menu
    ? menu.batch
      ? buildBatchMenu(selectedRows, actions, () => setPendingBulk(selectedRows))
      : menuRows[0]
        ? buildMenu(menuRows[0], actions, (r) => setPendingDelete(r))
        : []
    : [];

  const applyBulk = (rs: TransferRow[], withFiles: boolean) => {
    rs.forEach((r) => actions.onDelete?.(r, withFiles));
    setPendingBulk(null);
    setSel(new Set());
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[13px] border border-[var(--line)] bg-[var(--card)]">
      {/* Batch action bar — shown while more than one row is selected. */}
      {sel.size > 1 && (
        <BatchBar
          rows={selectedRows}
          actions={actions}
          onClear={() => setSel(new Set())}
          onBulkDelete={() => setPendingBulk(selectedRows)}
        />
      )}

      {/* Column header */}
      <div
        className="grid items-center gap-2 border-b border-[var(--line)] bg-[var(--soft)] px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.05em] text-[var(--faint)]"
        style={{ gridTemplateColumns: COLS }}
      >
        <span className="text-right">#</span>
        <span>Name</span>
        <span className="text-right">Size</span>
        <span className="pl-1">Status</span>
        <span className="text-right">Speed</span>
        <span className="text-right">ETA</span>
        <span className="text-right">Source</span>
        <span />
      </div>

      {/* Rows */}
      <div className="min-h-0 flex-1 overflow-auto">
        {rows.map((r, i) => (
          <Row
            key={r.id}
            row={r}
            index={i}
            selected={sel.has(r.id)}
            onSelect={(e) => selectRow(e, r, i)}
            onContext={(e) => openMenu(e, r)}
            onRequestDelete={setPendingDelete}
            actions={actions}
          />
        ))}
      </div>

      {/* Bottom info panel — only for a single selected row. */}
      {single && (
        <div className="max-h-[46%] min-h-0 shrink-0">
          <InfoPanel
            row={single}
            samples={(single.jobId != null && speedHistory?.[single.jobId]) || []}
            stats={single.jobId != null ? statsFor?.(single.jobId) : undefined}
          />
        </div>
      )}

      {menu && menuItems.length > 0 && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}

      {pendingDelete && (
        <DeleteDialog
          row={pendingDelete}
          onClose={() => setPendingDelete(null)}
          onConfirm={(withFiles) => { actions.onDelete?.(pendingDelete, withFiles); setPendingDelete(null); setSel(new Set()); }}
        />
      )}

      {pendingBulk && (
        <BulkDeleteDialog
          rows={pendingBulk}
          onClose={() => setPendingBulk(null)}
          onConfirm={(withFiles) => applyBulk(pendingBulk, withFiles)}
        />
      )}
    </div>
  );
}

/** Sticky toolbar with batch actions for the current multi-selection. */
function BatchBar({ rows, actions, onClear, onBulkDelete }: { rows: TransferRow[]; actions: RowActions; onClear: () => void; onBulkDelete: () => void }) {
  const retry = rows.filter(isRetryable);
  const pause = rows.filter(isPausable);
  const resume = rows.filter(isResumable);
  const Btn = ({ icon: Icon, label, danger, onClick }: { icon: typeof RotateCcw; label: string; danger?: boolean; onClick: () => void }) => (
    <button
      onClick={onClick}
      className={`flex h-7 items-center gap-1.5 rounded-[8px] border px-2.5 text-[12px] font-semibold ${danger ? "border-[var(--err)]/40 text-[var(--err)] hover:bg-[var(--errw)]" : "border-[var(--line)] text-[var(--ink)] hover:bg-[var(--soft)]"}`}
    >
      <Icon size={13} /> {label}
    </button>
  );
  return (
    <div className="flex items-center gap-2 border-b border-[var(--line)] bg-[var(--accw)] px-4 py-2">
      <span className="text-[12.5px] font-semibold text-[var(--ink)]">{rows.length} selected</span>
      <div className="ml-1 flex items-center gap-1.5">
        {retry.length > 0 && <Btn icon={RotateCcw} label={`Retry ${retry.length}`} onClick={() => retry.forEach((r) => retryRow(r, actions))} />}
        {resume.length > 0 && <Btn icon={Play} label={`Resume ${resume.length}`} onClick={() => resume.forEach((r) => actions.onResumeQueued?.(r.queueId!))} />}
        {pause.length > 0 && <Btn icon={Pause} label={`Pause ${pause.length}`} onClick={() => pause.forEach((r) => actions.onPause?.(r.jobId!))} />}
        {actions.onDelete && <Btn icon={Trash2} label="Delete" danger onClick={onBulkDelete} />}
      </div>
      <button onClick={onClear} className="ml-auto text-[12px] font-medium text-[var(--faint)] hover:text-[var(--ink)]">Clear</button>
    </div>
  );
}
