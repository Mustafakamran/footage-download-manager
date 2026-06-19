import { describe, it, expect, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { buildIndex, crawlAccount } from "./account-index";
import type { RcItem } from "./rc/browse";
import type { Account } from "./tauri/commands";

function f(path: string, size: number, mod: string): RcItem {
  return { Name: path.split("/").pop()!, Path: path, Size: size, IsDir: false, ModTime: mod, MimeType: "" };
}
function d(path: string): RcItem {
  return { Name: path.split("/").pop()!, Path: path, Size: -1, IsDir: true, ModTime: "", MimeType: "" };
}

describe("buildIndex", () => {
  it("builds a tree and recursive aggregates (size, newest date, count)", () => {
    const flat = [
      d("A"),
      d("A/sub"),
      f("A/sub/clip1.mxf", 1000, "2026-01-02T00:00:00Z"),
      f("A/clip2.mxf", 500, "2026-03-01T00:00:00Z"),
      f("root.mxf", 10, "2026-01-01T00:00:00Z"),
    ];
    const idx = buildIndex(flat, 123);

    // tree: dirs first, then files, alphabetical
    expect(idx.tree[""].map((i) => i.Name)).toEqual(["A", "root.mxf"]);
    expect(idx.tree["A"].map((i) => i.Name)).toEqual(["sub", "clip2.mxf"]);
    expect(idx.tree["A/sub"].map((i) => i.Name)).toEqual(["clip1.mxf"]);

    // recursive aggregate for A: 1000 + 500, newest = Mar 1, 2 files
    expect(idx.agg["A"].size).toBe(1500);
    expect(idx.agg["A"].latest).toBe("2026-03-01T00:00:00Z");
    expect(idx.agg["A"].fileCount).toBe(2);
    expect(idx.agg["A/sub"].size).toBe(1000);
    expect(idx.crawledAt).toBe(123);
  });
});

describe("crawlAccount", () => {
  it("does not double-prefix paths that rclone already returns root-relative", async () => {
    invokeMock.mockImplementation((_cmd: string, args?: { endpoint?: string; params?: { opt?: { recurse?: boolean } } }) => {
      if (args?.endpoint === "operations/list") {
        if (args.params?.opt?.recurse) {
          // rclone's recursive list returns full, root-relative paths
          return Promise.resolve({
            list: [{ Name: "clip.mxf", Path: "A/clip.mxf", Size: 100, IsDir: false, ModTime: "2026-01-01T00:00:00Z", MimeType: "" }],
          });
        }
        return Promise.resolve({ list: [{ Name: "A", Path: "A", Size: -1, IsDir: true, ModTime: "", MimeType: "" }] });
      }
      return Promise.resolve({});
    });

    const account: Account = { id: "drive_x", provider: "drive", label: "x" };
    const flat = await crawlAccount(account, () => {});
    const paths = flat.map((i) => i.Path);
    expect(paths).toContain("A/clip.mxf");
    expect(paths).not.toContain("A/A/clip.mxf");
  });
});
