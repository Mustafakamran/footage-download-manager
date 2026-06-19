import { describe, it, expect, vi, beforeEach } from "vitest";
import { RcClient } from "./client";
import type { RcConnection } from "./types";

const conn: RcConnection = { base_url: "http://127.0.0.1:5572", user: "u", pass: "p" };

describe("RcClient", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("POSTs to the endpoint with basic auth and returns parsed JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: "v1.69.1", os: "darwin", arch: "arm64", goVersion: "go1.22" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new RcClient(conn);
    const v = await client.coreVersion();

    expect(v.version).toBe("v1.69.1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:5572/core/version");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Basic " + btoa("u:p"));
  });

  it("throws on non-ok responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" }));
    const client = new RcClient(conn);
    await expect(client.coreVersion()).rejects.toThrow(/500/);
  });
});
