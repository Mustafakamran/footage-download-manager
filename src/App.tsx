import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { AppShell } from "./components/AppShell";
import { useApp } from "./store/app";
import { useUpdater } from "./store/updater";
import { useToasts } from "./store/toast";
import { useTransfers } from "./store/transfers";
import { startWatching, stopWatching } from "./lib/watcher";
import { startIngestListener, resolveDest } from "./lib/ingest";

/** Queue a magnet link (from the OS handler) into the default download folder. */
async function queueMagnet(url: string) {
  const m = url.trim();
  if (!m.toLowerCase().startsWith("magnet:")) return;
  const dest = await resolveDest();
  if (!dest) { useToasts.getState().push("Set a download folder in Settings first", "error"); return; }
  useTransfers.getState().enqueueUrl(m, dest);
  useToasts.getState().push("Queued torrent", "success");
}

/** Re-check for an OTA update on this cadence so a release pushed while the app
 *  is open surfaces on its own (not just at launch / on a manual check). */
const UPDATE_POLL_MS = 30 * 60 * 1000; // 30 min

export default function App() {
  const loadAccounts = useApp((s) => s.loadAccounts);

  useEffect(() => {
    const boot = () =>
      loadAccounts()
        .then(() => {
          // Daemon is up and accounts are loaded — resume any downloads that were
          // queued or in flight when the app last closed (torrent-style).
          useTransfers.getState().resume();
        })
        .catch(() => {
          /* daemon may not be ready on first paint; AccountsView shows empty state */
        });
    // Try immediately (covers the warm path where rcd is already up), then again
    // when the Rust side finishes starting the daemon in the background. Startup
    // I/O is now off the main thread (no launch freeze), so the daemon can come
    // up a few seconds after first paint — this re-load fills in the accounts.
    void boot();
    const readyUnlisten = listen("rclone-ready", () => void boot());
    startWatching();
    // Listen for browser-extension captures (Rust emits "ingest-url" on a valid
    // POST /fdm/ingest) and enqueue them into the default download folder.
    const stopIngest = startIngestListener();
    // When the window is closed to the tray (Rust emits "app-hidden"), pause any
    // playing media — otherwise a review video keeps its audio going (and HLS
    // keeps transcoding) with no visible UI to stop it.
    const hiddenUnlisten = listen("app-hidden", () => {
      document.querySelectorAll<HTMLMediaElement>("video, audio").forEach((el) => el.pause());
    });
    // Magnet links opened from the OS (FDM registered as the magnet: handler):
    // drain any captured at launch, then listen for live ones.
    void invoke<string[]>("take_pending_magnets").then((urls) => urls?.forEach((u) => void queueMagnet(u))).catch(() => {});
    const magnetUnlisten = listen<string>("open-magnet", (ev) => void queueMagnet(ev.payload));
    // Check for an OTA update shortly after launch (silent if none / no runtime),
    // then on an interval so a release pushed while the app is open is noticed.
    const launch = setTimeout(() => void useUpdater.getState().check(), 3000);
    const poll = setInterval(() => void useUpdater.getState().check(), UPDATE_POLL_MS);
    return () => {
      clearTimeout(launch);
      clearInterval(poll);
      stopWatching();
      stopIngest();
      void readyUnlisten.then((un) => un());
      void hiddenUnlisten.then((un) => un());
      void magnetUnlisten.then((un) => un());
    };
  }, [loadAccounts]);

  // When the updater finds a NEW available version, nudge the user with a toast
  // whose action installs it. Track the last-notified version so the same
  // release doesn't re-toast on every poll. The UpdateBanner stays as well.
  const pushToast = useToasts((s) => s.push);
  const notified = useRef<string>("");
  useEffect(() => {
    return useUpdater.subscribe((state, prev) => {
      const becameAvailable = state.phase === "available" && prev.phase !== "available";
      if (!becameAvailable) return;
      const version = state.version;
      if (!version || notified.current === version) return;
      notified.current = version;
      pushToast(
        <span>
          Update <span className="font-semibold">{version}</span> available ·{" "}
          <button
            onClick={() => void useUpdater.getState().install()}
            className="font-semibold text-[var(--accent)] underline-offset-2 hover:underline"
          >
            click to install
          </button>
        </span>,
        "info",
        8000,
      );
    });
  }, [pushToast]);

  return <AppShell />;
}
