import { useMemo, useState } from "react";
import { FolderPlus, Folder, Loader2, ChevronRight, ChevronDown, Download, Pause, Check, HardDrive, Link2, CheckCheck, X, Clock, ArrowDownAZ, ArrowDownWideNarrow, Users, FlaskConical } from "lucide-react";
import { useApp } from "../store/app";
import { useAccountMeta, accountLabel } from "../store/account-meta";
import { useNewFolders } from "../lib/use-new-folders";
import { formatBytes, formatDate, formatDateTime } from "../lib/format";
import { ProviderIcon } from "./icons";
import { EmptyState } from "./ui";
import { ContextMenu, type MenuItem } from "./ui/ContextMenu";
import { StatusBadge } from "./ui/StatusBadge";
import { SharePopover } from "./SharePopover";
import { useFolderStatus, FOLDER_STATUS_META, FOLDER_STATUS_ORDER } from "../store/folder-status";
import { useVisited } from "../store/visited";
import { useNewFoldersBaseline } from "../store/new-folders";
import { isSharedLink } from "../lib/lane";
import { makeMockNewFolders, type MockNewFolders } from "../lib/dev-mock-folders";
import type { SizeValue } from "../store/browse";
import type { Account } from "../lib/tauri/commands";
import type { RcItem } from "../lib/rc/browse";
import type { NewFolderGroup } from "../lib/use-new-folders";

const STATUS_ICON = { downloading: Download, on_hold: Pause, downloaded: Check, copied: HardDrive } as const;

type SortMode = "recent" | "name" | "size";
const SORTS: { key: SortMode; label: string; icon: typeof Clock }[] = [
  { key: "recent", label: "Recent", icon: Clock },
  { key: "name", label: "Name", icon: ArrowDownAZ },
  { key: "size", label: "Size", icon: ArrowDownWideNarrow },
];

/**
 * "New folders" — top-level folders a client has added to any connected drive
 * since it was last seen, that you haven't downloaded yet. Click jumps to the
 * folder in the browser; right-click sets a workflow status (Downloading / On
 * hold / Downloaded / Copied).
 */
export function NewFoldersView() {
  const setView = useApp((s) => s.setView);
  const meta = useAccountMeta((s) => s.byId);
  const { groups, sizeOf, seenAtOf, markAllRead, acknowledgeAll } = useNewFolders();
  const statusByAccount = useFolderStatus((s) => s.byAccount);
  const setFolderStatus = useFolderStatus((s) => s.set);
  const visitedByAccount = useVisited((s) => s.byAccount);
  const [menu, setMenu] = useState<{ x: number; y: number; account: Account; folder: RcItem } | null>(null);
  const [share, setShare] = useState<{ account: Account; item: RcItem; anchor: { x: number; y: number } } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [sort, setSort] = useState<SortMode>("recent");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  // DEV-only sample data (import.meta.env.DEV) so the screen can be reviewed with
  // no live new folders. Held in state + a local "opened" map so Clear / Remove /
  // Mark-read visibly mutate the mock exactly like the real pipeline.
  const [mock, setMock] = useState<MockNewFolders | null>(null);
  const [mockGroups, setMockGroups] = useState<NewFolderGroup[]>([]);
  const [mockOpened, setMockOpened] = useState<Record<string, string[]>>({});
  const mockOn = mock !== null;
  const loadMock = () => { const m = makeMockNewFolders(); setMock(m); setMockGroups(m.groups); setMockOpened(m.openedPaths); };
  const unloadMock = () => { setMock(null); setMockGroups([]); setMockOpened({}); };

  // Effective data source — real pipeline, or the mock when it's loaded.
  const eGroups = mockOn ? mockGroups : groups;
  const eSizeOf = mockOn ? mock!.sizeOf : sizeOf;
  const eSeenAtOf = mockOn ? mock!.seenAtOf : seenAtOf;
  const openedOf = (id: string) => (mockOn ? mockOpened[id] ?? [] : visitedByAccount[id] ?? []);

  const listedCount = eGroups.reduce((n, g) => n + g.folders.length, 0);
  const count = eGroups.reduce((n, g) => { const seen = new Set(openedOf(g.account.id)); return n + g.folders.filter((f) => !seen.has(f.Path)).length; }, 0);
  const totalSize = eGroups.reduce((sum, g) => { for (const f of g.folders) { const s = eSizeOf(g.account.id, f.Path); if (typeof s === "number") sum += s; } return sum; }, 0);
  const allSized = eGroups.every((g) => g.folders.every((f) => typeof eSizeOf(g.account.id, f.Path) === "number"));
  // Split owned drives from shared/linked ones so they don't intermix in one list.
  const owned = eGroups.filter((g) => !isSharedLink(g.account.id));
  const shared = eGroups.filter((g) => isSharedLink(g.account.id));

  // Order folders within a drive by the chosen key (unknown sizes sink last).
  const sortFolders = useMemo(() => {
    return (accountId: string, folders: RcItem[]): RcItem[] => {
      const arr = [...folders];
      if (sort === "name") arr.sort((a, b) => a.Name.localeCompare(b.Name));
      else if (sort === "size") {
        const val = (f: RcItem) => { const s = eSizeOf(accountId, f.Path); return typeof s === "number" ? s : -1; };
        arr.sort((a, b) => val(b) - val(a));
      } else {
        const val = (f: RcItem) => eSeenAtOf(accountId, f.Path) ?? (Date.parse(f.ModTime) || 0);
        arr.sort((a, b) => val(b) - val(a));
      }
      return arr;
    };
  }, [sort, eSizeOf, eSeenAtOf]);

  const driveUnread = (g: NewFolderGroup) => {
    const seen = new Set(openedOf(g.account.id));
    return g.folders.filter((f) => !seen.has(f.Path)).length;
  };
  const driveSize = (g: NewFolderGroup) => {
    let sum = 0, exact = true;
    for (const f of g.folders) { const s = eSizeOf(g.account.id, f.Path); if (typeof s === "number") sum += s; else exact = false; }
    return { sum, exact };
  };

  const markDriveRead = (g: NewFolderGroup) => {
    if (mockOn) setMockOpened((p) => ({ ...p, [g.account.id]: [...new Set([...(p[g.account.id] ?? []), ...g.folders.map((f) => f.Path)])] }));
    else useVisited.getState().markManyVisited(g.account.id, g.folders.map((f) => f.Path));
  };
  const clearDrive = (g: NewFolderGroup) => {
    if (mockOn) setMockGroups((prev) => prev.filter((x) => x.account.id !== g.account.id));
    else useNewFoldersBaseline.getState().acknowledge(g.account.id, g.folders.map((f) => f.Path));
  };
  const removeFolder = (accountId: string, path: string) => {
    if (mockOn) setMockGroups((prev) => prev.map((g) => (g.account.id === accountId ? { ...g, folders: g.folders.filter((f) => f.Path !== path) } : g)).filter((g) => g.folders.length > 0));
    else useNewFoldersBaseline.getState().acknowledge(accountId, [path]);
  };
  const doMarkAllRead = () => {
    if (mockOn) setMockOpened(() => Object.fromEntries(mockGroups.map((g) => [g.account.id, g.folders.map((f) => f.Path)])));
    else markAllRead();
  };
  const doClearAll = () => {
    if (mockOn) setMockGroups([]);
    else acknowledgeAll();
  };
  const toggleCollapse = (id: string) => setCollapsed((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const menuItems = (account: Account, folder: RcItem): MenuItem[] => {
    const cur = statusByAccount[account.id]?.[folder.Path];
    const items: MenuItem[] = FOLDER_STATUS_ORDER.map((st, i) => ({
      label: cur === st ? `${FOLDER_STATUS_META[st].label} ✓` : `Mark ${FOLDER_STATUS_META[st].label}`,
      icon: STATUS_ICON[st],
      separator: i === 0,
      onClick: () => setFolderStatus(account.id, folder.Path, cur === st ? null : st),
    }));
    items.push({ label: "Copy link", icon: Link2, separator: true, onClick: () => setShare({ account, item: folder, anchor: { x: menu?.x ?? window.innerWidth / 2, y: menu?.y ?? window.innerHeight / 2 } }) });
    items.push({ label: "Remove from recents", icon: X, onClick: () => removeFolder(account.id, folder.Path) });
    return items;
  };

  const renderDrive = (g: NewFolderGroup) => {
    const isCollapsed = collapsed.has(g.account.id);
    const unread = driveUnread(g);
    const { sum, exact } = driveSize(g);
    return (
      <div key={g.account.id} className="overflow-hidden rounded-[13px] border border-[var(--line)]">
        {/* Drive header — click to collapse; hover reveals per-drive actions. */}
        <div className="group/head flex items-center gap-2 bg-[var(--soft)] px-3 py-2">
          <button onClick={() => toggleCollapse(g.account.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left" data-tip={isCollapsed ? "Expand" : "Collapse"}>
            {isCollapsed ? <ChevronRight size={15} className="shrink-0 text-[var(--faint)]" /> : <ChevronDown size={15} className="shrink-0 text-[var(--faint)]" />}
            <ProviderIcon provider={g.account.provider} size={14} />
            <span className="truncate text-[12.5px] font-semibold text-[var(--ink)]">{accountLabel(meta[g.account.id]?.label, g.account)}</span>
            <span className="tnum shrink-0 rounded-full bg-[var(--card)] px-1.5 text-[11px] font-semibold text-[var(--mut)]">{g.folders.length}</span>
            {unread > 0 && <span className="tnum shrink-0 rounded-full bg-[var(--acc)] px-1.5 text-[11px] font-semibold text-[var(--onacc)]">{unread} new</span>}
            <span className="tnum shrink-0 text-[11px] text-[var(--faint)]">{formatBytes(sum)}{!exact && "+"}</span>
          </button>
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/head:opacity-100">
            {unread > 0 && <MiniBtn icon={Check} title="Mark this drive read" onClick={() => markDriveRead(g)} />}
            <MiniBtn icon={X} title="Clear this drive" onClick={() => clearDrive(g)} />
          </div>
        </div>
        {!isCollapsed && (
          <div>
            {sortFolders(g.account.id, g.folders).map((f) => {
              const status = statusByAccount[g.account.id]?.[f.Path];
              const opened = openedOf(g.account.id).includes(f.Path);
              const seen = eSeenAtOf(g.account.id, f.Path);
              return (
                <div
                  key={f.Path}
                  role="button"
                  tabIndex={0}
                  onClick={() => { if (!mockOn) setView({ kind: "browse", accountId: g.account.id, section: "all", path: f.Path }); }}
                  onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, account: g.account, folder: f }); }}
                  className={`group flex w-full cursor-pointer items-center gap-3 border-t border-[var(--line)] bg-[var(--card)] px-4 py-3 text-left transition-colors hover:bg-[var(--hover)] ${opened ? "opacity-60" : ""}`}
                >
                  <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[11px] bg-[var(--accw)]">
                    <Folder size={18} className="text-[var(--acc)]" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="select-text truncate text-[13.5px] font-medium text-[var(--ink)]">{f.Name}</span>
                      {status && <StatusBadge status={status} />}
                    </span>
                    <span className="block truncate text-[11.5px] text-[var(--faint)]">
                      {seen ? `Identified ${formatDateTime(seen)}` : `Added ${formatDate(f.ModTime)}`}{opened ? " · opened" : ""}
                    </span>
                  </span>
                  <SizeLabel size={eSizeOf(g.account.id, f.Path)} />
                  <MiniBtn icon={X} title="Remove from recents" className="opacity-0 group-hover:opacity-100" onClick={(e) => { e?.stopPropagation(); removeFolder(g.account.id, f.Path); }} />
                  <ChevronRight size={16} className="shrink-0 text-[var(--faint)] opacity-0 transition-opacity group-hover:opacity-100" />
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="h-full overflow-auto px-8 py-7">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-[26px] font-bold tracking-[-0.025em] text-[var(--ink)]">
            <FolderPlus size={22} className="text-[var(--acc)]" /> Recently added
          </h1>
          <p className="mt-1 text-[13.5px] text-[var(--mut)]">
            {listedCount > 0 ? (
              <>
                <span className="font-semibold text-[var(--ink)]">{listedCount}</span> folder{listedCount === 1 ? "" : "s"}
                {count > 0 && <> · <span className="font-semibold text-[var(--acc)]">{count} new</span></>} ·{" "}
                <span className="tnum">{formatBytes(totalSize)}</span>{!allSized && <span className="text-[var(--faint)]">+</span>} total
              </>
            ) : (
              `Top-level folders a client has added to your drives, that you haven't downloaded yet, show up here.`
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {import.meta.env.DEV && (
            <button
              onClick={() => (mockOn ? unloadMock() : loadMock())}
              className={`flex items-center gap-1.5 rounded-[9px] border px-3 py-1.5 text-[12.5px] font-semibold ${mockOn ? "border-[var(--warn)] text-[var(--warn)]" : "border-dashed border-[var(--line2)] text-[var(--faint)] hover:text-[var(--ink)]"}`}
              data-tip="Dev only: toggle sample data"
            >
              <FlaskConical size={14} /> {mockOn ? "Sample on" : "Sample data"}
            </button>
          )}
          {listedCount > 0 && count > 0 && (
            <button
              onClick={() => doMarkAllRead()}
              className="flex items-center gap-1.5 rounded-[9px] border border-[var(--line)] bg-[var(--card)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--mut)] hover:border-[var(--line2)] hover:text-[var(--ink)]"
              data-tip="Clear the new badges but keep folders listed"
            >
              <Check size={14} /> Mark all read
            </button>
          )}
          {listedCount > 0 && (
            <button
              onClick={() => setConfirmClear(true)}
              className="flex items-center gap-1.5 rounded-[9px] border border-[var(--line)] bg-[var(--card)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--mut)] hover:border-[var(--line2)] hover:text-[var(--ink)]"
              data-tip="Remove every folder from this list"
            >
              <CheckCheck size={14} /> Clear recents
            </button>
          )}
        </div>
      </div>

      {listedCount === 0 ? (
        <EmptyState
          icon={<FolderPlus size={20} />}
          title="No new folders"
          body={`When a client adds a folder to one of your drives, it appears here so you know what still needs downloading. Right-click a folder to mark it Downloading / On hold / Downloaded / Copied. Folders you've already downloaded are hidden.`}
        />
      ) : (
        <>
          {/* Sort control */}
          <div className="mb-4 flex items-center gap-2">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--faint)]">Sort</span>
            <div className="flex items-center gap-0.5 rounded-[9px] border border-[var(--line)] bg-[var(--card)] p-0.5">
              {SORTS.map((s) => {
                const on = sort === s.key;
                return (
                  <button
                    key={s.key}
                    onClick={() => setSort(s.key)}
                    className={`flex items-center gap-1.5 rounded-[7px] px-2.5 py-1 text-[12px] font-semibold ${on ? "bg-[var(--acc)] text-[var(--onacc)]" : "text-[var(--mut)] hover:text-[var(--ink)]"}`}
                  >
                    <s.icon size={13} /> {s.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-6">
            {owned.length > 0 && (
              <Section label={shared.length > 0 ? "Your drives" : undefined} icon={HardDrive}>
                {owned.map(renderDrive)}
              </Section>
            )}
            {shared.length > 0 && (
              <Section label="Shared with me" icon={Users}>
                {shared.map(renderDrive)}
              </Section>
            )}
          </div>
        </>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.account, menu.folder)} onClose={() => setMenu(null)} />}
      {share && <SharePopover account={share.account} item={share.item} anchor={share.anchor} onClose={() => setShare(null)} />}

      {confirmClear && (
        <div className="fixed inset-0 z-[160] flex items-center justify-center bg-black/40 p-4" onMouseDown={() => setConfirmClear(false)}>
          <div className="animate-pop w-[420px] max-w-full rounded-[14px] border border-[var(--line)] bg-[var(--card)] p-5 shadow-[var(--shadow-lg)]" onMouseDown={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <CheckCheck size={16} className="text-[var(--acc)]" />
              <h2 className="text-[15px] font-semibold text-[var(--ink)]">Clear recents</h2>
            </div>
            <p className="mt-2 text-[12.5px] text-[var(--faint)]">
              Remove all <span className="font-semibold text-[var(--ink)]">{listedCount}</span> folder{listedCount === 1 ? "" : "s"} from this list? They’ll no longer show as new. Folders added later will still appear. To just clear the badge, use “Mark all read” instead.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConfirmClear(false)} className="rounded-[9px] px-3 py-2 text-[13px] font-medium text-[var(--faint)] hover:text-[var(--ink)]">Cancel</button>
              <button
                onClick={() => { doClearAll(); setConfirmClear(false); }}
                className="rounded-[9px] border border-[var(--acc)] bg-[var(--acc)] px-3 py-2 text-[13px] font-semibold text-[var(--onacc)] hover:opacity-90"
              >
                Clear recents
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** A labelled group of drive cards ("Your drives" / "Shared with me"). */
function Section({ label, icon: Icon, children }: { label?: string; icon: typeof HardDrive; children: React.ReactNode }) {
  return (
    <div>
      {label && (
        <div className="mb-2 flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--faint)]">
          <Icon size={12} /> {label}
        </div>
      )}
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

/** Compact icon button for row/drive-header actions. */
function MiniBtn({ icon: Icon, title, onClick, className = "" }: { icon: typeof Check; title: string; onClick: (e?: React.MouseEvent) => void; className?: string }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
      data-tip={title}
      aria-label={title}
      className={`flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[8px] text-[var(--faint)] transition-colors hover:bg-[var(--soft)] hover:text-[var(--ink)] ${className}`}
    >
      <Icon size={14} />
    </button>
  );
}

function SizeLabel({ size }: { size: SizeValue | undefined }) {
  if (typeof size === "number") return <span className="tnum shrink-0 text-[12.5px] text-[var(--text-2)]">{formatBytes(size)}</span>;
  if (size === "error") return <span className="shrink-0 text-[12px] text-[var(--faint)]">size n/a</span>;
  return <Loader2 size={14} className="shrink-0 animate-spin text-[var(--faint)]" />;
}
