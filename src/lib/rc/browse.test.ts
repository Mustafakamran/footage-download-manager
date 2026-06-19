import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { buildFs, listFolder, type RcItem } from "./browse";
import type { Account } from "../tauri/commands";

const drive: Account = { id: "drive_x", provider: "drive", label: "x" };
const dropbox: Account = { id: "dropbox_y", provider: "dropbox", label: "y" };

function item(p: Partial<RcItem>): RcItem {
  return { Name: "", Path: "", Size: 0, IsDir: false, ModTime: "", MimeType: "", ...p };
}

describe("buildFs", () => {
  it("adds shared_with_me for drive, plain for dropbox", () => {
    expect(buildFs(drive)).toBe("drive_x,shared_with_me=true:");
    expect(buildFs(dropbox)).toBe("dropbox_y:");
  });
});

describe("listFolder", () => {
  beforeEach(() => invokeMock.mockReset());

  it("sorts dirs first then alphabetical, and tolerates missing list", async () => {
    invokeMock.mockResolvedValue({
      list: [
        item({ Name: "zeta.mxf", Path: "zeta.mxf" }),
        item({ Name: "Beta", Path: "Beta", IsDir: true }),
        item({ Name: "alpha.mxf", Path: "alpha.mxf" }),
        item({ Name: "Alpha", Path: "Alpha", IsDir: true }),
      ],
    });
    const out = await listFolder(drive, "");
    expect(out.map((i) => i.Name)).toEqual(["Alpha", "Beta", "alpha.mxf", "zeta.mxf"]);

    invokeMock.mockResolvedValue({});
    expect(await listFolder(drive, "")).toEqual([]);
  });
});
