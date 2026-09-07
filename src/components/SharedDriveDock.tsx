import { useEffect, useRef, useState } from "react";
import { X, Download, Loader2, HardDrive, ChevronsRight } from "lucide-react";
import { useBrowse } from "../store/browse";
import { useTransfers } from "../store/transfers";
import { useDriveTabs } from "../store/drive-tabs";
import { pickDownloadDest } from "../lib/ingest";
import { getOrCreateTeamDriveLink, type Account } from "../lib/tauri/commands";
import { BrowsePane } from "./BrowsePane";

/**
 * App-wide dock for browsing Shared Drives without leaving the current screen.
 * Rendered inside the content shell (below the top bar, right of the sidebar) so
 * it never covers the search / window controls. A vertical, Chrome-style tab rail
 * on the right holds every open drive; the active one shows in a slide-over that
 * embeds the FULL file browser. Clicking outside minimizes (keeps the tab) — the
 * rail persists across every screen until a tab is explicitly closed.
 */
export function SharedDriveDock() {
  const tabs = useDriveTabs((s) => s.tabs);
  const activeId = useDriveTabs((s) => s.activeId);
  const focus = useDriveTabs((s) => s.focus);
  const minimize = useDriveTabs((s) => s.minimize);
  const close = useDriveTabs((s) => s.close);
  const setNav = useDriveTabs((s) => s.setNav);

  const active = tabs.find((t) => t.id === activeId) ?? null;

  // Resolve (and cache) the teamdrive link account per tab. Creating it is the
  // one slow step, so we only do it once per drive and keep the result.
  const [links, setLinks] = useState<Record<string, Account>>({});
  const resolving = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!active || links[active.id] || resolving.current.has(active.id)) return;
    resolving.current.add(active.id);
    getOrCreateTeamDriveLink(active.base.id, active.drive.name, active.drive.id)
      .then((acct) => { setLinks((m) => ({ ...m, [active.id]: acct })); void useBrowse.getState().ensure(acct, ""); })
      .catch(() => {})
      .finally(() => resolving.current.delete(active.id));
  }, [active, links]);

  if (tabs.length === 0) return null;

  const linked = active ? links[active.id] : undefined;
  const downloadDrive = async () => {
    if (!linked || !active) return;
    const dest = await pickDownloadDest();
    if (!dest) return;
    useTransfers.getState().enqueue(linked.id, [{ path: "", name: active.drive.name, isDir: true, size: 0, id: "" }], dest);
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-40">
      {/* Invisible click-catcher — clicking outside minimizes (no dim overlay). */}
      {active && <div className="pointer-events-auto absolute inset-0" onClick={minimize} />}

      {/* Drawer + bookmark rail, anchored to the right edge. */}
      {/* Drawer flush to the right edge (no reserved rail column). The bookmark
          tabs hang off its LEFT edge, so they move with it: drawer visible →
          tabs sit just left of it in the content; minimized → the drawer slides
          fully off-right and the tabs land back at the right edge. */}
      <div
        className="pointer-events-auto absolute right-0 top-0 flex h-full w-[920px] max-w-[calc(100vw-96px)] flex-col border-l border-[var(--line)] bg-[var(--card)] transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
        style={{ transform: active ? "translateX(0)" : "translateX(100%)" }}
      >
        {/* Slim vertical bookmark tabs, protruding from the drawer's left edge.
            The active tab shares the drawer's card background (+1px overhang on
            its right) so it reads as part of the drawer, not a floating chip. */}
        <div className="pointer-events-auto absolute left-0 top-3 flex -translate-x-full flex-col gap-1.5">
          {tabs.map((t) => {
            const on = t.id === activeId;
            return (
              <div
                key={t.id}
                role="button"
                tabIndex={0}
                onClick={() => (on ? minimize() : focus(t.id))}
                data-tip={on ? "Minimize" : t.drive.name}
                className={`group relative flex w-[40px] cursor-pointer flex-col items-center gap-1.5 rounded-l-[11px] border border-r-0 py-2.5 transition-colors ${
                  on
                    ? "border-[var(--acc)] bg-[var(--acc)] text-[var(--onacc)] shadow-[-6px_0_16px_-8px_rgba(0,0,0,0.25)]"
                    : "border-[var(--line)] bg-[var(--card)]/95 text-[var(--mut)] shadow-[var(--shadow)] hover:bg-[var(--soft)] hover:text-[var(--ink)]"
                }`}
              >
                <button
                  onClick={(e) => { e.stopPropagation(); close(t.id); }}
                  data-tip="Close tab"
                  aria-label={`Close ${t.drive.name}`}
                  className="absolute -top-2 left-1/2 flex h-5 w-5 -translate-x-1/2 items-center justify-center rounded-full border border-[var(--line)] bg-[var(--card)] text-[var(--faint)] opacity-0 shadow-[var(--shadow)] transition hover:text-[var(--err)] group-hover:opacity-100"
                >
                  <X size={11} />
                </button>
                <HardDrive size={15} className="shrink-0" />
                <span
                  className="max-h-[112px] overflow-hidden text-ellipsis whitespace-nowrap text-[10.5px] font-semibold tracking-tight"
                  style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
                >
                  {t.drive.name}
                </span>
              </div>
            );
          })}
        </div>

        {active && (
            <>
              {/* Slim control bar — the drive name/icon already show in the tab and
                  the browser's breadcrumb below, so don't repeat them here. */}
              <div className="flex items-center justify-end gap-1.5 border-b border-[var(--line)] px-3 py-1.5">
                <button onClick={() => void downloadDrive()} disabled={!linked} className="flex items-center gap-1.5 rounded-[9px] border border-[var(--line)] px-2.5 py-1.5 text-[12px] font-semibold text-[var(--mut)] hover:border-[var(--line2)] hover:text-[var(--ink)] disabled:opacity-40" data-tip="Download the whole drive">
                  <Download size={13} /> Drive
                </button>
                <button onClick={minimize} data-tip="Minimize to tab" aria-label="Minimize" className="flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--faint)] hover:bg-[var(--soft)] hover:text-[var(--ink)]">
                  <ChevronsRight size={16} />
                </button>
                <button onClick={() => close(active.id)} data-tip="Close tab" aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--faint)] hover:bg-[var(--soft)] hover:text-[var(--ink)]">
                  <X size={16} />
                </button>
              </div>
              <div className="min-h-0 flex-1">
                {linked ? (
                  <BrowsePane
                    key={active.id}
                    account={linked}
                    section={active.section}
                    path={active.path}
                    onNavigate={(sec, p) => setNav(active.id, sec, p)}
                  />
                ) : (
                  <div className="flex items-center justify-center gap-2 py-16 text-[12.5px] text-[var(--faint)]">
                    <Loader2 size={15} className="animate-spin" /> Opening Shared Drive…
                  </div>
                )}
              </div>
            </>
          )}
      </div>
    </div>
  );
}
