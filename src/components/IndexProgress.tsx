import { Loader2, X } from "lucide-react";
import { useIndex, type IndexEntry } from "../store/index-store";
import { formatBytes } from "../lib/format";

/** YYYY-MM-DD from an ISO modTime; "" for missing/placeholder dates. */
export function shortDay(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  // rclone emits a year-0001/2000 placeholder when a backend has no modTime.
  if (Number.isNaN(d.getTime()) || d.getTime() < Date.UTC(2001, 0, 1)) return "";
  return d.toISOString().slice(0, 10);
}

/** Compact "YYYY-MM-DD → YYYY-MM-DD" range; collapses to a single day, "" when empty. */
export function dateRange(min: string, max: string): string {
  const a = shortDay(min);
  const b = shortDay(max);
  if (!a && !b) return "";
  if (!a) return b;
  if (!b) return a;
  return a === b ? a : `${a} → ${b}`;
}

/**
 * Compact one-line crawl indicator for an account/folder being indexed.
 * Shows folders done/total · file count · cumulative bytes · date range,
 * with a Cancel button wired to the store.
 */
export function IndexProgress({ accountId, entry }: { accountId: string; entry: IndexEntry }) {
  const cancel = useIndex((s) => s.cancel);
  const p = entry.progress;
  const bytes = p.bytes ?? 0;
  const range = dateRange(p.dateMin ?? "", p.dateMax ?? "");

  return (
    <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-5 py-2.5 text-sm text-[var(--text-2)]">
      <Loader2 size={15} className="shrink-0 animate-spin text-[var(--accent)]" />
      <span className="min-w-0 flex-1 truncate whitespace-nowrap">
        Indexing…{" "}
        <span className="tnum text-[var(--text)]">
          {p.done.toLocaleString()}/{p.total.toLocaleString()}
        </span>{" "}
        folders · <span className="tnum text-[var(--text)]">{p.files.toLocaleString()}</span> files
        {bytes > 0 && (
          <>
            {" "}
            · <span className="tnum">{formatBytes(bytes)}</span>
          </>
        )}
        {range && (
          <>
            {" "}
            · <span className="tnum">{range}</span>
          </>
        )}
      </span>

      <div className="h-1.5 w-32 shrink-0 overflow-hidden rounded-full bg-[var(--hover)]">
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-[width]"
          style={{ width: p.total ? `${Math.round((p.done / p.total) * 100)}%` : "8%" }}
        />
      </div>

      <button
        onClick={() => void cancel(accountId)}
        title="Cancel indexing"
        aria-label="Cancel indexing"
        className="shrink-0 rounded-[7px] border border-[var(--border)] p-1 text-[var(--text-3)] hover:text-[var(--text)]"
      >
        <X size={14} />
      </button>
    </div>
  );
}
