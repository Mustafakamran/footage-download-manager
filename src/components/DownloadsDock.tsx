import { useState } from "react";
import { ChevronDown, ChevronUp, X, Check, AlertCircle, Ban } from "lucide-react";
import { useTransfers } from "../store/transfers";
import { useApp } from "../store/app";
import { fileType } from "../lib/file-types";
import { formatBytes, formatSpeed, formatEta } from "../lib/format";
import type { JobStatus } from "../lib/tauri/commands";

function pct(j: JobStatus): number {
  if (j.finished && j.success) return 100;
  if (j.totalBytes > 0) return Math.min(100, Math.round((j.bytes / j.totalBytes) * 100));
  return 0;
}

function Row({ job }: { job: JobStatus }) {
  const cancel = useTransfers((s) => s.cancel);
  const account = useApp((s) => s.accounts.find((a) => a.id === job.accountId));
  const ft = fileType(job.name, false);
  const p = pct(job);
  const active = !job.finished && !job.cancelled;

  return (
    <div className="flex items-center gap-3 px-6 py-2.5">
      <ft.Icon size={20} style={{ color: ft.color }} className="shrink-0" />
      <div className="w-56 min-w-0 shrink-0">
        <div className="truncate text-sm text-[var(--text)]" title={job.name}>{job.name}</div>
        <div className="truncate text-xs text-[var(--text-3)]">{account?.label ?? job.accountId}</div>
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
            <span className="text-[var(--error)]">Failed</span>
          )}
        </span>
      </div>

      <span className="tnum w-10 shrink-0 text-right text-sm text-[var(--text)]">
        {job.cancelled ? <Ban size={15} className="ml-auto text-[var(--text-3)]" /> : job.finished && job.success ? <Check size={15} className="ml-auto text-[var(--success)]" /> : job.finished ? <AlertCircle size={15} className="ml-auto text-[var(--error)]" /> : `${p}%`}
      </span>
      {active ? (
        <button onClick={() => cancel(job.jobId)} aria-label={`Cancel ${job.name}`} className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-3)] hover:bg-[var(--hover)] hover:text-[var(--error)]"><X size={15} /></button>
      ) : (
        <span className="w-7" />
      )}
    </div>
  );
}

export function DownloadsDock() {
  const { jobs, clearFinished } = useTransfers();
  const [open, setOpen] = useState(true);
  if (jobs.length === 0) return null;

  const active = jobs.filter((j) => !j.finished && !j.cancelled);
  const totalBytes = jobs.reduce((s, j) => s + (j.totalBytes || 0), 0);
  const doneBytes = jobs.reduce((s, j) => s + (j.finished && j.success ? j.totalBytes || j.bytes : j.bytes), 0);
  const totalPct = totalBytes > 0 ? Math.min(100, Math.round((doneBytes / totalBytes) * 100)) : 0;

  return (
    <div className="shrink-0 overflow-hidden rounded-[12px] border border-[var(--border)] bg-[var(--surface)]">
      <div className="flex items-center justify-between px-6 py-2.5">
        <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 text-sm font-medium text-[var(--text)]">
          {open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          Downloading <span className="tnum text-[var(--text-2)]">({active.length})</span>
        </button>
        <button onClick={() => clearFinished()} className="text-xs text-[var(--text-3)] hover:text-[var(--text)]">Clear done</button>
      </div>

      {open && (
        <div className="max-h-56 overflow-auto border-t border-[var(--border)]/60">
          {jobs.map((j) => <Row key={j.jobId} job={j} />)}
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
