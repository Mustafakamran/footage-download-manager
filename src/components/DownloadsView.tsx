import { X, Check, AlertCircle, Ban, Clock, Pause, Play } from "lucide-react";
import { useApp, type DownloadFilter } from "../store/app";
import { useTransfers } from "../store/transfers";
import { useHistory } from "../store/history";
import { fileType } from "../lib/file-types";
import { formatBytes, formatSpeed, formatEta } from "../lib/format";
import type { JobStatus } from "../lib/tauri/commands";

const TABS: { key: DownloadFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
];

function pct(j: JobStatus): number {
  if (j.totalBytes > 0) return Math.min(100, Math.round((j.bytes / j.totalBytes) * 100));
  return 0;
}

function AccountLabel({ accountId }: { accountId: string }) {
  const account = useApp((s) => s.accounts.find((a) => a.id === accountId));
  return <>{account?.label ?? accountId}</>;
}

export function DownloadsView({ filter }: { filter: DownloadFilter }) {
  const showDownloads = useApp((s) => s.showDownloads);
  const { jobs, queue, cancel, pause, resumePaused, removeQueued, enqueue } = useTransfers();
  const { items: history, clear, removeEntry } = useHistory();

  const active = jobs.filter((j) => !j.finished && !j.cancelled);
  const showActive = filter === "all" || filter === "active";
  const histFiltered = history.filter((h) =>
    filter === "completed" ? h.status === "success" : filter === "failed" ? h.status !== "success" : true,
  );
  const showHistory = filter !== "active";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-6 pt-6">
        <h1 className="text-lg font-semibold text-[var(--text)]">Downloads</h1>
        {history.length > 0 && (
          <button onClick={() => clear()} className="text-xs text-[var(--text-3)] hover:text-[var(--text)]">
            Clear history
          </button>
        )}
      </div>

      <div className="flex gap-1 px-6 py-3">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => showDownloads(t.key)}
            className={`rounded-[7px] px-3 py-1.5 text-sm ${
              filter === t.key ? "bg-[var(--hover)] text-[var(--text)]" : "text-[var(--text-2)] hover:bg-[var(--hover)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-6 pb-4">
        {showActive && (active.length > 0 || queue.length > 0) && (
          <div className="mb-4">
            <div className="mb-2 text-xs font-semibold tracking-wide text-[var(--text-3)]">IN PROGRESS</div>
            <div className="flex flex-col gap-1.5">
              {active.map((j) => {
                const ft = fileType(j.name, false);
                return (
                  <div key={j.jobId} className="flex items-center gap-3 rounded-[9px] border border-[var(--border)] bg-[var(--card)] px-4 py-3">
                    <ft.Icon size={20} style={{ color: ft.color }} className="shrink-0" />
                    <div className="w-56 min-w-0 shrink-0">
                      <div className="truncate text-sm text-[var(--text)]">{j.name}</div>
                      <div className="truncate text-xs text-[var(--text-3)]"><AccountLabel accountId={j.accountId} /></div>
                    </div>
                    <div className="flex flex-1 items-center gap-3">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--hover)]">
                        <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${pct(j)}%` }} />
                      </div>
                      <span className="tnum w-40 shrink-0 text-right text-xs text-[var(--text-3)]">
                        {formatBytes(j.bytes)} / {formatBytes(j.totalBytes || j.bytes)} · {formatSpeed(j.speed)} · {formatEta(j.eta)}
                      </span>
                    </div>
                    <button onClick={() => pause(j.jobId)} aria-label={`Pause ${j.name}`} className="text-[var(--text-3)] hover:text-[var(--accent)]">
                      <Pause size={15} />
                    </button>
                    <button onClick={() => cancel(j.jobId)} aria-label={`Cancel ${j.name}`} className="text-[var(--text-3)] hover:text-[var(--error)]">
                      <X size={15} />
                    </button>
                  </div>
                );
              })}
              {queue.map((q, i) => {
                const ft = fileType(q.item.name, q.item.isDir);
                return (
                  <div key={q.id} className="flex items-center gap-3 rounded-[9px] border border-[var(--border)] px-4 py-3">
                    <ft.Icon size={20} style={{ color: ft.color }} className="shrink-0 opacity-70" />
                    <div className="w-56 min-w-0 shrink-0">
                      <div className="truncate text-sm text-[var(--text-2)]">{q.item.name}</div>
                      <div className="truncate text-xs text-[var(--text-3)]"><AccountLabel accountId={q.accountId} /></div>
                    </div>
                    <div className="flex flex-1 items-center gap-2 text-xs text-[var(--text-3)]">
                      {q.paused ? <Pause size={13} /> : <Clock size={13} />}
                      {q.paused
                        ? `Paused · ${formatBytes(q.resumedBytes ?? 0)} done`
                        : q.resumedBytes
                          ? `Resuming · ${formatBytes(q.resumedBytes)} done`
                          : `Queued · #${i + 1}`}
                    </div>
                    {q.paused && (
                      <button onClick={() => resumePaused(q.id)} aria-label={`Resume ${q.item.name}`} className="text-[var(--text-3)] hover:text-[var(--accent)]">
                        <Play size={15} />
                      </button>
                    )}
                    <button onClick={() => removeQueued(q.id)} aria-label={`Remove ${q.item.name}`} className="text-[var(--text-3)] hover:text-[var(--error)]">
                      <X size={15} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {showHistory && (
          <div>
            {filter === "all" && <div className="mb-2 text-xs font-semibold tracking-wide text-[var(--text-3)]">HISTORY</div>}
            {histFiltered.length === 0 ? (
              <div className="py-10 text-sm text-[var(--text-2)]">No downloads yet.</div>
            ) : (
              <div className="flex flex-col">
                {histFiltered.map((h) => {
                  const ft = fileType(h.name, false);
                  const badge =
                    h.status === "success"
                      ? { Icon: Check, color: "var(--success)", label: "Completed" }
                      : h.status === "cancelled"
                        ? { Icon: Ban, color: "var(--text-3)", label: "Cancelled" }
                        : { Icon: AlertCircle, color: "var(--error)", label: "Failed" };
                  return (
                    <div key={h.jobId} className="flex items-center gap-3 border-b border-[var(--border)]/60 py-3">
                      <ft.Icon size={20} style={{ color: ft.color }} className="shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-[var(--text)]" title={h.name}>{h.name}</div>
                        {h.status === "failed" && h.error ? (
                          <div className="truncate text-xs text-[var(--error)]" title={h.error}>
                            {h.error}
                          </div>
                        ) : (
                          <div className="truncate text-xs text-[var(--text-3)]" title={h.dest}>
                            <AccountLabel accountId={h.accountId} /> · {h.dest}
                          </div>
                        )}
                      </div>
                      <span className="tnum w-24 shrink-0 text-right text-sm text-[var(--text-2)]">{formatBytes(h.size)}</span>
                      <span className="tnum w-40 shrink-0 text-right text-xs text-[var(--text-3)]">{new Date(h.at).toLocaleString()}</span>
                      {h.status === "failed" && h.item ? (
                        <button
                          onClick={() => {
                            enqueue(h.accountId, [h.item!], h.dest);
                            removeEntry(h.jobId);
                          }}
                          aria-label={`Resume ${h.name}`}
                          title="Resume from where it stopped"
                          className="flex w-28 shrink-0 items-center justify-end gap-1.5 text-xs text-[var(--accent)] hover:opacity-80"
                        >
                          <Play size={14} /> Resume
                        </button>
                      ) : (
                        <span className="flex w-28 shrink-0 items-center justify-end gap-1.5 text-xs" style={{ color: badge.color }}>
                          <badge.Icon size={14} /> {badge.label}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
