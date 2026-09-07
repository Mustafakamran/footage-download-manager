import { memo, useMemo, useState } from "react";
import { ChevronDown, X, Check, AlertCircle, AlertTriangle, RefreshCw, Ban, Clock, Pause, Play, Globe, ArrowDown, ArrowUp, ArrowDownUp } from "lucide-react";
import { useTransfers, type QueueItem, type BlockKind } from "../store/transfers";

/** Short fix hint per block kind, shown on a "needs attention" transfer. */
const BLOCK_HINT: Record<BlockKind, string> = {
  disk: "Free up disk space, then Retry",
  network: "Network problem — will retry",
  auth: "Account access issue — reconnect, then Retry",
  rate: "Rate-limited — will retry",
  unknown: "Paused after an error — Retry when ready",
};
import { useHistory, type HistoryEntry } from "../store/history";
import { useApp } from "../store/app";
import { useSettings } from "../store/settings";
import { fileType } from "../lib/file-types";
import { laneOf } from "../lib/lane";
import { formatBytes, formatSpeed, formatEta } from "../lib/format";
import type { JobStatus } from "../lib/tauri/commands";

/** id → display label, so rows look up account names without scanning `accounts`. */
type LabelOf = (accountId: string) => string;

type Tab = "all" | "active" | "completed" | "failed";
const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
];

/** Small lane badge: "Web" for secondary, the account label for primary. */
function LaneBadge({ accountId, labelOf }: { accountId: string; labelOf: LabelOf }) {
  if (laneOf(accountId) === "secondary") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--soft)] px-1.5 py-px text-[9px] font-medium text-[var(--faint)]">
        <Globe size={9} /> Web
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--soft)] px-1.5 py-px text-[9px] font-medium text-[var(--faint)]">
      {labelOf(accountId)}
    </span>
  );
}

const QueueRow = memo(function QueueRow({ q, position, labelOf }: { q: QueueItem; position: number; labelOf: LabelOf }) {
  const removeQueued = useTransfers((s) => s.removeQueued);
  const resumePaused = useTransfers((s) => s.resumePaused);
  const ft = fileType(q.item.name, q.item.isDir);
  const gated = !!q.autoPaused && !q.paused;
  const blocked = !!q.blocked;
  return (
    <div className={`group flex items-center gap-2.5 px-3.5 py-2 ${blocked ? "bg-[var(--warn)]/8" : ""}`}>
      <span className="relative shrink-0">
        <ft.Icon size={17} style={{ color: ft.color }} className="opacity-60" />
        <ArrowDown size={9} className="absolute -bottom-1 -right-1 rounded-full bg-[var(--card)] text-[var(--faint)]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12.5px] text-[var(--mut)]" title={q.item.name}>{q.item.name}</span>
          <LaneBadge accountId={q.accountId} labelOf={labelOf} />
        </div>
        <div className={`flex items-center gap-1 text-[10.5px] ${blocked ? "text-[var(--warn)]" : "text-[var(--faint)]"}`}>
          {blocked ? <AlertTriangle size={10} /> : gated ? <Clock size={10} /> : q.paused ? <Pause size={10} /> : <Clock size={10} />}
          <span className="truncate" title={q.blockedError}>
            {blocked
              ? q.nextRetryAt
                ? `Retrying soon — ${BLOCK_HINT[q.blockedKind ?? "unknown"]}`
                : BLOCK_HINT[q.blockedKind ?? "unknown"]
              : gated
                ? "Waiting for Drive/Dropbox…"
                : q.paused
                  ? `Paused · ${formatBytes(q.resumedBytes ?? 0)} done`
                  : q.resumedBytes
                    ? `Resuming · ${formatBytes(q.resumedBytes)} done`
                    : `Queued · #${position}`}
          </span>
        </div>
      </div>
      {blocked && !q.nextRetryAt && (
        <button onClick={() => resumePaused(q.id)} aria-label={`Retry ${q.item.name}`} title="Retry" className="flex shrink-0 items-center gap-1 rounded-[7px] bg-[var(--warn)]/15 px-2 py-1 text-[10.5px] font-semibold text-[var(--warn)] hover:bg-[var(--warn)]/25">
          <RefreshCw size={11} /> Retry
        </button>
      )}
      {q.paused && !blocked && (
        <button onClick={() => resumePaused(q.id)} aria-label={`Resume ${q.item.name}`} title="Resume" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] text-[var(--faint)] opacity-0 transition hover:bg-[var(--soft)] hover:text-[var(--acc)] group-hover:opacity-100">
          <Play size={13} />
        </button>
      )}
      <button onClick={() => removeQueued(q.id)} aria-label={`Remove ${q.item.name}`} title="Remove from queue" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] text-[var(--faint)] opacity-0 transition hover:bg-[var(--soft)] hover:text-[var(--err)] group-hover:opacity-100">
        <X size={13} />
      </button>
    </div>
  );
});

function pct(j: JobStatus): number {
  if (j.finished && j.success) return 100;
  if (j.totalBytes > 0) return Math.min(100, Math.round((j.bytes / j.totalBytes) * 100));
  return 0;
}

// listJobs() returns a freshly-deserialized JobStatus for every job on every 1s
// tick even when nothing changed, so a bare memo() would re-render anyway.
// Compare the rendered fields so idle rows skip re-render while active ones update.
function jobRowPropsEqual(prev: { job: JobStatus; labelOf: LabelOf }, next: { job: JobStatus; labelOf: LabelOf }): boolean {
  return (
    prev.labelOf === next.labelOf &&
    prev.job.jobId === next.job.jobId &&
    prev.job.bytes === next.job.bytes &&
    prev.job.totalBytes === next.job.totalBytes &&
    prev.job.speed === next.job.speed &&
    prev.job.finished === next.job.finished &&
    prev.job.success === next.job.success &&
    prev.job.cancelled === next.job.cancelled &&
    prev.job.error === next.job.error &&
    prev.job.eta === next.job.eta
  );
}

const Row = memo(function Row({ job, labelOf }: { job: JobStatus; labelOf: LabelOf }) {
  const cancel = useTransfers((s) => s.cancel);
  const pause = useTransfers((s) => s.pause);
  const dismissUpload = useTransfers((s) => s.dismissUpload);
  const ft = fileType(job.name, false);
  const p = pct(job);
  const active = !job.finished && !job.cancelled;
  const isUpload = job.kind === "upload";
  const Dir = isUpload ? ArrowUp : ArrowDown;
  const failed = job.finished && !job.success && !job.cancelled;
  const barColor = job.cancelled ? "var(--faint)" : failed ? "var(--err)" : "var(--dl)";

  return (
    <div className="group relative flex items-center gap-2.5 overflow-hidden px-3.5 py-2.5">
      {/* Dropbox-style row-fill: a tinted highlight grows left→right across the
          whole row as the transfer progresses, behind the content. */}
      {active && (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 transition-[width] duration-500 ease-out"
          style={{ width: `${p}%`, backgroundColor: barColor, opacity: 0.14 }}
        />
      )}
      <span className="relative shrink-0">
        <ft.Icon size={17} style={{ color: ft.color }} />
        <Dir size={9} className="absolute -bottom-1 -right-1 rounded-full bg-[var(--card)] text-[var(--faint)]" />
      </span>
      <div className="relative min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12.5px] text-[var(--ink)]" title={job.name}>{job.name}</span>
          <LaneBadge accountId={job.accountId} labelOf={labelOf} />
        </div>
        <div className="tnum mt-0.5 text-[10.5px] leading-tight text-[var(--faint)]">
          {active ? (
            <>
              {formatBytes(job.bytes)} / {formatBytes(job.totalBytes || job.bytes)}
              {job.speed > 0 ? ` · ${formatSpeed(job.speed)}` : ""}
              {job.eta != null ? ` · ${formatEta(job.eta)} left` : ""}
            </>
          ) : job.cancelled ? (
            <span className="text-[var(--faint)]">Cancelled</span>
          ) : failed ? (
            <span className="text-[var(--err)]" title={job.error}>{job.error || "Failed"}</span>
          ) : (
            <span>{isUpload ? "Uploaded" : "Downloaded"} · {formatBytes(job.totalBytes || job.bytes)}</span>
          )}
        </div>
      </div>

      <span className="relative flex w-9 shrink-0 justify-end">
        {job.cancelled ? <Ban size={14} className="text-[var(--faint)]" />
          : job.finished && job.success ? <Check size={14} className="text-[var(--ok)]" />
          : failed ? <span title={job.error}><AlertCircle size={14} className="text-[var(--err)]" /></span>
          : <span className="tnum text-[11px] font-semibold text-[var(--mut)]">{p}%</span>}
      </span>

      {active ? (
        <div className="relative flex shrink-0 items-center gap-0.5">
          {!isUpload && <button onClick={() => pause(job.jobId)} aria-label={`Pause ${job.name}`} title="Pause" className="flex h-6 w-6 items-center justify-center rounded-[7px] text-[var(--faint)] hover:bg-[var(--soft)] hover:text-[var(--acc)]"><Pause size={13} /></button>}
          <button onClick={() => cancel(job.jobId)} aria-label={`Cancel ${job.name}`} title="Cancel" className="flex h-6 w-6 items-center justify-center rounded-[7px] text-[var(--faint)] hover:bg-[var(--soft)] hover:text-[var(--err)]"><X size={13} /></button>
        </div>
      ) : isUpload ? (
        <button onClick={() => dismissUpload(job.jobId)} aria-label={`Dismiss ${job.name}`} title="Dismiss" className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] text-[var(--faint)] opacity-0 transition hover:bg-[var(--soft)] hover:text-[var(--ink)] group-hover:opacity-100"><X size={13} /></button>
      ) : (
        <span className="w-6 shrink-0" />
      )}
    </div>
  );
}, jobRowPropsEqual);

/** Finished transfer from persisted history (completed/failed/cancelled) —
 *  mirrors what the full Transfers screen shows so the drawer isn't empty after
 *  jobs settle out of memory. */
const HistoryRow = memo(function HistoryRow({ h, labelOf }: { h: HistoryEntry; labelOf: LabelOf }) {
  const ft = fileType(h.name, false);
  const ok = h.status === "success";
  const failed = h.status === "failed";
  return (
    <div className="group flex items-center gap-2.5 px-3.5 py-2.5">
      <span className="relative shrink-0">
        <ft.Icon size={17} style={{ color: ft.color }} />
        <ArrowDown size={9} className="absolute -bottom-1 -right-1 rounded-full bg-[var(--card)] text-[var(--faint)]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12.5px] text-[var(--ink)]" title={h.name}>{h.name}</span>
          <LaneBadge accountId={h.accountId} labelOf={labelOf} />
        </div>
        <div className="mt-0.5 text-[10.5px] leading-tight text-[var(--faint)]">
          {ok ? <>Downloaded · {formatBytes(h.size)}</>
            : failed ? <span className="text-[var(--err)]" title={h.error}>{h.error || "Failed"}</span>
            : <>Cancelled · {formatBytes(h.size)}</>}
        </div>
      </div>
      <span className="flex w-9 shrink-0 justify-end">
        {ok ? <Check size={14} className="text-[var(--ok)]" />
          : failed ? <AlertCircle size={14} className="text-[var(--err)]" />
          : <Ban size={14} className="text-[var(--faint)]" />}
      </span>
      <span className="w-6 shrink-0" />
    </div>
  );
});

/**
 * Floating Transfers drawer (Dropbox-style): a collapsible bottom-right panel
 * showing every background transfer — downloads (active + queued) AND uploads —
 * with progress, ETA, cancel/pause, and All/Active/Completed/Failed tabs. Hidden
 * on the Transfers screen (which has the full table); mounted in AppShell.
 */
export function DownloadsDock() {
  const jobs = useTransfers((s) => s.jobs);
  const queue = useTransfers((s) => s.queue);
  const uploads = useTransfers((s) => s.uploads);
  const dragActive = useTransfers((s) => s.dragActive);
  const history = useHistory((s) => s.items);
  const accounts = useApp((s) => s.accounts);
  const labelOf = useMemo<LabelOf>(() => {
    const byId = new Map(accounts.map((a) => [a.id, a.label]));
    return (id: string) => byId.get(id) ?? id;
  }, [accounts]);
  const [open, setOpen] = useState(false);
  const [collapsing, setCollapsing] = useState(false);
  const [tab, setTab] = useState<Tab>("all");
  const showDrawer = useSettings((s) => s.showTransferDrawer);
  // Collapse plays the reverse morph; the drawer's onAnimationEnd then swaps to
  // the button (more reliable than a fixed timer).
  const collapse = () => setCollapsing(true);

  const retryAllBlocked = useTransfers((s) => s.retryAllBlocked);
  const blockedCount = queue.filter((q) => q.blocked && !q.nextRetryAt).length;

  const isActive = (j: JobStatus) => !j.finished && !j.cancelled;
  const activeJobs = jobs.filter(isActive);
  const activeUploads = uploads.filter(isActive);
  const doneUploads = uploads.filter((j) => !isActive(j));

  const activeCount = activeJobs.length + activeUploads.length + queue.filter((q) => !q.paused).length;

  // The drawer is a PERSISTENT feature (collapses to a circular button); it's
  // hidden entirely only when the user turns it off in Settings.
  if (!showDrawer) return null;

  // Dragging an app file/folder forces the panel open so it's a drop target.
  // Keep the panel mounted WHILE collapsing so its exit animation can play.
  const expanded = open || dragActive || collapsing;

  // Collapsed → slim vertical bookmark tab on the right edge. Click to expand.
  if (!expanded) {
    const transferring = activeJobs.length + activeUploads.length;
    return (
      <div className="animate-pop fixed bottom-16 right-0 z-40">
        <button
          onClick={() => setOpen(true)}
          aria-label="Open transfers"
          data-tip="Transfers"
          className="group relative flex w-[40px] flex-col items-center gap-1.5 rounded-l-[11px] border border-r-0 border-[var(--line)] bg-[var(--card)] py-2.5 text-[var(--acc)] shadow-[-6px_0_16px_-8px_rgba(0,0,0,0.25)] transition-colors hover:bg-[var(--soft)]"
        >
          <span className="relative shrink-0">
            <ArrowDownUp size={16} />
            {blockedCount > 0 ? (
              <span className="absolute -right-1.5 -top-1.5 flex h-[14px] w-[14px] items-center justify-center rounded-full border-2 border-[var(--card)] bg-[var(--warn)] text-[var(--onacc)]">
                <AlertTriangle size={8} />
              </span>
            ) : transferring > 0 ? (
              <span className="absolute -right-1.5 -top-1.5 h-[12px] w-[12px] rounded-full border-2 border-[var(--card)] bg-[var(--ok)]" />
            ) : activeCount > 0 ? (
              <span className="tnum absolute -right-2 -top-2 flex h-[15px] min-w-[15px] items-center justify-center rounded-full border-2 border-[var(--card)] bg-[var(--acc)] px-0.5 text-[9px] font-bold text-[var(--onacc)]">
                {activeCount > 9 ? "9+" : activeCount}
              </span>
            ) : null}
          </span>
          <span
            className="text-[11.5px] font-semibold text-[var(--ink)]"
            style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
          >
            Transfers
          </span>
        </button>
      </div>
    );
  }

  // Finished transfers come from persisted HISTORY (like the Transfers screen),
  // not the in-memory jobs array (which drops jobs once they settle) — plus any
  // finished uploads (uploads aren't persisted to history).
  const histCompleted = history.filter((h) => h.status === "success");
  const histFailed = history.filter((h) => h.status === "failed");
  const upDone = doneUploads;
  const completedCount = histCompleted.length + upDone.filter((u) => u.success).length;
  const failedCount = histFailed.length + upDone.filter((u) => !u.success && !u.cancelled).length;

  // Which sections to render for the active tab.
  const showActive = tab === "all" || tab === "active";
  const dlRows = showActive ? activeJobs : [];
  const ulRows = showActive ? activeUploads : [];
  const queueRows = showActive ? queue : [];
  const historyRows = tab === "completed" ? histCompleted : tab === "failed" ? histFailed : tab === "all" ? history : [];
  const upDoneRows = tab === "completed" ? upDone.filter((u) => u.success)
    : tab === "failed" ? upDone.filter((u) => !u.success && !u.cancelled)
    : tab === "all" ? upDone : [];

  // Total progress across active downloads + uploads.
  const activeAll = [...activeJobs, ...activeUploads];
  const totalSpeed = activeAll.reduce((s, j) => s + Math.max(0, j.speed), 0);

  const empty = dlRows.length === 0 && ulRows.length === 0 && queueRows.length === 0 && historyRows.length === 0 && upDoneRows.length === 0;

  return (
    <div
      data-transfer-drop
      onAnimationEnd={(e) => { if (collapsing && e.animationName === "drawer-collapse") { setCollapsing(false); setOpen(false); } }}
      className={`${collapsing ? "animate-drawer-out" : "animate-drawer"} fixed bottom-0 right-6 z-40 flex w-[400px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-t-[14px] border border-b-0 bg-[var(--card)] shadow-[var(--shadow-lg)] ${dragActive ? "border-2 border-dashed border-[var(--acc)]" : "border border-b-0 border-[var(--line2)]"}`}
    >
      {/* Drop-to-download hint while dragging an app file/folder onto the drawer. */}
      {dragActive && (
        <div className="pointer-events-none flex items-center justify-center gap-2 border-b border-[var(--line)] bg-[var(--accw)] px-4 py-3 text-[12.5px] font-semibold text-[var(--acc)]">
          <ArrowDown size={15} /> Drop here to download
        </div>
      )}
      {/* Header — collapse to the circular button (no close/clear: it's a
          persistent feature, toggled in Settings). */}
      <div className="animate-drawer-content flex items-center gap-2 px-3.5 py-2.5">
        <button onClick={collapse} aria-label="Collapse transfers" className="flex min-w-0 flex-1 items-center gap-2 text-[13px] font-semibold text-[var(--ink)]">
          <ArrowDownUp size={15} className="shrink-0 text-[var(--acc)]" />
          <span>Transfers</span>
          {activeCount > 0 && <span className="tnum text-[var(--mut)]">· {activeCount} active</span>}
          <span className="ml-auto flex h-6 w-6 items-center justify-center text-[var(--faint)]"><ChevronDown size={16} /></span>
        </button>
      </div>

      {/* Needs-attention banner — recoverable failures held for a fix + retry. */}
      {blockedCount > 0 && (
        <div className="flex items-center gap-2 border-y border-[var(--warn)]/25 bg-[var(--warn)]/10 px-3.5 py-2 text-[12px] font-medium text-[var(--warn)]">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="min-w-0 flex-1">{blockedCount} transfer{blockedCount > 1 ? "s" : ""} need attention</span>
          <button onClick={() => retryAllBlocked()} className="shrink-0 rounded-[7px] bg-[var(--warn)]/20 px-2 py-1 text-[11px] font-semibold hover:bg-[var(--warn)]/30">Retry all</button>
        </div>
      )}

      {(
        <>
          {/* Tabs */}
          <div className="flex items-center gap-1 px-3 pb-2">
            {TABS.map((t) => {
              const on = tab === t.key;
              const badge = t.key === "active" ? activeCount : t.key === "completed" ? completedCount : t.key === "failed" ? failedCount : 0;
              return (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`h-6 rounded-full px-2.5 text-[11px] font-semibold ${on ? "bg-[var(--acc)] text-[var(--onacc)]" : "text-[var(--mut)] hover:bg-[var(--soft)]"}`}
                >
                  {t.label}{badge > 0 && t.key !== "all" ? ` ${badge}` : ""}
                </button>
              );
            })}
          </div>

          {/* Rows */}
          <div className="max-h-[70vh] min-h-[300px] divide-y divide-[var(--line)] overflow-auto border-t border-[var(--line)]">
            {empty ? (
              <div className="px-4 py-8 text-center text-[12px] text-[var(--faint)]">
                {dragActive ? "Drop a file or folder here to download it." : "Nothing here."}
              </div>
            ) : (
              <>
                {dlRows.map((j) => <Row key={`j${j.jobId}`} job={j} labelOf={labelOf} />)}
                {ulRows.map((j) => <Row key={`u${j.jobId}`} job={j} labelOf={labelOf} />)}
                {queueRows.map((q, i) => <QueueRow key={q.id} q={q} position={i + 1} labelOf={labelOf} />)}
                {upDoneRows.map((j) => <Row key={`u${j.jobId}`} job={j} labelOf={labelOf} />)}
                {historyRows.map((h) => <HistoryRow key={h.id ?? `${h.jobId}-${h.name}`} h={h} labelOf={labelOf} />)}
              </>
            )}
          </div>
        </>
      )}

      {/* Footer: compact summary only (per-row fill shows each transfer's
          progress now — no separate bar). */}
      {activeCount > 0 && (
        <div className="flex items-center justify-between border-t border-[var(--line)] px-4 py-2 text-[11px] font-medium text-[var(--mut)]">
          <span>{activeAll.length > 0 ? `${activeAll.length} transferring` : `${activeCount} queued`}</span>
          {totalSpeed > 0 && <span className="tnum text-[var(--faint)]">{formatSpeed(totalSpeed)}</span>}
        </div>
      )}
    </div>
  );
}
