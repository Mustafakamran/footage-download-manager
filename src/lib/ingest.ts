import { downloadDir } from "@tauri-apps/api/path";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTransfers, filenameFromUrl, HTTP_ACCOUNT_ID } from "../store/transfers";
import { useToasts } from "../store/toast";
import type { DownloadItem } from "./tauri/commands";

/**
 * Account id for browser-captured social/video URLs handled by the bundled
 * yt-dlp sidecar. Classified as the SECONDARY lane (see `laneOf`), so these
 * never disturb Drive/Dropbox footage work.
 */
export const YTDLP_ACCOUNT_ID = "ytdlp";

/** localStorage key for the user's chosen default download folder. */
export const FOLDER_KEY = "default_download_folder";

/** The kind of capture the browser extension forwards. */
export type IngestKind = "file" | "media";

/** Shape of the Rust `ingest-url` event payload. */
export interface IngestPayload {
  url: string;
  kind: IngestKind;
}

/**
 * Map an ingest kind to the engine account id:
 *  - "media" -> yt-dlp sidecar (social/video)
 *  - "file"  -> generic streaming HTTP download
 * Pure; no dependencies — unit-tested.
 */
export function accountIdForKind(kind: IngestKind): string {
  return kind === "media" ? YTDLP_ACCOUNT_ID : HTTP_ACCOUNT_ID;
}

/**
 * Build the download item for an ingested URL. The backend resolves the real
 * filename, so name is a best-effort guess from the URL and size is unknown.
 * Pure; unit-tested.
 */
export function itemForUrl(url: string): DownloadItem {
  return { path: "", name: filenameFromUrl(url), isDir: false, size: 0, id: url };
}

/**
 * Resolve the destination folder for an ingested download: the user's configured
 * default folder, else the OS Downloads dir. Falls back to "" only if neither is
 * available (the engine then prompts / errors).
 */
export async function resolveDest(): Promise<string> {
  const configured = localStorage.getItem(FOLDER_KEY);
  if (configured) return configured;
  try {
    return await downloadDir();
  } catch {
    return "";
  }
}

/**
 * Enqueue a single ingested URL into the default download folder and toast it.
 * Exported (and dependency-injectable) so it can be unit-tested without Tauri.
 */
export async function ingest(
  payload: IngestPayload,
  deps: {
    enqueue?: (accountId: string, items: DownloadItem[], dest: string) => void;
    pushToast?: (msg: string) => void;
    dest?: () => Promise<string>;
  } = {},
): Promise<void> {
  const url = payload.url?.trim();
  if (!url) return;
  const enqueue = deps.enqueue ?? useTransfers.getState().enqueue;
  const pushToast = deps.pushToast ?? ((m: string) => useToasts.getState().push(m, "success"));
  const dest = await (deps.dest ?? resolveDest)();
  const item = itemForUrl(url);
  enqueue(accountIdForKind(payload.kind), [item], dest);
  pushToast(`Added from browser: ${item.name}`);
}

/**
 * Subscribe to the Rust `ingest-url` event and enqueue each capture. Call once
 * on app launch; returns a cleanup that unlistens. Safe when there's no Tauri
 * event runtime (e.g. tests) — it resolves to a no-op cleanup.
 */
export function startIngestListener(): () => void {
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;
  listen<IngestPayload>("ingest-url", (ev) => {
    void ingest(ev.payload);
  })
    .then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    })
    .catch(() => {
      /* no Tauri event runtime (e.g. unit tests) */
    });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
