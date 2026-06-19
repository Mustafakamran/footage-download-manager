import { describe, it, expect } from "vitest";
import { buildIndex } from "./account-index";
import type { RcItem } from "./rc/browse";

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
