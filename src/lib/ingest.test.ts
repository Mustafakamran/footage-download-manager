import { describe, it, expect, vi } from "vitest";

// downloadDir is only exercised in resolveDest; stub it so the module imports
// cleanly under vitest (no Tauri runtime).
vi.mock("@tauri-apps/api/path", () => ({ downloadDir: () => Promise.resolve("/Downloads") }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

import {
  accountIdForKind,
  itemForUrl,
  ingest,
  YTDLP_ACCOUNT_ID,
  type IngestPayload,
} from "./ingest";
import { HTTP_ACCOUNT_ID } from "../store/transfers";

describe("accountIdForKind", () => {
  it("maps media -> yt-dlp", () => {
    expect(accountIdForKind("media")).toBe(YTDLP_ACCOUNT_ID);
    expect(accountIdForKind("media")).toBe("ytdlp");
  });
  it("maps file -> http", () => {
    expect(accountIdForKind("file")).toBe(HTTP_ACCOUNT_ID);
    expect(accountIdForKind("file")).toBe("http");
  });
});

describe("itemForUrl", () => {
  it("derives a filename from the URL path", () => {
    const it1 = itemForUrl("https://example.com/path/clip.mp4?token=abc");
    expect(it1.name).toBe("clip.mp4");
    expect(it1.path).toBe("");
    expect(it1.isDir).toBe(false);
    expect(it1.size).toBe(0);
    expect(it1.id).toBe("https://example.com/path/clip.mp4?token=abc");
  });
  it("falls back to 'download' for path-less URLs", () => {
    expect(itemForUrl("https://example.com").name).toBe("download");
  });
});

describe("ingest", () => {
  it("enqueues media on the ytdlp account and toasts the name", async () => {
    const enqueue = vi.fn();
    const pushToast = vi.fn();
    const payload: IngestPayload = { url: "https://youtu.be/abc/video.mp4", kind: "media" };
    await ingest(payload, { enqueue, pushToast, dest: () => Promise.resolve("/dest") });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [accountId, items, dest] = enqueue.mock.calls[0];
    expect(accountId).toBe("ytdlp");
    expect(items[0].name).toBe("video.mp4");
    expect(dest).toBe("/dest");
    expect(pushToast).toHaveBeenCalledWith("Added from browser: video.mp4");
  });

  it("enqueues file kinds on the http account", async () => {
    const enqueue = vi.fn();
    await ingest(
      { url: "https://host/a/file.zip", kind: "file" },
      { enqueue, pushToast: vi.fn(), dest: () => Promise.resolve("/d") },
    );
    expect(enqueue.mock.calls[0][0]).toBe("http");
  });

  it("ignores blank URLs", async () => {
    const enqueue = vi.fn();
    await ingest({ url: "   ", kind: "file" }, { enqueue, pushToast: vi.fn() });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
