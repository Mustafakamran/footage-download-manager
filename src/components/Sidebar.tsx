import { useEffect, useState } from "react";
import { Plus, FolderOpen, Clock, Star, Users, Download, Check, Pause, AlertCircle, Globe, Trash2, Loader2, Link as LinkIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useApp, type Section } from "../store/app";
import { useTransfers } from "../store/transfers";
import { useHistory } from "../store/history";
import { useStorage } from "../store/storage";
import { useAccountMeta, prettyLabel } from "../store/account-meta";
import { useIndex } from "../store/index-store";
import { ProviderIcon, providerName } from "./icons";
import { Skeleton } from "./ui";
import { AddAccountDialog } from "./AddAccountDialog";
import { AddLinkDialog } from "./AddLinkDialog";
import { formatBytes, formatSpeed } from "../lib/format";
import type { Provider } from "../lib/tauri/commands";

const SECTIONS: { key: Section; label: string; Icon: typeof FolderOpen }[] = [
  { key: "all", label: "All Files", Icon: FolderOpen },
  { key: "recent", label: "Recent", Icon: Clock },
  { key: "starred", label: "Starred", Icon: Star },
  { key: "shared", label: "Shared with me", Icon: Users },
];

export function Sidebar() {
  // Narrow + shallow-compared slice of the app store: `view` and `accounts` are
  // the only reactive fields the sidebar renders; the rest are stable actions.
  const { view, accounts, accountsLoaded, selectAccount, setSection, removeAccount, showDownloads } = useApp(
    useShallow((s) => ({
      view: s.view,
      accounts: s.accounts,
      accountsLoaded: s.accountsLoaded,
      selectAccount: s.selectAccount,
      setSection: s.setSection,
      removeAccount: s.removeAccount,
      showDownloads: s.showDownloads,
    })),
  );
  const dlFilter = view.kind === "downloads" ? view.filter : null;
  const jobs = useTransfers((s) => s.jobs);
  const queue = useTransfers((s) => s.queue);
  const history = useHistory((s) => s.items);
  const storage = useStorage((s) => s.byAccount);
  const fetchStorage = useStorage((s) => s.fetch);
  const meta = useAccountMeta((s) => s.byId);
  const indexEntries = useIndex((s) => s.byAccount);
  const emailErrors = useAccountMeta((s) => s.errors);
  const fetchEmail = useAccountMeta((s) => s.fetchEmail);
  const [addProvider, setAddProvider] = useState<Provider | null>(null);
  const [addLink, setAddLink] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  useEffect(() => {
    for (const a of accounts) {
      void fetchStorage(a);
      void fetchEmail(a.id);
    }
  }, [accounts, fetchStorage, fetchEmail]);

  const activeAccount = view.kind === "browse" ? view.accountId : null;
  const activeSection = view.kind === "browse" ? view.section : null;

  const active = jobs.filter((j) => !j.finished && !j.cancelled);
  // Completed/failed come from persisted history so the counts survive restarts;
  // "downloading" includes queued (non-paused) work waiting on a slot.
  const counts = {
    downloading: active.length + queue.filter((q) => !q.paused).length,
    completed: history.filter((h) => h.status === "success").length,
    paused: queue.filter((q) => q.paused).length,
    failed: history.filter((h) => h.status === "failed").length,
  };
  const totalSpeed = active.reduce((s, j) => s + Math.max(0, j.speed), 0);

  return (
    <aside className="flex w-64 shrink-0 flex-col overflow-hidden rounded-[12px] border border-[var(--border)] bg-[var(--surface)]">
      {/* Accounts header */}
      <div className="shrink-0 px-3 pt-4 pb-2">
        <div className="flex items-center justify-between px-1">
          <span className="text-[11px] font-semibold tracking-wide text-[var(--text-3)]">ACCOUNTS</span>
          <div className="relative">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              aria-label="Add account"
              title="Add account or shared link"
              className="flex h-5 w-5 items-center justify-center rounded-[5px] text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            >
              <Plus size={15} />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-6 z-20 w-40 overflow-hidden rounded-[8px] border border-[var(--border-strong)] bg-[var(--card)] py-1 shadow-[var(--shadow-lg)]">
                {(["drive", "dropbox"] as Provider[]).map((p) => (
                  <button
                    key={p}
                    onClick={() => {
                      setAddProvider(p);
                      setMenuOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                  >
                    <ProviderIcon provider={p} size={15} /> {providerName(p)}
                  </button>
                ))}
                <button
                  onClick={() => {
                    setAddLink(true);
                    setMenuOpen(false);
                  }}
                  className="flex w-full items-center gap-2 border-t border-[var(--border)] px-3 py-2 text-left text-sm text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                >
                  <LinkIcon size={15} /> Shared link
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Accounts list — scrolls when many accounts are connected */}
      <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto px-3">
        <div className="flex flex-col gap-1.5 pb-2">
          {!accountsLoaded && accounts.length === 0 ? (
            // Skeleton rows while the daemon boots and the first account list loads.
            Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="rounded-[10px] border border-transparent px-3 py-2.5">
                <div className="flex items-center gap-2.5">
                  <Skeleton className="h-5 w-5 rounded-full" />
                  <div className="min-w-0 flex-1">
                    <Skeleton className="mb-1.5 h-3.5 w-28" />
                    <Skeleton className="h-2.5 w-20" />
                  </div>
                </div>
              </div>
            ))
          ) : accountsLoaded && accounts.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-[var(--text-3)]">
              No accounts yet. Click <span className="text-[var(--text-2)]">+</span> above to connect Google Drive or Dropbox.
            </div>
          ) : null}
          {accounts.map((a) => {
            const st = storage[a.id];
            const isActive = activeAccount === a.id;
            return (
              <div
                key={a.id}
                className={`group relative cursor-pointer rounded-[10px] border px-3 py-2.5 ${
                  isActive ? "border-[var(--border-strong)] bg-[var(--hover)]" : "border-transparent hover:bg-[var(--hover)]"
                }`}
                onClick={() => selectAccount(a.id)}
              >
                {isActive && <span className="absolute left-0 top-2 h-[calc(100%-16px)] w-0.5 rounded-full bg-[var(--accent)]" />}
                <div className="flex items-center gap-2.5">
                  <ProviderIcon provider={a.provider} size={20} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-[var(--text)]">
                      {meta[a.id]?.label ?? prettyLabel(a.label)}
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-[var(--text-3)]">
                      <span className="truncate" title={meta[a.id]?.email}>
                        {meta[a.id]?.email ?? providerName(a.provider)}
                      </span>
                      {!meta[a.id]?.email && emailErrors[a.id] && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            void fetchEmail(a.id, true);
                          }}
                          title={emailErrors[a.id]}
                          aria-label="Email lookup failed — retry"
                          className="shrink-0 text-[var(--warning)] hover:text-[var(--text)]"
                        >
                          <AlertCircle size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                  <button
                    aria-label={`Remove ${a.label}`}
                    title={`Remove ${a.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmRemove(confirmRemove === a.id ? null : a.id);
                    }}
                    className="shrink-0 text-[var(--text-3)] opacity-60 hover:text-[var(--error)] hover:opacity-100"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                {st && st.total > 0 && (
                  <div className="mt-2">
                    <div className="tnum mb-1 text-[11px] text-[var(--text-3)]">
                      {formatBytes(st.used)} of {formatBytes(st.total)}
                    </div>
                    <div className="h-1 overflow-hidden rounded-full bg-[var(--border)]">
                      <div
                        className="h-full rounded-full bg-[var(--accent)]"
                        style={{ width: `${Math.min(100, Math.round((st.used / st.total) * 100))}%` }}
                      />
                    </div>
                  </div>
                )}
                {(() => {
                  const ie = indexEntries[a.id];
                  if (!ie || (ie.status !== "crawling" && ie.status !== "loading")) return null;
                  const { done, total, files } = ie.progress;
                  return (
                    <div className="mt-2">
                      <div className="tnum mb-1 flex items-center gap-1.5 text-[11px] text-[var(--accent)]">
                        <Loader2 size={11} className="animate-spin" />
                        Indexing {total > 0 ? `${done}/${total} folders` : "…"} · {files.toLocaleString()} files
                      </div>
                      <div className="h-1 overflow-hidden rounded-full bg-[var(--border)]">
                        <div
                          className="h-full rounded-full bg-[var(--accent)]"
                          style={{ width: total > 0 ? `${Math.round((done / total) * 100)}%` : "8%" }}
                        />
                      </div>
                    </div>
                  );
                })()}
                {confirmRemove === a.id && (
                  <div className="mt-2 flex items-center gap-2 text-xs">
                    <span className="text-[var(--text-2)]">Remove?</span>
                    <button
                      className="text-[var(--error)]"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeAccount(a.id);
                        setConfirmRemove(null);
                      }}
                    >
                      Confirm
                    </button>
                    <button className="text-[var(--text-3)]" onClick={(e) => { e.stopPropagation(); setConfirmRemove(null); }}>
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Library */}
      <div className="shrink-0 border-t border-[var(--border)] px-3 pt-3">
        <div className="mb-1 px-1 text-[11px] font-semibold tracking-wide text-[var(--text-3)]">LIBRARY</div>
        <div className="flex flex-col">
          {SECTIONS.map(({ key, label, Icon }) => {
            const on = activeAccount && activeSection === key;
            return (
              <button
                key={key}
                onClick={() => {
                  if (!activeAccount && accounts[0]) selectAccount(accounts[0].id);
                  setSection(key);
                }}
                className={`flex items-center gap-3 rounded-[8px] px-3 py-2 text-sm ${
                  on ? "bg-[var(--hover)] text-[var(--text)]" : "text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                }`}
              >
                <Icon size={16} /> {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Downloads */}
      <div className="shrink-0 px-3 pt-3">
        <div className="mb-1 flex items-center justify-between px-1">
          <span className="text-[11px] font-semibold tracking-wide text-[var(--text-3)]">DOWNLOADS</span>
          <button
            onClick={() => showDownloads("active")}
            aria-label="Download from a web link"
            title="Download a file from a URL"
            className="flex items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[11px] font-medium text-[var(--accent)] hover:bg-[var(--hover)]"
          >
            <Globe size={12} /> URL
          </button>
        </div>
        <div className="flex flex-col">
          <DownloadStat Icon={Download} label="Downloading" count={counts.downloading} accent onClick={() => showDownloads("active")} active={dlFilter === "active"} />
          <DownloadStat Icon={Check} label="Completed" count={counts.completed} onClick={() => showDownloads("completed")} active={dlFilter === "completed"} />
          <DownloadStat Icon={Pause} label="Paused" count={counts.paused} onClick={() => showDownloads("active")} active={false} />
          <DownloadStat Icon={AlertCircle} label="Failed" count={counts.failed} onClick={() => showDownloads("failed")} active={dlFilter === "failed"} />
        </div>
      </div>

      {/* Global speed */}
      <div className="mt-3 flex shrink-0 items-center gap-2.5 border-t border-[var(--border)] px-4 py-3">
        <Globe size={16} className="text-[var(--text-3)]" />
        <div>
          <div className="tnum text-sm text-[var(--text)]">{totalSpeed > 0 ? formatSpeed(totalSpeed) : "Idle"}</div>
          <div className="text-[11px] text-[var(--text-3)]">Unlimited</div>
        </div>
      </div>

      {addProvider && <AddAccountDialog provider={addProvider} onClose={() => setAddProvider(null)} />}
      {addLink && <AddLinkDialog onClose={() => setAddLink(false)} />}
    </aside>
  );
}

function DownloadStat({
  Icon,
  label,
  count,
  accent,
  onClick,
  active,
}: {
  Icon: typeof Download;
  label: string;
  count: number;
  accent?: boolean;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-3 rounded-[8px] px-3 py-2 text-sm ${
        active ? "bg-[var(--hover)] text-[var(--text)]" : "text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
      }`}
    >
      <Icon size={16} className={accent && count > 0 ? "text-[var(--accent)]" : ""} />
      <span className="flex-1 text-left">{label}</span>
      {count > 0 && (
        <span className="tnum rounded-full bg-[var(--hover)] px-2 py-0.5 text-[11px] text-[var(--text-2)]">{count}</span>
      )}
    </button>
  );
}
