import { useState } from "react";
import { Loader2, X, Link as LinkIcon } from "lucide-react";
import { addDriveLink } from "../lib/tauri/commands";
import { useApp } from "../store/app";
import { useIndex } from "../store/index-store";
import { useAccountMeta } from "../store/account-meta";
import { useToasts } from "../store/toast";
import { Button, TextField, Card } from "./ui";

function driveFolderId(url: string): string | null {
  const m =
    url.match(/\/folders\/([A-Za-z0-9_-]+)/) ||
    url.match(/[?&]id=([A-Za-z0-9_-]+)/) ||
    url.match(/\/d\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}
function providerFromUrl(url: string): "drive" | "dropbox" | null {
  if (/drive\.google\.com|docs\.google\.com/.test(url)) return "drive";
  if (/dropbox\.com/.test(url)) return "dropbox";
  return null;
}

export function AddLinkDialog({ onClose }: { onClose: () => void }) {
  const { accounts, loadAccounts, selectAccount } = useApp();
  const toast = useToasts((s) => s.push);
  const driveAccounts = accounts.filter((a) => a.provider === "drive" && !a.id.startsWith("drivelink_"));

  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [baseId, setBaseId] = useState(driveAccounts[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const provider = providerFromUrl(url);

  async function submit() {
    setError("");
    if (provider === "dropbox") {
      setError("Dropbox links aren't supported yet (native downloader is in progress). Google Drive links work now.");
      return;
    }
    if (provider !== "drive") {
      setError("Paste a Google Drive folder share link.");
      return;
    }
    const fid = driveFolderId(url);
    if (!fid) {
      setError("Couldn't find a folder id in that link.");
      return;
    }
    if (!baseId) {
      setError("Connect a Google Drive account first — its login is used to open the link.");
      return;
    }
    if (!label.trim()) {
      setError("Give the link a name.");
      return;
    }
    setBusy(true);
    try {
      const acct = await addDriveLink(baseId, label.trim(), fid);
      useAccountMeta.getState().setLabel(acct.id, label.trim());
      await loadAccounts();
      void useIndex.getState().ensure(acct);
      toast(`Added link · ${label.trim()}`, "success");
      selectAccount(acct.id);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" role="dialog" aria-modal="true">
      <Card className="animate-rise w-[460px] p-5 shadow-[var(--shadow-lg)]">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
            <LinkIcon size={15} /> Add a shared link
          </h2>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            <X size={16} />
          </Button>
        </div>

        {busy ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <Loader2 className="animate-spin text-[var(--accent)]" size={24} />
            <p className="text-sm text-[var(--text-2)]">Adding link…</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <TextField
              label="Share link (Google Drive folder)"
              placeholder="https://drive.google.com/drive/folders/…"
              value={url}
              autoFocus
              onChange={(e) => setUrl(e.target.value)}
            />
            <TextField label="Name" placeholder="e.g. Client A — October" value={label} onChange={(e) => setLabel(e.target.value)} />

            {driveAccounts.length > 1 && (
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-[var(--text-2)]">Open with (your Drive login)</span>
                <select
                  value={baseId}
                  onChange={(e) => setBaseId(e.target.value)}
                  className="focus-accent rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
                >
                  {driveAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <p className="text-xs text-[var(--text-3)]">
              Downloads come straight from the link to your disk — nothing is added to your own Drive/Dropbox.
              {driveAccounts.length === 0 && (
                <span className="text-[var(--warning)]"> Connect a Google Drive account first.</span>
              )}
            </p>

            {error && <p className="text-sm text-[var(--error)]">{error}</p>}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" onClick={submit} disabled={!url.trim() || !label.trim()}>
                Add link
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
