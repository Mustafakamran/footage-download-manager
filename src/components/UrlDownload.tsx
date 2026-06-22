import { useState } from "react";
import { Globe, Folder } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useTransfers } from "../store/transfers";
import { useToasts } from "../store/toast";
import { Button } from "./ui";

const FOLDER_KEY = "default_download_folder";

/**
 * Minimal "Download from URL" entry: paste a URL, pick a destination folder,
 * enqueue a generic HTTP download. This exercises the SECONDARY scheduling lane
 * (account id "http"), which the gate keeps from disturbing primary Drive/
 * Dropbox work. Intentionally bare — the polished generic-download UX is later.
 */
export function UrlDownload() {
  const enqueueUrl = useTransfers((s) => s.enqueueUrl);
  const toast = useToasts((s) => s.push);
  const [url, setUrl] = useState("");

  async function submit() {
    const trimmed = url.trim();
    if (!trimmed) return;
    let dest = localStorage.getItem(FOLDER_KEY) ?? "";
    if (!dest) {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked !== "string") return;
      dest = picked;
    }
    enqueueUrl(trimmed, dest);
    toast("Queued download from URL", "success");
    setUrl("");
  }

  async function pickFolder() {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") {
      localStorage.setItem(FOLDER_KEY, picked);
      toast("Download folder set", "success");
    }
  }

  return (
    <div id="url-download" className="rounded-[10px] border border-[var(--border)] bg-[var(--card)] p-4">
      <div className="mb-1 flex items-center gap-2">
        <Globe size={16} className="shrink-0 text-[var(--accent)]" />
        <h2 className="text-sm font-semibold text-[var(--text)]">Download from a link</h2>
      </div>
      <p className="mb-3 text-xs text-[var(--text-3)]">
        Paste any direct file URL — it downloads alongside your Drive/Dropbox transfers.
      </p>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Globe size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            placeholder="Paste a URL to download…"
            aria-label="URL to download"
            className="focus-accent w-full rounded-[6px] border border-[var(--border)] bg-[var(--surface)] py-1.5 pl-9 pr-3 text-sm text-[var(--text)] placeholder:text-[var(--text-3)]"
          />
        </div>
        <button
          onClick={() => void pickFolder()}
          aria-label="Choose download folder"
          title="Choose download folder"
          className="flex h-8 w-8 items-center justify-center rounded-[6px] border border-[var(--border)] text-[var(--text-3)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          <Folder size={15} />
        </button>
        <Button variant="primary" onClick={() => void submit()} disabled={!url.trim()} title="Start the download">
          Download
        </Button>
      </div>
    </div>
  );
}
