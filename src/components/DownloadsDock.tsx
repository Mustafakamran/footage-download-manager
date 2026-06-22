import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, X, Check, AlertCircle, Ban, Clock, Pause, Play, Globe } from "lucide-react";
import { useTransfers, type QueueItem } from "../store/transfers";
import { useApp } from "../store/app";
import { fileType } from "../lib/file-types";
import { laneOf } from "../lib/lane";
import { formatBytes, formatSpeed, formatEta } from "../lib/format";
import type { JobStatus } from "../lib/tauri/commands";

/** id → display label, so rows look up account names without scanning `accounts`. */
type LabelOf = (accountId: string) => string;

/** Small lane badge: "Web" for secondary, the account label for primary. */
function LaneBadge({ accountId, labelOf }: { accountId: string; labelOf: LabelOf }) {
  if (laneOf(accountId) === "secondary") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--hover)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-2)]">
        <Globe size={10} /> Web
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--hover)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-2)]">
      {labelOf(accountId)}
    </span>
  );
}

function QueueRow({ q, position, labelOf }: { q: QueueItem; position: number; labelOf: LabelOf }) {
  const removeQueued = useTransfers((s) => s.removeQueued);
  const resumePaused = useTransfers((s) => s.resumePaused);
  const ft = fileType(q.item.name, q.item.isDir);
  const gated = !!q.autoPaused && !q.paused;
  return (
    <div className="flex items-center gap-3 px-6 py-2.5">
      <ft.Icon size={20} style={{ color: ft.color }} className="shrink-0 opacity-70" />
      <div className="w-56 min-w-0 shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm text-[var(--text-2)]" title={q.item.name}>{q.item.name}</span>
          <LaneBadge accountId={q.accountId} labelOf={labelOf} />
        </div>
        <div className="truncate text-xs text-[var(--text-3)]">{labelOf(q.accountId)}</div>
      </div>
      <div className="flex flex-1 items-center gap-2 text-xs text-[var(--text-3)]">
        {gated ? <Clock size={13} /> : q.paused ? <Pause size={13} /> : <Clock size={13} />}
        {gated
          ? "Waiting for Drive/Dropbox to finish"
          : q.paused
            ? `Paused · ${formatBytes(q.resumedBytes ?? 0)} done`
            : q.resumedBytes
              ? `Resuming · ${formatBytes(q.resumedBytes)} done`
              : `Queued · #${position}`}
      </div>
      {q.paused && (
        <button onClick={() => resumePaused(q.id)} aria-label={`Resume ${q.item.name}`} title="Resume" className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-3)] hover:bg-[var(--hover)] hover:text-[var(--accent)]">
          <Play size={15} />
        </button>
      )}
      <button onClick={() => removeQueued(q.id)} aria-label={`Remove ${q.item.name} from queue`} title="Remove from queue" className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-3)] hover:bg-[var(--hover)] hover:text-[var(--error)]">
        <X size={15} />
      </button>
    </div>
  );
}

function pct(j: JobStatus): number {
  if (j.finished && j.success) return 100;
  if (j.totalBytes > 0) return Math.min(100, Math.round((j.bytes / j.totalBytes) * 100));
  return 0;
}

function Row({ job, labelOf }: { job: JobStatus; labelOf: LabelOf }) {
  const cancel = useTransfers((s) => s.cancel);
  const pause = useTransfers((s) => s.pause);
  const ft = fileType(job.name, false);
  const p = pct(job);
  const active = !job.finished && !job.cancelled;

  return (
    <div className="flex items-center gap-3 px-6 py-2.5">
      <ft.Icon size={20} style={{ color: ft.color }} className="shrink-0" />
      <div className="w-56 min-w-0 shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm text-[var(--text)]" title={job.name}>{job.name}</span>
          <LaneBadge accountId={job.accountId} labelOf={labelOf} />
        </div>
        <div className="truncate text-xs text-[var(--text-3)]">{labelOf(job.accountId)}</div>
      </div>

      <div className="flex flex-1 items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--hover)]">
          <div
            className="h-full rounded-full transition-[width] duration-500"
            style={{ width: `${p}%`, backgroundColor: job.cancelled ? "var(--text-3)" : job.finished && !job.success ? "var(--error)" : "var(--accent)" }}
          />
        </div>
        <span className="tnum w-44 shrink-0 text-right text-xs text-[var(--text-3)]">
          {active ? (
            <>{formatBytes(job.bytes)} / {formatBytes(job.totalBytes || job.bytes)} · {formatSpeed(job.speed)} · {formatEta(job.eta)}</>
          ) : job.cancelled ? (
            "Cancelled"
          ) : job.finished && job.success ? (
            formatBytes(job.totalBytes || job.bytes)
          ) : (
            <span className="text-[var(--error)]" title={job.error}>Failed</span>
          )}
        </span>
      </div>

      <span className="tnum w-10 shrink-0 text-right text-sm text-[var(--text)]">
        {job.cancelled ? <Ban size={15} className="ml-auto text-[var(--text-3)]" /> : job.finished && job.success ? <Check size={15} className="ml-auto text-[var(--success)]" /> : job.finished ? <span title={job.error}><AlertCircle size={15} className="ml-auto text-[var(--error)]" /></span> : `${p}%`}
      </span>
      {active ? (
        <div className="flex items-center gap-0.5">
          <button onClick={() => pause(job.jobId)} aria-label={`Pause ${job.name}`} title="Pause" className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-3)] hover:bg-[var(--hover)] hover:text-[var(--accent)]"><Pause size={15} /></button>
          <button onClick={() => cancel(job.jobId)} aria-label={`Cancel ${job.name}`} title="Cancel" className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-3)] hover:bg-[var(--hover)] hover:text-[var(--error)]"><X size={15} /></button>
        </div>
      ) : (
        <span className="w-7" />
      )}
    </div>
  );
}

export function DownloadsDock() {
  // Narrow selectors: subscribe only to the slices this dock renders, not the
  // whole transfers store (which mutates ~1Hz during active downloads).
  const jobs = useTransfers((s) => s.jobs);
  const queue = useTransfers((s) => s.queue);
  const clearFinished = useTransfers((s) => s.clearFinished);
  // One memoized id → label map instead of an accounts.find() scan per row.
  const accounts = useApp((s) => s.accounts);
  const labelOf = useMemo<LabelOf>(() => {
    const byId = new Map(accounts.map((a) => [a.id, a.label]));
    return (id: string) => byId.get(id) ?? id;
  }, [accounts]);
  const [open, setOpen] = useState(true);
  if (jobs.length === 0 && queue.length === 0) return null;

  const active = jobs.filter((j) => !j.finished && !j.cancelled);
  const totalBytes = jobs.reduce((s, j) => s + (j.totalBytes || 0), 0);
  const doneBytes = jobs.reduce((s, j) => s + (j.finished && j.success ? j.totalBytes || j.bytes : j.bytes), 0);
  const totalPct = totalBytes > 0 ? Math.min(100, Math.round((doneBytes / totalBytes) * 100)) : 0;

  return (
    <div className="shrink-0 overflow-hidden rounded-[12px] border border-[var(--border)] bg-[var(--surface)]">
      <div className="flex items-center justify-between px-6 py-2.5">
        <button onClick={() => setOpen((o) => !o)} title={open ? "Collapse" : "Expand"} className="flex items-center gap-2 text-sm font-medium text-[var(--text)]">
          {open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          Downloading <span className="tnum text-[var(--text-2)]">({active.length})</span>
          {queue.length > 0 && <span className="tnum text-[var(--text-3)]">· {queue.length} queued</span>}
        </button>
        <button onClick={() => clearFinished()} className="text-xs text-[var(--text-3)] hover:text-[var(--text)]">Clear done</button>
      </div>

      {open && (
        <div className="max-h-56 overflow-auto border-t border-[var(--border)]/60">
          {jobs.map((j) => <Row key={j.jobId} job={j} labelOf={labelOf} />)}
          {queue.map((q, i) => <QueueRow key={q.id} q={q} position={i + 1} labelOf={labelOf} />)}
        </div>
      )}

      <div className="flex items-center gap-4 border-t border-[var(--border)] px-6 py-2.5">
        <span className="shrink-0 text-sm text-[var(--text-2)]">Total Progress</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--hover)]">
          <div className="h-full rounded-full bg-[var(--accent)] transition-[width]" style={{ width: `${totalPct}%` }} />
        </div>
        <span className="tnum shrink-0 text-sm text-[var(--text-2)]">{formatBytes(doneBytes)} / {formatBytes(totalBytes)}</span>
      </div>
    </div>
  );
}
