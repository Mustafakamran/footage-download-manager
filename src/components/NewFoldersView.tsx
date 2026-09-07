import { useState } from "react";
import { FolderPlus, Folder, Loader2, ChevronRight, Download, Pause, Check, HardDrive, Link2, CheckCheck } from "lucide-react";
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
import type { SizeValue } from "../store/browse";
import type { Account } from "../lib/tauri/commands";
import type { RcItem } from "../lib/rc/browse";

const STATUS_ICON = { downloading: Download, on_hold: Pause, downloaded: Check, copied: HardDrive } as const;

/**
 * "New folders" — top-level folders a client has added to any connected drive
 * since it was last seen, that you haven't downloaded yet. Click jumps to the
 * folder in the browser; right-click sets a workflow status (Downloading / On
 * hold / Downloaded / Copied).
 */
export function NewFoldersView() {
  const setView = useApp((s) => s.setView);
  const meta = useAccountMeta((s) => s.byId);
  const { groups, count, totalSize, allSized, sizeOf, seenAtOf, markAllRead, acknowledgeAll } = useNewFolders();
  const hasFolders = groups.length > 0;
  const listedCount = groups.reduce((n, g) => n + g.folders.length, 0);
  const statusByAccount = useFolderStatus((s) => s.byAccount);
  const setFolderStatus = useFolderStatus((s) => s.set);
  const visitedByAccount = useVisited((s) => s.byAccount);
  const [menu, setMenu] = useState<{ x: number; y: number; account: Account; folder: RcItem } | null>(null);
  const [share, setShare] = useState<{ account: Account; item: RcItem; anchor: { x: number; y: number } } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const menuItems = (account: Account, folder: RcItem): MenuItem[] => {
    const cur = statusByAccount[account.id]?.[folder.Path];
    const items: MenuItem[] = FOLDER_STATUS_ORDER.map((st, i) => ({
      label: cur === st ? `${FOLDER_STATUS_META[st].label} ✓` : `Mark ${FOLDER_STATUS_META[st].label}`,
      icon: STATUS_ICON[st],
      separator: i === 0,
      onClick: () => setFolderStatus(account.id, folder.Path, cur === st ? null : st),
    }));
    items.push({ label: "Copy link", icon: Link2, separator: true, onClick: () => setShare({ account, item: folder, anchor: { x: menu?.x ?? window.innerWidth / 2, y: menu?.y ?? window.innerHeight / 2 } }) });
    return items;
  };

  return (
    <div className="h-full overflow-auto px-8 py-7">
      <div className="mb-7 flex items-start justify-between gap-4">
        <div className="min-w-0">
        <h1 className="flex items-center gap-2 text-[26px] font-bold tracking-[-0.025em] text-[var(--ink)]">
          <FolderPlus size={22} className="text-[var(--acc)]" /> Recently added
        </h1>
        <p className="mt-1 text-[13.5px] text-[var(--mut)]">
          {count > 0 ? (
            <>
              <span className="font-semibold text-[var(--ink)]">{count}</span> new folder{count === 1 ? "" : "s"} across your drives ·{" "}
              <span className="tnum">{formatBytes(totalSize)}</span>
              {!allSized && <span className="text-[var(--faint)]"> +</span>} total
            </>
          ) : (
            `Top-level folders a client has added to your drives, that you haven't downloaded yet, show up here.`
          )}
        </p>
        </div>
        {hasFolders && (
          <div className="flex shrink-0 items-center gap-2">
            {count > 0 && (
              <button
                onClick={() => markAllRead()}
                className="flex items-center gap-1.5 rounded-[9px] border border-[var(--line)] bg-[var(--card)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--mut)] hover:border-[var(--line2)] hover:text-[var(--ink)]"
                data-tip="Clear the badge but keep them listed"
              >
                <Check size={14} /> Mark as read
              </button>
            )}
            <button
              onClick={() => setConfirmClear(true)}
              className="flex items-center gap-1.5 rounded-[9px] border border-[var(--line)] bg-[var(--card)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--mut)] hover:border-[var(--line2)] hover:text-[var(--ink)]"
              data-tip="Remove them from this list"
            >
              <CheckCheck size={14} /> Clear recents
            </button>
          </div>
        )}
      </div>

      {count === 0 ? (
        <EmptyState
          icon={<FolderPlus size={20} />}
          title="No new folders"
          body={`When a client adds a folder to one of your drives, it appears here so you know what still needs downloading. Right-click a folder to mark it Downloading / On hold / Downloaded / Copied. Folders you've already downloaded are hidden.`}
        />
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((g) => (
            <div key={g.account.id}>
              <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-[var(--mut)]">
                <ProviderIcon provider={g.account.provider} size={13} />
                <span className="truncate">{accountLabel(meta[g.account.id]?.label, g.account)}</span>
                <span className="tnum text-[var(--faint)]">· {g.folders.length}</span>
              </div>
              <div className="overflow-hidden rounded-[13px] border border-[var(--line)]">
                {g.folders.map((f, i) => {
                  const status = statusByAccount[g.account.id]?.[f.Path];
                  const opened = (visitedByAccount[g.account.id] ?? []).includes(f.Path);
                  const seen = seenAtOf(g.account.id, f.Path);
                  return (
                    <button
                      key={f.Path}
                      onClick={() => setView({ kind: "browse", accountId: g.account.id, section: "all", path: f.Path })}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenu({ x: e.clientX, y: e.clientY, account: g.account, folder: f });
                      }}
                      className={`group flex w-full items-center gap-3 bg-[var(--card)] px-4 py-3 text-left transition-colors hover:bg-[var(--hover)] ${i > 0 ? "border-t border-[var(--line)]" : ""} ${opened ? "opacity-60" : ""}`}
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
                      <SizeLabel size={sizeOf(g.account.id, f.Path)} />
                      <ChevronRight size={16} className="shrink-0 text-[var(--faint)] opacity-0 transition-opacity group-hover:opacity-100" />
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
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
              Remove all <span className="font-semibold text-[var(--ink)]">{listedCount}</span> folder{listedCount === 1 ? "" : "s"} from this list? They’ll no longer show as new. Folders added later will still appear. To just clear the badge, use “Mark as read” instead.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConfirmClear(false)} className="rounded-[9px] px-3 py-2 text-[13px] font-medium text-[var(--faint)] hover:text-[var(--ink)]">Cancel</button>
              <button
                onClick={() => { acknowledgeAll(); setConfirmClear(false); }}
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

function SizeLabel({ size }: { size: SizeValue | undefined }) {
  if (typeof size === "number") return <span className="tnum shrink-0 text-[12.5px] text-[var(--text-2)]">{formatBytes(size)}</span>;
  if (size === "error") return <span className="shrink-0 text-[12px] text-[var(--faint)]">size n/a</span>;
  return <Loader2 size={14} className="shrink-0 animate-spin text-[var(--faint)]" />;
}
