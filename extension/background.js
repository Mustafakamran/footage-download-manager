// FDM Downloader — background service worker (MV3)
//
// Responsibilities:
//   - Hold the shared config (pairing token + loopback port).
//   - Receive { url, kind } messages from content.js and the popup.
//   - POST them to FDM's loopback ingest server with the X-FDM-Token header.
//   - Provide the right-click "Download with FDM" context menu.
//   - Surface success / failure / not-paired state via the toolbar badge
//     and (where available) desktop notifications.
//
// The shared contract with the FDM desktop app:
//   GET  http://127.0.0.1:<port>/fdm/ping    -> 200 { ok:true, version }
//   POST http://127.0.0.1:<port>/fdm/ingest  -> 200 { ok:true } | 401
//        body:    { url, kind:"file"|"media" }
//        header:  X-FDM-Token: <token>

const DEFAULT_PORT = 53713;
const DEFAULT_HOST = "127.0.0.1";

// ----------------------------------------------------------------------------
// Config helpers
// ----------------------------------------------------------------------------

async function getConfig() {
  const { fdmToken = "", fdmPort = DEFAULT_PORT } = await chrome.storage.local.get([
    "fdmToken",
    "fdmPort",
  ]);
  const port = Number(fdmPort) || DEFAULT_PORT;
  return { token: fdmToken, port };
}

function baseUrl(port) {
  return `http://${DEFAULT_HOST}:${port || DEFAULT_PORT}`;
}

// ----------------------------------------------------------------------------
// Badge helpers (transient toast-like feedback on the toolbar icon)
// ----------------------------------------------------------------------------

let badgeTimer = null;

function flashBadge(text, color, ttlMs = 2500) {
  try {
    chrome.action.setBadgeBackgroundColor({ color });
    chrome.action.setBadgeText({ text });
    if (badgeTimer) clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => {
      chrome.action.setBadgeText({ text: "" });
    }, ttlMs);
  } catch (_) {
    /* setBadge* can throw if the action is gone; ignore. */
  }
}

const badgeOk = () => flashBadge("✓", "#16a34a");
const badgeFail = () => flashBadge("!", "#dc2626", 4000);
const badgeSending = () => flashBadge("…", "#2563eb", 8000);

function notify(title, message) {
  // Notifications are best-effort; the permission may be denied by the user.
  if (!chrome.notifications || !chrome.notifications.create) return;
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message,
    });
  } catch (_) {
    /* ignore */
  }
}

// ----------------------------------------------------------------------------
// FDM ingest
// ----------------------------------------------------------------------------

async function pingFdm(portOverride) {
  const { port } = await getConfig();
  const usePort = portOverride || port;
  const res = await fetch(`${baseUrl(usePort)}/fdm/ping`, {
    method: "GET",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`ping HTTP ${res.status}`);
  const data = await res.json().catch(() => ({}));
  return data; // { ok, version }
}

// Sends { url, kind } to FDM. Returns { ok, status, error? }.
async function sendToFdm({ url, kind }) {
  if (!url) return { ok: false, status: 0, error: "no-url" };

  const { token, port } = await getConfig();
  if (!token) {
    badgeFail();
    notify("FDM not paired", "Open the FDM Downloader popup and paste the pairing token from FDM Settings → Browser extension.");
    return { ok: false, status: 0, error: "no-token" };
  }

  const normalizedKind = kind === "media" ? "media" : "file";
  badgeSending();

  try {
    const res = await fetch(`${baseUrl(port)}/fdm/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-FDM-Token": token,
      },
      body: JSON.stringify({ url, kind: normalizedKind }),
    });

    if (res.status === 401) {
      badgeFail();
      notify("FDM rejected the token", "The pairing token is wrong. Re-copy it from FDM Settings → Browser extension.");
      return { ok: false, status: 401, error: "bad-token" };
    }

    if (!res.ok) {
      badgeFail();
      notify("FDM ingest failed", `The FDM app returned HTTP ${res.status}.`);
      return { ok: false, status: res.status, error: `http-${res.status}` };
    }

    badgeOk();
    return { ok: true, status: res.status };
  } catch (err) {
    // Almost always: FDM isn't running, or the port is wrong.
    badgeFail();
    notify("FDM isn't running", "Couldn't reach the FDM app on the loopback port. Start FDM and try again.");
    return { ok: false, status: 0, error: "unreachable" };
  }
}

// ----------------------------------------------------------------------------
// Message routing (content.js + popup.js)
// ----------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  switch (msg.type) {
    case "fdm:send": {
      sendToFdm({ url: msg.url, kind: msg.kind }).then(sendResponse);
      return true; // async
    }
    case "fdm:ping": {
      pingFdm(msg.port)
        .then((data) => sendResponse({ ok: true, ...data }))
        .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
      return true; // async
    }
    default:
      return; // not ours
  }
});

// ----------------------------------------------------------------------------
// Context menus
// ----------------------------------------------------------------------------

function rebuildContextMenus() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "fdm-link",
      title: "Download with FDM",
      contexts: ["link"],
    });
    chrome.contextMenus.create({
      id: "fdm-media",
      title: "Download video/audio with FDM",
      contexts: ["video", "audio"],
    });
    chrome.contextMenus.create({
      id: "fdm-page",
      title: "Download this page's video with FDM",
      contexts: ["page", "selection"],
    });
  });
}

chrome.runtime.onInstalled.addListener(rebuildContextMenus);
chrome.runtime.onStartup.addListener(rebuildContextMenus);

chrome.contextMenus &&
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "fdm-link") {
      // A direct file link.
      const url = info.linkUrl;
      sendToFdm({ url, kind: "file" });
    } else if (info.menuItemId === "fdm-media") {
      // A <video>/<audio> element: prefer its src, fall back to the page URL.
      const url = info.srcUrl || info.pageUrl || (tab && tab.url);
      sendToFdm({ url, kind: "media" });
    } else if (info.menuItemId === "fdm-page") {
      // Whole-page social/video download via yt-dlp.
      const url = info.pageUrl || (tab && tab.url);
      sendToFdm({ url, kind: "media" });
    }
  });
