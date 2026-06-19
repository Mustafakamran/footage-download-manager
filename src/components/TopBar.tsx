import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Search, Settings as SettingsIcon, Bell, Minus, Square, X } from "lucide-react";
import { useApp } from "../store/app";
import { useSearch } from "../store/search";
import { useNotifications, unreadCount } from "../store/notifications";

const appWindow = getCurrentWindow();

export function TopBar() {
  const setView = useApp((s) => s.setView);
  const q = useSearch((s) => s.q);
  const setQ = useSearch((s) => s.set);
  const notifications = useNotifications((s) => s.items);
  const togglePanel = useNotifications((s) => s.togglePanel);
  const unread = unreadCount(notifications);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    appWindow.isMaximized().then(setMaximized).catch(() => {});
    const un = appWindow.onResized(() => appWindow.isMaximized().then(setMaximized).catch(() => {}));
    return () => {
      un.then((f) => f()).catch(() => {});
    };
  }, []);

  return (
    <header
      data-tauri-drag-region
      className="flex h-14 shrink-0 select-none items-center gap-3 bg-transparent pl-4 pr-2"
    >
      {/* Brand */}
      <button
        onClick={() => setView({ kind: "accounts" })}
        className="flex items-center gap-2.5"
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-[9px] bg-[var(--accent)] text-[var(--accent-ink)]">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 4v9m0 0 3.5-3.5M12 13 8.5 9.5M6 17.5h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="text-left leading-tight">
          <span className="block text-sm font-semibold tracking-tight text-[var(--text)]">Footage Download Manager</span>
          <span className="block text-[11px] text-[var(--text-3)]">FDM</span>
        </span>
      </button>

      {/* Search */}
      <div className="mx-auto flex w-full max-w-xl items-center gap-2 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-sm">
        <Search size={16} className="text-[var(--text-3)]" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search files and folders…"
          className="w-full bg-transparent text-[var(--text)] placeholder:text-[var(--text-3)] focus:outline-none"
        />
        {q && (
          <button onClick={() => setQ("")} aria-label="Clear search" className="text-[var(--text-3)] hover:text-[var(--text)]">
            <X size={14} />
          </button>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => togglePanel()}
          aria-label="Activity"
          className="relative flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          <Bell size={16} />
          {unread > 0 && (
            <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[10px] font-semibold text-[var(--accent-ink)]">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
        <button
          onClick={() => setView({ kind: "settings" })}
          aria-label="Settings"
          className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          <SettingsIcon size={16} />
        </button>

        <div className="ml-1 flex items-center gap-0.5">
          <button onClick={() => appWindow.minimize()} aria-label="Minimize" className="flex h-8 w-9 items-center justify-center rounded-[6px] text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]">
            <Minus size={15} />
          </button>
          <button onClick={() => appWindow.toggleMaximize()} aria-label={maximized ? "Restore" : "Maximize"} className="flex h-8 w-9 items-center justify-center rounded-[6px] text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]">
            <Square size={13} />
          </button>
          <button onClick={() => appWindow.close()} aria-label="Close" className="flex h-8 w-9 items-center justify-center rounded-[6px] text-[var(--text-2)] hover:bg-[var(--error)] hover:text-white">
            <X size={16} />
          </button>
        </div>
      </div>
    </header>
  );
}
