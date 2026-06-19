import { X } from "lucide-react";
import { useApp } from "../store/app";
import { useTransfers } from "../store/transfers";
import { ProviderIcon } from "./icons";
import { TitleBar } from "./TitleBar";
import { AccountsView } from "./AccountsView";
import { SettingsView } from "./SettingsView";
import { ProfileView } from "./ProfileView";
import { TransfersDock } from "./TransfersDock";
import { ToastHost } from "./ToastHost";
import { NotificationsPanel } from "./NotificationsPanel";
import { formatSpeed } from "../lib/format";

export function AppShell() {
  const { view, accounts, openTabs, openProfile, closeTab } = useApp();
  const jobs = useTransfers((s) => s.jobs);
  const activeJobs = jobs.filter((j) => !j.finished && !j.cancelled);
  const totalSpeed = activeJobs.reduce((sum, j) => sum + Math.max(0, j.speed), 0);

  return (
    <div className="flex h-full flex-col bg-[var(--bg)]">
      <TitleBar />
      <ToastHost />
      <NotificationsPanel />

      {/* Profile tabs */}
      {openTabs.length > 0 && (
        <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--surface)] px-2">
          {openTabs.map((id) => {
            const acc = accounts.find((a) => a.id === id);
            if (!acc) return null;
            const active = view.kind === "profile" && view.id === id;
            return (
              <div
                key={id}
                className={`group flex items-center gap-2 rounded-t-[6px] px-3 py-1.5 text-sm ${
                  active
                    ? "border-b-2 border-[var(--accent)] bg-[var(--bg)] text-[var(--text)]"
                    : "text-[var(--text-2)] hover:bg-[var(--hover)]"
                }`}
              >
                <button className="flex items-center gap-2" onClick={() => openProfile(id)}>
                  <ProviderIcon provider={acc.provider} size={14} />
                  <span className="max-w-[140px] truncate">{acc.label}</span>
                </button>
                <button
                  className="text-[var(--text-3)] hover:text-[var(--text)]"
                  onClick={() => closeTab(id)}
                  aria-label={`Close ${acc.label}`}
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Content + transfers dock */}
      <div className="flex min-h-0 flex-1">
        <main className="relative min-h-0 flex-1">
          {view.kind === "accounts" && (
            <div className="animate-rise h-full overflow-auto">
              <AccountsView />
            </div>
          )}
          {view.kind === "settings" && (
            <div className="animate-rise h-full overflow-auto">
              <SettingsView />
            </div>
          )}
          {/* Profile tabs stay mounted; we just show/hide them so switching is
              instant (no remount, no re-fetch, scroll + path preserved). */}
          {openTabs.map((id) => (
            <div key={id} className={view.kind === "profile" && view.id === id ? "h-full" : "hidden"}>
              <ProfileView id={id} />
            </div>
          ))}
        </main>
        <TransfersDock />
      </div>

      {/* Status bar */}
      <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-[var(--border)] bg-[var(--surface)] px-3 text-xs text-[var(--text-3)]">
        <span>
          <span className="tnum text-[var(--text-2)]">{activeJobs.length}</span> active
        </span>
        <span>
          ↓ <span className="tnum text-[var(--text-2)]">{formatSpeed(totalSpeed)}</span>
        </span>
        <span className="ml-auto">
          {accounts.length} account{accounts.length === 1 ? "" : "s"}
        </span>
      </footer>
    </div>
  );
}
