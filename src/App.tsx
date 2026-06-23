import { useEffect, useRef } from "react";
import { AppShell } from "./components/AppShell";
import { useApp } from "./store/app";
import { useUpdater } from "./store/updater";
import { useToasts } from "./store/toast";
import { useTransfers } from "./store/transfers";
import { startWatching, stopWatching } from "./lib/watcher";
import { startIngestListener } from "./lib/ingest";

/** Re-check for an OTA update on this cadence so a release pushed while the app
 *  is open surfaces on its own (not just at launch / on a manual check). */
const UPDATE_POLL_MS = 30 * 60 * 1000; // 30 min

export default function App() {
  const loadAccounts = useApp((s) => s.loadAccounts);

  useEffect(() => {
    loadAccounts()
      .then(() => {
        // Daemon is up and accounts are loaded — resume any downloads that were
        // queued or in flight when the app last closed (torrent-style).
        useTransfers.getState().resume();
      })
      .catch(() => {
        /* daemon may not be ready on first paint; AccountsView shows empty state */
      });
    startWatching();
    // Listen for browser-extension captures (Rust emits "ingest-url" on a valid
    // POST /fdm/ingest) and enqueue them into the default download folder.
    const stopIngest = startIngestListener();
    // Check for an OTA update shortly after launch (silent if none / no runtime),
    // then on an interval so a release pushed while the app is open is noticed.
    const launch = setTimeout(() => void useUpdater.getState().check(), 3000);
    const poll = setInterval(() => void useUpdater.getState().check(), UPDATE_POLL_MS);
    return () => {
      clearTimeout(launch);
      clearInterval(poll);
      stopWatching();
      stopIngest();
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
          Update <span className="font-semibold">{version}</span> available —{" "}
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
