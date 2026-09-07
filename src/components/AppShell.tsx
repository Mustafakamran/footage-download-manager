import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "../store/app";
import { useSearch } from "../store/search";
import { TopBar } from "./TopBar";
import { Sidebar } from "./Sidebar";
import { BrowsePane } from "./BrowsePane";
import { ReviewView } from "./ReviewView";
import { TransfersView } from "./TransfersView";
import { Dashboard } from "./Dashboard";
import { ConnectView } from "./ConnectView";
import { DownloadsDock } from "./DownloadsDock";
import { IndexBanner } from "./IndexBanner";
import { ToastHost } from "./ToastHost";
import { NotificationsPanel } from "./NotificationsPanel";
import { SettingsDialog } from "./SettingsDialog";
import { PreviewOverlay } from "./PreviewOverlay";
import { NewFoldersView } from "./NewFoldersView";
import { SharedDrivesView } from "./SharedDrivesView";
import { SharedDriveDock } from "./SharedDriveDock";
import { UpdateBanner } from "./UpdateBanner";
import { TooltipLayer } from "./ui/Tooltip";

export function AppShell() {
  const { view, accounts } = useApp(useShallow((s) => ({ view: s.view, accounts: s.accounts })));
  const browseAccount = view.kind === "browse" ? accounts.find((a) => a.id === view.accountId) : undefined;
  const goBack = useApp((s) => s.goBack);
  const goForward = useApp((s) => s.goForward);

  // Global Back/Forward: Alt+←/→ and the mouse back/forward buttons (button 3/4),
  // so navigation history works everywhere — matching a native file browser.
  useEffect(() => {
    const isEditable = (el: EventTarget | null) =>
      el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    // Back while a search is active dismisses the search overlay first (it sits
    // OVER the current view), so Back never silently changes a hidden view.
    const back = () => {
      if (useSearch.getState().q.trim()) {
        useSearch.getState().set("");
        return;
      }
      goBack();
    };
    const forward = () => {
      if (useSearch.getState().q.trim()) return; // Forward is meaningless while searching
      goForward();
    };
    const onKey = (e: KeyboardEvent) => {
      // Don't hijack Option/Alt+← word-navigation inside text fields.
      if (isEditable(e.target)) return;
      if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        back();
      } else if (e.altKey && e.key === "ArrowRight") {
        e.preventDefault();
        forward();
      }
    };
    // Suppress the WebView's own history navigation on the mouse back/forward
    // buttons (some engines start it on mousedown) so it can't double up with
    // our handler; run our action on mouseup.
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) e.preventDefault();
    };
    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault();
        back();
      } else if (e.button === 4) {
        e.preventDefault();
        forward();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [goBack, goForward]);

  return (
    <div
      className="flex h-screen flex-col overflow-hidden rounded-[var(--window-radius)] border border-[var(--border)]"
      style={{ background: "var(--win)" }}
    >
      <TopBar />
      <UpdateBanner />
      <ToastHost />
      <NotificationsPanel />
      <SettingsDialog />
      <PreviewOverlay />
      <TooltipLayer />

      <div className="flex min-h-0 flex-1 gap-2.5 px-2.5 pb-2.5">
        <Sidebar />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5">
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-[12px] border border-[var(--border)] bg-[var(--surface)]">
            {/* Search is now an anchored dropdown in the TopBar (not a full-page
                takeover), so the normal view always renders underneath it. */}
            {view.kind === "home" && <Dashboard />}
            {view.kind === "new-folders" && <NewFoldersView />}
            {view.kind === "shared" && <SharedDrivesView />}
            {view.kind === "accounts" && <ConnectView />}
            {view.kind === "transfers" && <TransfersView filter={view.filter} />}
            {view.kind === "review" && <ReviewView accountId={view.accountId} target={view.target} />}
            {view.kind === "browse" &&
              (browseAccount ? (
                <BrowsePane account={browseAccount} section={view.section} path={view.path} />
              ) : (
                <ConnectView />
              ))}
            {/* App-wide Shared Drive dock (tab rail + slide-over) — lives in the
                content shell so it never covers the top bar / search. */}
            <SharedDriveDock />
          </div>
          {/* The Transfers screen shows its own progress table, so the dock would
              duplicate it there — only float it over other screens. */}
          {view.kind !== "transfers" && <DownloadsDock />}
          {/* Indexing status floats bottom-left, everywhere. */}
          <IndexBanner />
        </div>
      </div>
    </div>
  );
}
