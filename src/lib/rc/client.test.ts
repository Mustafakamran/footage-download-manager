import { describe, it, expect, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { RcClient } from "./client";

// NOTE: the mock is reset at the top of each test body rather than in a
// `beforeEach` hook. Under Vitest 4 a `beforeEach` that touches this module
// mock spuriously fails the rejection test below; resetting in-body avoids it
// while still giving every test a clean mock.
describe("RcClient", () => {
  it("routes coreVersion through the rc_call command", async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ version: "v1.69.1", os: "darwin", arch: "arm64", goVersion: "go1.24" });
    const v = await new RcClient().coreVersion();
    expect(v.version).toBe("v1.69.1");
    expect(invokeMock).toHaveBeenCalledWith("rc_call", { endpoint: "core/version", params: {} });
  });

  it("passes params through to rc_call", async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({});
    await new RcClient().call("operations/list", { fs: "drive:", remote: "" });
    expect(invokeMock).toHaveBeenCalledWith("rc_call", { endpoint: "operations/list", params: { fs: "drive:", remote: "" } });
  });

  it("propagates errors from rc_call", async () => {
    invokeMock.mockReset();
    invokeMock.mockRejectedValue(new Error("rclone not started"));
    await expect(new RcClient().coreVersion()).rejects.toThrow(/not started/);
  });
});
