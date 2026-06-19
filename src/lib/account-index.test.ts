import { describe, it, expect } from "vitest";
import { buildIndex, recentFiles, itemAt } from "./account-index";
import type { RcItem } from "./rc/browse";

function f(path: string, size: number, mod: string): RcItem {
  return { Name: path.split("/").pop()!, Path: path, Size: size, IsDir: false, ModTime: mod, MimeType: "" };
}
function d(path: string): RcItem {
  return { Name: path.split("/").pop()!, Path: path, Size: -1, IsDir: true, ModTime: "", MimeType: "" };
}

const flat = [
  d("A"),
  d("A/sub"),
  f("A/sub/clip1.mxf", 1000, "2026-01-02T00:00:00Z"),
  f("A/clip2.mxf", 500, "2026-03-01T00:00:00Z"),
  f("root.mxf", 10, "2026-01-01T00:00:00Z"),
];

describe("buildIndex", () => {
  it("builds a tree and recursive aggregates (size, newest date, count)", () => {
    const idx = buildIndex(flat);
    expect(idx.tree[""].map((i) => i.Name)).toEqual(["A", "root.mxf"]);
    expect(idx.tree["A"].map((i) => i.Name)).toEqual(["sub", "clip2.mxf"]);
    expect(idx.agg["A"].size).toBe(1500);
    expect(idx.agg["A"].latest).toBe("2026-03-01T00:00:00Z");
    expect(idx.agg["A"].fileCount).toBe(2);
    expect(idx.agg["A/sub"].size).toBe(1000);
  });
});

describe("recentFiles / itemAt", () => {
  it("returns files newest-first and resolves an item by path", () => {
    const idx = buildIndex(flat);
    expect(recentFiles(idx).map((f) => f.Name)).toEqual(["clip2.mxf", "clip1.mxf", "root.mxf"]);
    expect(itemAt(idx, "A/clip2.mxf")?.Name).toBe("clip2.mxf");
    expect(itemAt(idx, "nope")).toBeUndefined();
  });
});
