import { Download, X, Loader2, RefreshCw } from "lucide-react";
import { useUpdater } from "../store/updater";
import { formatBytes } from "../lib/format";

/** Slim banner shown when an OTA update is available / installing. */
export function UpdateBanner() {
  const { phase, version, downloaded, total, dismissed, install, dismiss } = useUpdater();

  if (phase === "available" && !dismissed) {
    return (
      <Bar>
        <Download size={15} className="shrink-0 text-[var(--accent)]" />
        <span className="text-sm text-[var(--text)]">
          Version <span className="font-semibold">{version}</span> is available.
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => void install()}
            className="rounded-[6px] bg-[var(--accent)] px-3 py-1 text-xs font-semibold text-[var(--accent-ink)] hover:bg-[var(--accent-hover)]"
          >
            Install &amp; restart
          </button>
          <button onClick={dismiss} aria-label="Dismiss" title="Dismiss" className="text-[var(--text-3)] hover:text-[var(--text)]">
            <X size={15} />
          </button>
        </div>
      </Bar>
    );
  }

  if (phase === "downloading") {
    const pct = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
    return (
      <Bar>
        <Loader2 size={15} className="shrink-0 animate-spin text-[var(--accent)]" />
        <span className="whitespace-nowrap text-sm text-[var(--text)]">Downloading update…</span>
        <div className="mx-1 h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--hover)]">
          <div className="h-full rounded-full bg-[var(--accent)] transition-[width]" style={{ width: `${pct}%` }} />
        </div>
        <span className="tnum shrink-0 text-xs text-[var(--text-3)]">
          {total > 0 ? `${formatBytes(downloaded)} / ${formatBytes(total)}` : formatBytes(downloaded)}
        </span>
      </Bar>
    );
  }

  if (phase === "ready") {
    return (
      <Bar>
        <RefreshCw size={15} className="shrink-0 text-[var(--accent)]" />
        <span className="text-sm text-[var(--text)]">Update installed — restarting…</span>
      </Bar>
    );
  }

  return null;
}

function Bar({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2">{children}</div>
  );
}
