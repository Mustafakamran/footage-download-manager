import { RcClient } from "./client";
import type { Account } from "../tauri/commands";

export interface RcItem {
  Name: string;
  Path: string;
  Size: number;
  IsDir: boolean;
  ModTime: string;
  MimeType: string;
}

/**
 * rclone connection string for an account. Google Drive must surface
 * "Shared with me" (where clients drop footage), so we append the
 * shared_with_me connection parameter. Dropbox uses the plain remote.
 */
export function buildFs(account: Account): string {
  return account.provider === "drive"
    ? `${account.id},shared_with_me=true:`
    : `${account.id}:`;
}

/** List a folder (path "" = root), sorted dirs-first then alphabetical. */
export async function listFolder(account: Account, path: string): Promise<RcItem[]> {
  const res = await new RcClient().call<{ list?: RcItem[] }>("operations/list", {
    fs: buildFs(account),
    remote: path,
  });
  const list = res?.list ?? [];
  return [...list].sort((a, b) => {
    if (a.IsDir !== b.IsDir) return a.IsDir ? -1 : 1;
    return a.Name.toLowerCase().localeCompare(b.Name.toLowerCase());
  });
}
