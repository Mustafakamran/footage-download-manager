// FDM Downloader — content script
//
// Runs on every page. Two jobs:
//   (a) Decorate DIRECT download links (anchors whose href ends in a known
//       downloadable extension) with a small, tasteful "⬇ FDM" button that
//       appears on hover and sends { url, kind:"file" } to the background.
//   (b) On known media/social sites OR any page that has a <video>, show a
//       floating "Download video with FDM" pill that sends
//       { url: location.href, kind:"media" }.
//
// All UI is rendered inside a single closed-ish ShadowRoot host appended to
// <html>, so the page's CSS can't clobber our styling and ours can't leak.

(function () {
  "use strict";

  // Guard against double-injection (e.g. bfcache restores, manual re-inject).
  if (window.__fdmDownloaderInjected) return;
  window.__fdmDownloaderInjected = true;

  // --------------------------------------------------------------------------
  // Config
  // --------------------------------------------------------------------------

  const DOWNLOADABLE_EXTS = new Set([
    // archives
    "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz",
    // video
    "mp4", "mov", "mkv", "webm", "avi", "flv", "m4v", "wmv", "mpg", "mpeg",
    // audio
    "mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "aiff",
    // docs
    "pdf", "epub", "mobi",
    // disk images / installers
    "dmg", "exe", "iso", "msi", "pkg", "deb", "rpm", "appimage", "apk",
    // images / design
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "svg",
    "psd", "ai", "eps", "raw", "cr2", "nef", "arw", "dng",
    // data / misc
    "csv", "json", "xml", "sql", "bin", "img",
  ]);

  // Hostnames where a whole-page "media" download (yt-dlp) makes sense.
  const MEDIA_HOSTS = [
    "youtube.com", "youtu.be", "m.youtube.com",
    "instagram.com",
    "tiktok.com",
    "x.com", "twitter.com", "mobile.twitter.com",
    "facebook.com", "fb.watch", "m.facebook.com",
    "vimeo.com",
    "dailymotion.com",
    "twitch.tv",
    "reddit.com",
    "soundcloud.com",
    "bilibili.com",
    "pinterest.com",
    "linkedin.com",
  ];

  // --------------------------------------------------------------------------
  // Messaging
  // --------------------------------------------------------------------------

  function send(url, kind, onResult) {
    try {
      chrome.runtime.sendMessage({ type: "fdm:send", url, kind }, (res) => {
        // chrome.runtime.lastError is read to avoid "Unchecked runtime.lastError".
        const err = chrome.runtime.lastError;
        if (typeof onResult === "function") onResult(err ? { ok: false } : res);
      });
    } catch (_) {
      if (typeof onResult === "function") onResult({ ok: false });
    }
  }

  // --------------------------------------------------------------------------
  // Shadow host + styles
  // --------------------------------------------------------------------------

  const host = document.createElement("div");
  host.id = "fdm-downloader-host";
  // Keep the host itself out of the page's layout/flow entirely.
  host.style.cssText =
    "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; }

    .fdm-btn {
      position: absolute;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font: 600 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #fff;
      background: linear-gradient(180deg, #3b82f6, #2563eb);
      border: 1px solid rgba(0,0,0,.15);
      border-radius: 6px;
      padding: 4px 7px;
      cursor: pointer;
      box-shadow: 0 2px 6px rgba(0,0,0,.25);
      white-space: nowrap;
      user-select: none;
      pointer-events: auto;
      opacity: 0;
      transform: translateY(-2px);
      transition: opacity .12s ease, transform .12s ease, background .12s ease;
    }
    .fdm-btn.fdm-show { opacity: 1; transform: translateY(0); }
    .fdm-btn:hover { background: linear-gradient(180deg, #2563eb, #1d4ed8); }
    .fdm-btn:active { transform: translateY(1px); }
    .fdm-btn.fdm-ok   { background: linear-gradient(180deg, #22c55e, #16a34a); }
    .fdm-btn.fdm-fail { background: linear-gradient(180deg, #ef4444, #dc2626); }

    .fdm-pill {
      position: fixed;
      right: 18px;
      bottom: 18px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #fff;
      background: linear-gradient(180deg, #3b82f6, #2563eb);
      border: 1px solid rgba(0,0,0,.18);
      border-radius: 999px;
      padding: 10px 16px;
      cursor: pointer;
      box-shadow: 0 6px 20px rgba(0,0,0,.3);
      pointer-events: auto;
      user-select: none;
      transition: background .15s ease, transform .15s ease, opacity .15s ease;
    }
    .fdm-pill:hover { transform: translateY(-1px); }
    .fdm-pill:active { transform: translateY(0); }
    .fdm-pill.fdm-ok   { background: linear-gradient(180deg, #22c55e, #16a34a); }
    .fdm-pill.fdm-fail { background: linear-gradient(180deg, #ef4444, #dc2626); }
    .fdm-pill .fdm-x {
      margin-left: 2px;
      opacity: .8;
      font-weight: 700;
      padding: 0 2px;
      border-radius: 4px;
    }
    .fdm-pill .fdm-x:hover { opacity: 1; background: rgba(255,255,255,.18); }
    .fdm-ico { font-size: 13px; line-height: 1; }
  `;
  shadow.appendChild(style);

  const layer = document.createElement("div");
  layer.className = "fdm-layer";
  shadow.appendChild(layer);

  function mountHost() {
    if (!host.isConnected) {
      (document.documentElement || document.body).appendChild(host);
    }
  }

  // --------------------------------------------------------------------------
  // (a) Direct-link hover buttons
  // --------------------------------------------------------------------------

  // We use ONE shared button element that follows the hovered anchor. This is
  // far lighter than injecting a button per-link on large pages.
  const linkBtn = document.createElement("button");
  linkBtn.className = "fdm-btn";
  linkBtn.type = "button";
  linkBtn.innerHTML = `<span class="fdm-ico">⬇</span><span>FDM</span>`;
  layer.appendChild(linkBtn);

  let currentAnchor = null;
  let hideTimer = null;

  function isDownloadableHref(href) {
    if (!href) return false;
    let u;
    try {
      u = new URL(href, location.href);
    } catch (_) {
      return false;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    // Strip query/hash, take the last path segment's extension.
    const path = u.pathname;
    const lastDot = path.lastIndexOf(".");
    if (lastDot < 0) return false;
    const ext = path.slice(lastDot + 1).toLowerCase();
    return DOWNLOADABLE_EXTS.has(ext);
  }

  function positionButton(anchor) {
    const r = anchor.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    // Place at the top-right corner of the anchor, nudged slightly outward.
    const btnW = 56; // approx; exact width not critical
    let left = r.right - btnW;
    let top = r.top - 4;
    // Keep it on-screen. Coordinates are viewport-relative: the layer lives
    // inside a position:fixed host, so absolute offsets match
    // getBoundingClientRect() directly (no scroll offset needed).
    left = Math.max(2, Math.min(left, window.innerWidth - btnW - 2));
    top = Math.max(2, top);
    linkBtn.style.left = `${left}px`;
    linkBtn.style.top = `${top}px`;
    return true;
  }

  function showButtonFor(anchor) {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    currentAnchor = anchor;
    mountHost();
    linkBtn.classList.remove("fdm-ok", "fdm-fail");
    linkBtn.innerHTML = `<span class="fdm-ico">⬇</span><span>FDM</span>`;
    if (positionButton(anchor)) {
      linkBtn.classList.add("fdm-show");
    }
  }

  function scheduleHide() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      linkBtn.classList.remove("fdm-show");
      currentAnchor = null;
    }, 220);
  }

  // Delegate hover detection on the document.
  document.addEventListener(
    "mouseover",
    (e) => {
      const anchor = e.target && e.target.closest && e.target.closest("a[href]");
      if (anchor && isDownloadableHref(anchor.href)) {
        showButtonFor(anchor);
      }
    },
    true
  );

  document.addEventListener(
    "mouseout",
    (e) => {
      // Only hide if we're leaving the anchor and not entering the button.
      const to = e.relatedTarget;
      if (to && (to === linkBtn || (to.closest && to.closest("#fdm-downloader-host")))) return;
      const anchor = e.target && e.target.closest && e.target.closest("a[href]");
      if (anchor && anchor === currentAnchor) scheduleHide();
    },
    true
  );

  linkBtn.addEventListener("mouseenter", () => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  });
  linkBtn.addEventListener("mouseleave", scheduleHide);

  linkBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!currentAnchor) return;
    const url = currentAnchor.href;
    linkBtn.innerHTML = `<span class="fdm-ico">…</span><span>FDM</span>`;
    send(url, "file", (res) => {
      if (res && res.ok) {
        linkBtn.classList.add("fdm-ok");
        linkBtn.innerHTML = `<span class="fdm-ico">✓</span><span>Sent</span>`;
      } else {
        linkBtn.classList.add("fdm-fail");
        linkBtn.innerHTML = `<span class="fdm-ico">✕</span><span>Failed</span>`;
      }
      setTimeout(() => {
        linkBtn.classList.remove("fdm-ok", "fdm-fail");
        linkBtn.classList.remove("fdm-show");
        currentAnchor = null;
      }, 1400);
    });
  });

  // Keep the button glued to its anchor while scrolling.
  window.addEventListener(
    "scroll",
    () => {
      if (currentAnchor && linkBtn.classList.contains("fdm-show")) {
        if (!positionButton(currentAnchor)) {
          linkBtn.classList.remove("fdm-show");
          currentAnchor = null;
        }
      }
    },
    true
  );

  // --------------------------------------------------------------------------
  // (b) Floating media pill
  // --------------------------------------------------------------------------

  let pill = null;

  function isMediaHost() {
    const h = location.hostname.replace(/^www\./, "");
    return MEDIA_HOSTS.some((m) => h === m || h.endsWith("." + m));
  }

  function pageHasVideo() {
    // A real, sized <video>, not a 0x0 tracking pixel.
    const vids = document.querySelectorAll("video");
    for (const v of vids) {
      const r = v.getBoundingClientRect();
      if (r.width >= 120 && r.height >= 80) return true;
    }
    return false;
  }

  function shouldShowPill() {
    return isMediaHost() || pageHasVideo();
  }

  function buildPill() {
    if (pill) return;
    pill = document.createElement("div");
    pill.className = "fdm-pill";
    pill.innerHTML =
      `<span class="fdm-ico">⬇</span><span class="fdm-label">Download video with FDM</span>` +
      `<span class="fdm-x" title="Hide">✕</span>`;
    layer.appendChild(pill);
    mountHost();

    const label = pill.querySelector(".fdm-label");

    pill.addEventListener("click", (e) => {
      // The little ✕ dismisses the pill for this page load.
      if (e.target && e.target.classList.contains("fdm-x")) {
        e.stopPropagation();
        removePill();
        pillDismissed = true;
        return;
      }
      const url = location.href;
      label.textContent = "Sending…";
      send(url, "media", (res) => {
        if (res && res.ok) {
          pill.classList.add("fdm-ok");
          label.textContent = "Sent to FDM ✓";
        } else {
          pill.classList.add("fdm-fail");
          label.textContent = "Failed — is FDM running?";
        }
        setTimeout(() => {
          if (!pill) return;
          pill.classList.remove("fdm-ok", "fdm-fail");
          label.textContent = "Download video with FDM";
        }, 2200);
      });
    });
  }

  function removePill() {
    if (pill && pill.parentNode) pill.parentNode.removeChild(pill);
    pill = null;
  }

  let pillDismissed = false;

  function refreshPill() {
    if (pillDismissed) return;
    if (shouldShowPill()) buildPill();
    else removePill();
  }

  // --------------------------------------------------------------------------
  // SPA awareness: observe DOM mutations + URL changes (debounced).
  // --------------------------------------------------------------------------

  let lastUrl = location.href;
  let debounceTimer = null;

  function onMaybeChanged() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        // New "page" in an SPA — re-evaluate the pill from scratch.
        pillDismissed = false;
      }
      refreshPill();
    }, 400);
  }

  const observer = new MutationObserver(onMaybeChanged);
  function startObserving() {
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      // body not ready yet
      document.addEventListener("DOMContentLoaded", () => {
        observer.observe(document.body, { childList: true, subtree: true });
      });
    }
  }

  // Patch history methods so SPA navigations trigger a re-check.
  ["pushState", "replaceState"].forEach((fn) => {
    const orig = history[fn];
    history[fn] = function () {
      const ret = orig.apply(this, arguments);
      window.dispatchEvent(new Event("fdm:locationchange"));
      return ret;
    };
  });
  window.addEventListener("popstate", onMaybeChanged);
  window.addEventListener("fdm:locationchange", onMaybeChanged);

  // --------------------------------------------------------------------------
  // Boot
  // --------------------------------------------------------------------------

  function boot() {
    mountHost();
    startObserving();
    refreshPill();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
