import { useEffect } from "react";
import { HardDrive, Download, ChevronRight, RefreshCw } from "lucide-react";
import { useApp } from "../store/app";
import { useAccountMeta, accountLabel } from "../store/account-meta";
import { useSharedDrives } from "../store/shared-drives";
import { useDriveTabs } from "../store/drive-tabs";
import { pickDownloadDest } from "../lib/ingest";
import { downloadTeamDrive } from "../lib/drive-link";
import { type Account, type SharedDrive } from "../lib/tauri/commands";
import { ProviderIcon } from "./icons";
import { EmptyState } from "./ui";

/**
 * "Shared Drives" — the client Google Shared Drives (Team Drives) each connected
 * Google Drive can reach, which live outside "Shared with me" and so never appear
 * in a normal listing. Grouped under their parent drive; open one to browse and
 * download its files/folders in the full file browser, or download the whole
 * drive. (Opening does NOT add a sidebar account.)
 */
export function SharedDrivesView() {
  const accounts = useApp((s) => s.accounts);
  const meta = useAccountMeta((s) => s.byId);
  // Real Google Drive accounts only — the parents (not drivelink_/teamdrive_ links).
  const drives = accounts.filter((a) => a.provider === "drive" && a.id.startsWith("drive_"));
  // Opening a drive is handled app-wide by the Shared Drive dock (a persistent
  // tab rail + slide-over rendered in the shell), so it survives screen changes.
  const openDrive = useDriveTabs((s) => s.open);

  return (
    <div className="h-full overflow-auto px-8 py-7">
      <div className="mb-7">
        <h1 className="flex items-center gap-2 text-[26px] font-bold tracking-[-0.025em] text-[var(--ink)]">
          <HardDrive size={22} className="text-[var(--acc)]" /> Shared Drives
        </h1>
        <p className="mt-1 text-[13.5px] text-[var(--mut)]">
          Client Shared Drives (Team Drives) each connected Google Drive can access. Open one to browse it in place — no leaving this screen.
        </p>
      </div>

      {drives.length === 0 ? (
        <EmptyState
          icon={<HardDrive size={20} />}
          title="No Google Drive connected"
          body="Connect a Google Drive account to see the Shared Drives clients have given it access to."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {drives.map((account) => (
            <DriveGroup key={account.id} account={account} label={accountLabel(meta[account.id]?.label, account)} onOpen={(drive) => openDrive(account, drive)} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One parent Google Drive → the Shared Drives it can access (served from cache,
 *  refreshed in the background so re-opening the screen is instant). */
function DriveGroup({ account, label, onOpen }: { account: Account; label: string; onOpen: (drive: SharedDrive) => void }) {
  const cached = useSharedDrives((s) => s.byAccount[account.id]);
  const loading = useSharedDrives((s) => s.loading[account.id]);
  const refresh = useSharedDrives((s) => s.refresh);
  const drives = cached?.list;

  useEffect(() => { void refresh(account.id); }, [account.id, refresh]);

  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-[var(--mut)]">
        <ProviderIcon provider={account.provider} size={13} />
        <span className="truncate">{label}</span>
        {drives && <span className="tnum text-[var(--faint)]">· {drives.length}</span>}
        <button
          onClick={() => void refresh(account.id)}
          data-tip="Refresh"
          aria-label="Refresh Shared Drives"
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-[7px] text-[var(--faint)] hover:bg-[var(--soft)] hover:text-[var(--ink)]"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      <div className="overflow-hidden rounded-[13px] border border-[var(--line)] bg-[var(--card)]">
        {drives === undefined ? (
          // First-ever fetch (no cache yet): skeleton rows instead of a spinner wall.
          <>
            {[0, 1, 2].map((i) => (
              <div key={i} className={`flex items-center gap-3 px-4 py-3 ${i > 0 ? "border-t border-[var(--line)]" : ""}`}>
                <span className="h-[38px] w-[38px] shrink-0 skeleton rounded-[11px]" />
                <span className="flex-1"><span className="block h-3 w-40 skeleton rounded" /></span>
              </div>
            ))}
          </>
        ) : drives.length === 0 ? (
          <div className="px-4 py-3 text-[12.5px] text-[var(--faint)]">No Shared Drives available to this account.</div>
        ) : (
          drives.map((d, i) => <TeamDriveRow key={d.id} account={account} drive={d} first={i === 0} onOpen={() => onOpen(d)} />)
        )}
      </div>
    </div>
  );
}

/** A Shared Drive row — click to browse it in the slide-over; download the whole drive. */
function TeamDriveRow({ account, drive, first, onOpen }: { account: Account; drive: SharedDrive; first: boolean; onOpen: () => void }) {
  const download = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const dest = await pickDownloadDest();
    if (!dest) return;
    void downloadTeamDrive(account.id, drive.name, drive.id, dest);
  };
  return (
    <button
      onClick={onOpen}
      className={`group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--soft)] ${first ? "" : "border-t border-[var(--line)]"}`}
    >
      <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[11px] bg-[var(--accw)]">
        <HardDrive size={18} className="text-[var(--acc)]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium text-[var(--ink)]">{drive.name}</span>
        <span className="block truncate text-[11.5px] text-[var(--faint)]">Shared Drive · click to browse</span>
      </span>
      <span
        role="button"
        tabIndex={0}
        onClick={download}
        onKeyDown={(e) => { if (e.key === "Enter") void download(e as unknown as React.MouseEvent); }}
        data-tip="Download drive"
        aria-label={`Download ${drive.name}`}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] text-[var(--faint)] opacity-0 transition hover:bg-[var(--line)] hover:text-[var(--ink)] group-hover:opacity-100"
      >
        <Download size={15} />
      </span>
      <ChevronRight size={16} className="shrink-0 text-[var(--faint)] opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}
