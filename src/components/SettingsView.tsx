import { useEffect, useState } from "react";
import { FolderOpen, Check, RefreshCw, Download, Loader2, Layers, Copy, Puzzle } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { getSecret, setSecret, SECRET_KEYS, bdmGetConfig, bdmSetConfig, ingestToken, prepareExtension, revealPath } from "../lib/tauri/commands";
import { Button, TextField, Card } from "./ui";
import { useToasts } from "../store/toast";
import { useTransfers } from "../store/transfers";
import { useUpdater } from "../store/updater";
import { loadDlSettings, saveDlSettings, type DlSettings } from "../lib/dl-settings";
import { getAskWhereToSave, setAskWhereToSave } from "../lib/ask-where";

const FOLDER_KEY = "default_download_folder";

/** Fixed loopback port the ingest server binds (shared with the extension). */
const INGEST_PORT = 53713;

type Tab = "general" | "extension" | "google" | "dropbox" | "sync" | "updates";
const TABS: { key: Tab; label: string }[] = [
  { key: "general", label: "General" },
  { key: "extension", label: "Browser extension" },
  { key: "google", label: "Google Drive" },
  { key: "dropbox", label: "Dropbox" },
  { key: "sync", label: "Sync (BDM)" },
  { key: "updates", label: "Updates" },
];

export function SettingsView() {
  const [tab, setTab] = useState<Tab>("general");
  const [googleId, setGoogleId] = useState("");
  const [googleSecret, setGoogleSecret] = useState("");
  const [dropboxKey, setDropboxKey] = useState("");
  const [dropboxSecret, setDropboxSecret] = useState("");
  const [folder, setFolder] = useState<string>(() => localStorage.getItem(FOLDER_KEY) ?? "");
  const [saved, setSaved] = useState<string | null>(null);
  const toast = useToasts((s) => s.push);
  const concurrency = useTransfers((s) => s.concurrency);
  const setConcurrency = useTransfers((s) => s.setConcurrency);
  const updater = useUpdater();
  const [appVersion, setAppVersion] = useState("");
  const [dl, setDl] = useState<DlSettings>(() => loadDlSettings());
  const [token, setToken] = useState<string | null>(null);
  const [tokenErr, setTokenErr] = useState(false);
  const [askWhere, setAskWhere] = useState<boolean>(() => getAskWhereToSave());
  const [extFolder, setExtFolder] = useState<string | null>(null);
  const [extBusy, setExtBusy] = useState(false);

  // Load the pairing token lazily when the Browser-extension tab is first opened
  // (it generates one on first read — no need to do it on every Settings mount).
  useEffect(() => {
    if (tab !== "extension" || token !== null) return;
    let alive = true;
    ingestToken()
      .then((t) => alive && setToken(t))
      .catch(() => alive && setTokenErr(true));
    return () => {
      alive = false;
    };
  }, [tab, token]);

  function copyToken() {
    if (!token) return;
    navigator.clipboard
      .writeText(token)
      .then(() => markSaved("token", "Token copied"))
      .catch(() => toast("Couldn't copy token", "error"));
  }

  async function installExtension() {
    setExtBusy(true);
    try {
      const folder = await prepareExtension();
      setExtFolder(folder);
      await revealPath(folder).catch(() => {});
      markSaved("ext", "Extension folder ready — opened in your file manager");
    } catch (e) {
      toast(`Couldn't prepare the extension: ${e}`, "error");
    } finally {
      setExtBusy(false);
    }
  }

  function toggleAskWhere(on: boolean) {
    setAskWhere(on);
    setAskWhereToSave(on);
    markSaved("askwhere", on ? "Will ask where to save" : "Saving to default folder");
  }

  function setDlField(k: keyof DlSettings, v: number) {
    const next = { ...dl, [k]: Number.isFinite(v) && v >= 0 ? v : 0 };
    setDl(next);
    saveDlSettings(next);
  }

  const [bdm, setBdm] = useState({
    enabled: false,
    portalUrl: "https://bilal-drive-man.vercel.app",
    machine: "FDM-PC1",
    destRoot: "",
    hasKey: false,
    status: "",
  });
  const [bdmKey, setBdmKey] = useState("");
  useEffect(() => {
    bdmGetConfig().then((c) => c && setBdm(c)).catch(() => {});
  }, []);
  async function saveBdm() {
    await bdmSetConfig(bdm.enabled, bdm.portalUrl, bdm.machine, bdm.destRoot, bdmKey || undefined);
    setBdmKey("");
    const c = await bdmGetConfig().catch(() => null);
    if (c) setBdm(c);
    markSaved("bdm", "Sync settings saved");
  }
  async function pickDestRoot() {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") setBdm((b) => ({ ...b, destRoot: picked }));
  }

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
    (async () => {
      const [gi, gs, dk, ds] = await Promise.all([
        getSecret(SECRET_KEYS.drive.id),
        getSecret(SECRET_KEYS.drive.secret),
        getSecret(SECRET_KEYS.dropbox.id),
        getSecret(SECRET_KEYS.dropbox.secret),
      ]);
      if (gi) setGoogleId(gi);
      if (gs) setGoogleSecret(gs);
      if (dk) setDropboxKey(dk);
      if (ds) setDropboxSecret(ds);
    })();
  }, []);

  function markSaved(key: string, msg: string) {
    toast(msg, "success");
    setSaved(key);
    setTimeout(() => setSaved((s) => (s === key ? null : s)), 2200);
  }

  async function saveGoogle() {
    await Promise.all([setSecret(SECRET_KEYS.drive.id, googleId), setSecret(SECRET_KEYS.drive.secret, googleSecret)]);
    markSaved("google", "Google credentials saved");
  }
  async function saveDropbox() {
    await Promise.all([setSecret(SECRET_KEYS.dropbox.id, dropboxKey), setSecret(SECRET_KEYS.dropbox.secret, dropboxSecret)]);
    markSaved("dropbox", "Dropbox credentials saved");
  }
  async function chooseFolder() {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") {
      setFolder(picked);
      localStorage.setItem(FOLDER_KEY, picked);
      markSaved("folder", "Default folder set");
    }
  }

  const tick = (key: string) =>
    saved === key ? (
      <span className="flex items-center gap-1 text-sm text-[var(--success)]">
        <Check size={15} /> Saved
      </span>
    ) : null;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col p-6">
      <h1 className="mb-4 text-lg font-semibold text-[var(--text)]">Settings</h1>

      {/* Tabs */}
      <div className="mb-5 flex gap-1 border-b border-[var(--border)]">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === t.key
                ? "border-[var(--accent)] font-medium text-[var(--text)]"
                : "border-transparent text-[var(--text-2)] hover:text-[var(--text)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "general" && (
        <div className="flex flex-col gap-4">
          <Card className="p-5">
            <h2 className="mb-1 text-sm font-semibold text-[var(--text)]">Default download folder</h2>
            <p className="mb-4 text-xs text-[var(--text-3)]">
              Where downloads land unless overridden per job — also used for files sent from the browser extension.
              Defaults to your system Downloads folder when unset.
            </p>
            <div className="flex items-center gap-3">
              <div className="tnum min-w-0 flex-1 truncate rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text-2)]">
                {folder || "Not set"}
              </div>
              {tick("folder")}
              <Button variant="primary" onClick={chooseFolder}>
                <FolderOpen size={16} /> Choose…
              </Button>
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
              <Layers size={16} /> Simultaneous downloads
            </h2>
            <p className="mb-4 text-xs text-[var(--text-3)]">
              How many files download at once. Queue projects; 1 = strictly one at a time.
            </p>
            <input
              type="number"
              min={1}
              value={concurrency}
              onChange={(e) => setConcurrency(Number(e.target.value))}
              aria-label="Simultaneous downloads"
              title="How many files download at once"
              className="focus-accent w-24 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
            />
          </Card>

          <Card className="p-5">
            <h2 className="mb-1 text-sm font-semibold text-[var(--text)]">Download speed</h2>
            <p className="mb-4 text-xs text-[var(--text-3)]">
              More connections per file = faster on a fast line. Set a cap to leave bandwidth for other work
              (0 = unlimited). Resume is unaffected.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <TextField
                label="Connections per file (1–16)"
                type="number"
                value={dl.connections}
                onChange={(e) => setDlField("connections", Number(e.target.value))}
              />
              <TextField
                label="Bandwidth limit (MB/s, 0 = off)"
                type="number"
                value={dl.bwLimitMbps}
                onChange={(e) => setDlField("bwLimitMbps", Number(e.target.value))}
              />
            </div>
          </Card>
        </div>
      )}

      {tab === "extension" && (
        <div className="flex flex-col gap-4">
          <Card className="p-5">
            <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
              <Puzzle size={16} /> Pairing token
            </h2>
            <p className="mb-4 text-xs text-[var(--text-3)]">
              The FDM browser extension sends downloads to this app over a local connection. Paste this token
              into the extension once to pair it. Keep it private — anyone with it can queue downloads on this machine.
            </p>
            <div className="flex items-center gap-3">
              <div className="tnum min-w-0 flex-1 truncate rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text-2)]">
                {tokenErr ? "Unavailable (app not running in desktop mode)" : token ?? "Loading…"}
              </div>
              {tick("token")}
              <Button variant="primary" onClick={copyToken} disabled={!token}>
                <Copy size={16} /> Copy
              </Button>
            </div>
            <div className="mt-3 text-xs text-[var(--text-3)]">
              Listening on <span className="tnum text-[var(--text-2)]">127.0.0.1:{INGEST_PORT}</span>
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="mb-1 text-sm font-semibold text-[var(--text)]">Install / set up extension</h2>
            <p className="mb-4 text-xs text-[var(--text-3)]">
              Chrome can't install an unpacked extension automatically, so this is a quick guided setup. The button
              below copies the bundled extension to a folder you can reach and opens it for you. A one-click Chrome
              Web Store install is planned for a future release.
            </p>
            <div className="flex items-center gap-3">
              <Button variant="primary" onClick={() => void installExtension()} disabled={extBusy}>
                {extBusy ? <Loader2 size={16} className="animate-spin" /> : <Puzzle size={16} />}
                Install / set up extension
              </Button>
              {tick("ext")}
            </div>
            {extFolder && (
              <div className="mt-3 flex items-center gap-3">
                <div className="tnum min-w-0 flex-1 truncate rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text-2)]">
                  {extFolder}
                </div>
                <Button variant="ghost" onClick={() => void revealPath(extFolder).catch(() => {})}>
                  <FolderOpen size={16} /> Reveal
                </Button>
              </div>
            )}
            <ol className="mt-4 ml-4 list-decimal space-y-1.5 text-xs text-[var(--text-2)]">
              <li>
                Click <span className="text-[var(--text)]">Install / set up extension</span> above — it opens the
                extension folder in your file manager.
              </li>
              <li>
                In Chrome, open <span className="tnum text-[var(--text)]">chrome://extensions</span>.
              </li>
              <li>
                Enable <span className="text-[var(--text)]">Developer mode</span> (top-right toggle).
              </li>
              <li>
                Click <span className="text-[var(--text)]">Load unpacked</span> and choose the folder that was just
                revealed{extFolder ? "" : " (shown above after you click the button)"}.
              </li>
              <li>
                Open the extension's options, paste the pairing token shown above, and{" "}
                <span className="text-[var(--text)]">Save</span>.
              </li>
              <li>
                A green dot in the extension means it reached FDM on{" "}
                <span className="tnum text-[var(--text-2)]">127.0.0.1:{INGEST_PORT}</span>. Now any captured file or
                video lands in your default download folder.
              </li>
            </ol>
          </Card>

          <Card className="p-5">
            <h2 className="mb-1 text-sm font-semibold text-[var(--text)]">Ask where to save</h2>
            <p className="mb-4 text-xs text-[var(--text-3)]">
              When on, a captured download opens a save dialog so you can pick the folder and name (seeded with the
              suggested filename). When off, captures drop straight into your default download folder.
            </p>
            <div className="flex items-center justify-between gap-3">
              <label
                className="flex items-center gap-2 text-sm text-[var(--text)]"
                title="Show a save dialog for each browser-captured download"
              >
                <input
                  type="checkbox"
                  checked={askWhere}
                  onChange={(e) => toggleAskWhere(e.target.checked)}
                />
                Ask where to save (browser downloads)
              </label>
              {tick("askwhere")}
            </div>
          </Card>
        </div>
      )}

      {tab === "google" && (
        <Card className="p-5">
          <h2 className="mb-1 text-sm font-semibold text-[var(--text)]">Google Drive API</h2>
          <p className="mb-4 text-xs text-[var(--text-3)]">
            Your OAuth Desktop client (scope: drive.readonly). Entered once — reused for
            <span className="text-[var(--text-2)]"> all </span>your Google accounts.
          </p>
          <div className="flex flex-col gap-3">
            <TextField label="Client ID" value={googleId} onChange={(e) => setGoogleId(e.target.value)} />
            <TextField label="Client Secret" type="password" value={googleSecret} onChange={(e) => setGoogleSecret(e.target.value)} />
            <div className="flex items-center justify-end gap-3">
              {tick("google")}
              <Button variant="primary" onClick={saveGoogle}>
                Save Google credentials
              </Button>
            </div>
          </div>
        </Card>
      )}

      {tab === "dropbox" && (
        <Card className="p-5">
          <h2 className="mb-1 text-sm font-semibold text-[var(--text)]">Dropbox API</h2>
          <p className="mb-4 text-xs text-[var(--text-3)]">
            Your Dropbox app key + secret. Entered once — reused for
            <span className="text-[var(--text-2)]"> all </span>your Dropbox accounts.
          </p>
          <div className="flex flex-col gap-3">
            <TextField label="App key" value={dropboxKey} onChange={(e) => setDropboxKey(e.target.value)} />
            <TextField label="App secret" type="password" value={dropboxSecret} onChange={(e) => setDropboxSecret(e.target.value)} />
            <div className="flex items-center justify-end gap-3">
              {tick("dropbox")}
              <Button variant="primary" onClick={saveDropbox}>
                Save Dropbox credentials
              </Button>
            </div>
          </div>
        </Card>
      )}

      {tab === "sync" && (
        <Card className="p-5">
          <h2 className="mb-1 text-sm font-semibold text-[var(--text)]">Bilal-Drive-Man sync</h2>
          <p className="mb-4 text-xs text-[var(--text-3)]">
            Make FDM a downloader machine for the BDM portal. When enabled, FDM registers as{" "}
            <span className="text-[var(--text-2)]">{bdm.machine || "this machine"}</span>, picks up downloads you assign
            to it, and reports status + a location note back. Downloads use your connected Drive/Dropbox accounts.
          </p>
          <div className="flex flex-col gap-3">
            <label className="flex items-center gap-2 text-sm text-[var(--text)]" title="Pick up downloads assigned to this machine from the BDM portal">
              <input type="checkbox" checked={bdm.enabled} onChange={(e) => setBdm((b) => ({ ...b, enabled: e.target.checked }))} />
              Enable sync agent
            </label>
            <TextField label="Portal URL" value={bdm.portalUrl} onChange={(e) => setBdm((b) => ({ ...b, portalUrl: e.target.value }))} />
            <TextField label="Machine name" value={bdm.machine} onChange={(e) => setBdm((b) => ({ ...b, machine: e.target.value }))} />
            <TextField
              label={bdm.hasKey ? "API key (saved — leave blank to keep)" : "API key (x-api-key)"}
              type="password"
              placeholder={bdm.hasKey ? "••••••••" : ""}
              value={bdmKey}
              onChange={(e) => setBdmKey(e.target.value)}
            />
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-[var(--text-2)]">Download folder (downloads go to &lt;folder&gt;/client/couple)</span>
              <div className="flex items-center gap-3">
                <div className="tnum min-w-0 flex-1 truncate rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text-2)]">
                  {bdm.destRoot || "Not set"}
                </div>
                <Button variant="ghost" onClick={pickDestRoot}>
                  <FolderOpen size={16} /> Choose…
                </Button>
              </div>
            </label>
            {bdm.status && <p className="text-xs text-[var(--text-3)]">Status: {bdm.status}</p>}
            <div className="flex items-center justify-end gap-3">
              {tick("bdm")}
              <Button variant="primary" onClick={saveBdm}>
                Save sync settings
              </Button>
            </div>
          </div>
        </Card>
      )}

      {tab === "updates" && (
        <Card className="p-5">
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
            <RefreshCw size={16} /> Updates
          </h2>
          <p className="mb-4 text-xs text-[var(--text-3)]">
            {appVersion ? (
              <>
                You're on version <span className="text-[var(--text-2)]">{appVersion}</span>. The app also checks
                automatically on launch.
              </>
            ) : (
              "The app checks for updates automatically on launch."
            )}
          </p>
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1 text-sm">
              {updater.phase === "checking" && (
                <span className="flex items-center gap-1.5 text-[var(--text-2)]">
                  <Loader2 size={14} className="animate-spin" /> Checking…
                </span>
              )}
              {updater.phase === "uptodate" && (
                <span className="flex items-center gap-1.5 text-[var(--success)]">
                  <Check size={15} /> You're on the latest version.
                </span>
              )}
              {updater.phase === "available" && (
                <span className="text-[var(--text)]">
                  Version <span className="font-semibold">{updater.version}</span> is available.
                </span>
              )}
              {updater.phase === "downloading" && <span className="text-[var(--text-2)]">Downloading update…</span>}
              {updater.phase === "error" && <span className="text-[var(--error)]">{updater.error}</span>}
            </div>
            {updater.phase === "available" ? (
              <Button variant="primary" onClick={() => void updater.install()}>
                <Download size={16} /> Install &amp; restart
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => void updater.check(true)}
                disabled={updater.phase === "checking" || updater.phase === "downloading"}
              >
                <RefreshCw size={16} /> Check for updates
              </Button>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
