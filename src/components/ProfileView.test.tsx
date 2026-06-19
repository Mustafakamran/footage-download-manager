import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { ProfileView } from "./ProfileView";
import { useApp } from "../store/app";
import type { Account } from "../lib/tauri/commands";

const account: Account = { id: "drive_x", provider: "drive", label: "x" };

const folder = [
  { Name: "FolderA", Path: "FolderA", Size: -1, IsDir: true, ModTime: "", MimeType: "inode/directory" },
  { Name: "a.mxf", Path: "a.mxf", Size: 1000, IsDir: false, ModTime: "2026-01-02T00:00:00Z", MimeType: "video/mxf" },
  { Name: "b.mxf", Path: "b.mxf", Size: 2000, IsDir: false, ModTime: "2026-01-03T00:00:00Z", MimeType: "video/mxf" },
];

beforeEach(() => {
  invokeMock.mockReset();
  useApp.setState({ accounts: [account], openTabs: ["drive_x"], view: { kind: "profile", id: "drive_x" } });
  invokeMock.mockImplementation((cmd: string, args?: { params?: { remote?: string } }) => {
    if (cmd === "rc_call") {
      const remote = args?.params?.remote ?? "";
      if (remote === "") return Promise.resolve({ list: folder });
      return Promise.resolve({ list: [] });
    }
    return Promise.resolve({});
  });
});

describe("ProfileView", () => {
  it("renders items with sizes and computes the selection total", async () => {
    render(<ProfileView id="drive_x" />);

    await waitFor(() => expect(screen.queryByText("FolderA")).not.toBeNull());
    expect(screen.queryByText("a.mxf")).not.toBeNull();
    expect(screen.queryByText("1000 B")).not.toBeNull();
    expect(screen.queryByText("2.0 KB")).not.toBeNull(); // 2000 B, KB uses 1 decimal

    fireEvent.click(screen.getByLabelText("Select a.mxf"));
    fireEvent.click(screen.getByLabelText("Select b.mxf"));

    // 1000 + 2000 = 3000 bytes -> 2.9 KB (KB = 1 decimal)
    expect(screen.queryByText(/2\.9 KB/)).not.toBeNull();
    expect(screen.queryByText(/Selected:/)).not.toBeNull();
  });

  it("navigates into a directory (lists with the dir path)", async () => {
    render(<ProfileView id="drive_x" />);
    await waitFor(() => expect(screen.queryByText("FolderA")).not.toBeNull());

    fireEvent.click(screen.getByText("FolderA"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "rc_call",
        expect.objectContaining({ endpoint: "operations/list", params: expect.objectContaining({ remote: "FolderA" }) }),
      );
    });
  });
});
