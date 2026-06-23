# FDM Downloader — Browser Extension

A dependency-free Manifest V3 extension (Chrome / Edge / any Chromium browser)
that sends download links straight to the **FDM** desktop app.

- **Direct files** (`.zip`, `.mp4`, `.pdf`, `.dmg`, …): hover any download link and
  click the small **⬇ FDM** button, or right-click → **Download with FDM**.
- **Social / video pages** (YouTube, Instagram, TikTok, X/Twitter, Facebook,
  Vimeo, …) or any page with a real `<video>`: click the floating
  **Download video with FDM** pill, or right-click → **Download this page's
  video with FDM**. These run through FDM's bundled yt-dlp engine.

The extension never downloads anything itself — it just hands the URL to the
FDM app over a loopback connection. FDM does the actual downloading into your
default download folder.

---

## Install (Load unpacked)

1. Open your browser's extensions page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
2. Turn on **Developer mode** (top-right toggle in Chrome; left sidebar in Edge).
3. Click **Load unpacked** and select this **`extension/`** folder.
4. The **FDM Downloader** icon (a blue ⬇) appears in the toolbar. Pin it if you like.

## Pair with FDM

The extension and the FDM app share a secret **pairing token** so that only your
browser can hand URLs to your FDM.

1. Open **FDM → Settings → Browser extension** and copy the **pairing token**.
2. Click the **FDM Downloader** toolbar icon to open its popup.
3. Paste the token into **Pairing token**.
4. Leave **Port** at the default **53713** (only change it if FDM logged that the
   port was taken and chose another).
5. Click **Save**, then **Test connection**. You should see
   *"Connected to FDM"*.

That's it. Browse normally and use the ⬇ buttons / pills / right-click menu.

---

## How it works (shared contract)

FDM runs a small HTTP server bound to `127.0.0.1` (loopback only) on a fixed
port, **53713**:

| Method | Path          | Purpose                                                            |
| ------ | ------------- | ------------------------------------------------------------------ |
| `GET`  | `/fdm/ping`   | Detect FDM + check it's reachable. Returns `{ ok:true, version }`. |
| `POST` | `/fdm/ingest` | Accept a download. Body `{ url, kind:"file"\|"media" }`.           |

Every `POST /fdm/ingest` carries the header `X-FDM-Token: <token>`. FDM compares
it (constant-time) against its stored token and returns **401** if it's wrong.
On success FDM maps the request to a download:

- `kind:"media"` → yt-dlp engine (social / video sites)
- `kind:"file"` → direct streaming HTTP download

The file lands in FDM's **default download folder** (or your OS Downloads folder
as a fallback).

CORS is open (`Access-Control-Allow-Origin: *`) with OPTIONS preflight handled,
so the extension's background service worker can call the loopback server.

---

## Files

| File             | Role                                                                       |
| ---------------- | -------------------------------------------------------------------------- |
| `manifest.json`  | MV3 manifest (permissions, content script, background worker, popup).      |
| `background.js`  | Service worker: holds token+port, POSTs to FDM, context menus, badges.     |
| `content.js`     | On-page UI: hover ⬇ buttons on direct links + floating media pill (SPA-aware, shadow-DOM isolated). |
| `popup.html` / `popup.js` | Pairing UI: token field, port, Save, Test connection.             |
| `icons/`         | Toolbar / store icons (16/32/48/128) + `icon.svg` source.                  |

---

## Troubleshooting

- **Toolbar badge shows `!` / "FDM isn't running"** — start the FDM desktop app,
  then retry. Confirm with **Test connection** in the popup.
- **"FDM rejected the token" / 401** — re-copy the token from
  **FDM → Settings → Browser extension** and paste it again (no extra spaces).
- **Wrong port** — if FDM logged that port 53713 was taken, set the port in the
  popup to whatever FDM reported, then Save + Test.
- **No ⬇ button on a link** — the button only appears for links whose URL ends in
  a known downloadable extension. For anything else, use **right-click →
  Download with FDM**.
- **Pill won't reappear after I dismissed it (✕)** — reload the page; the pill is
  dismissed only for the current page view.

## Privacy

The extension talks **only** to `http://127.0.0.1:53713` (your own machine).
No data is sent anywhere else. The pairing token is stored in
`chrome.storage.local` on your device.
