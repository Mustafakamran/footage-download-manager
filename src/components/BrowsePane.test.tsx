import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { BrowsePane } from "./BrowsePane";
import { useApp } from "../store/app";
import { useIndex } from "../store/index-store";
import { useBrowse } from "../store/browse";
import { useTransfers } from "../store/transfers";
import { useStarred } from "../store/starred";
import { useSearch } from "../store/search";
import { useSelection } from "../store/selection";
import { buildIndex } from "../lib/account-index";
import type { Account } from "../lib/tauri/commands";
import type { RcItem } from "../lib/rc/browse";

const account: Account = { id: "drive_x", provider: "drive", label: "x" };
function f(path: string, size: number): RcItem {
  return { Name: path.split("/").pop()!, Path: path, Size: size, IsDir: false, ModTime: "2026-01-02T00:00:00Z", MimeType: "" };
}
function d(path: string): RcItem {
  return { Name: path.split("/").pop()!, Path: path, Size: -1, IsDir: true, ModTime: "", MimeType: "" };
}
const flat = [d("FolderA"), f("FolderA/child.mxf", 5000), f("a.mxf", 1000), f("b.mxf", 2000)];

beforeEach(() => {
  invokeMock.mockReset();
  localStorage.clear();
  useApp.setState({ accounts: [account], view: { kind: "browse", accountId: "drive_x", section: "all", path: "" } });
  useIndex.setState({ byAccount: { drive_x: { status: "ready", progress: { done: 0, total: 0, files: 0 }, index: buildIndex(flat) } } });
  useBrowse.setState({ listings: {}, loading: {}, errors: {}, sizes: {} });
  useTransfers.setState({ jobs: [], queue: [], concurrency: 1, dockOpen: true });
  useStarred.setState({ byAccount: {} });
  useSearch.setState({ q: "" });
  useSelection.setState({ byAccount: {} });
  invokeMock.mockImplementation((cmd: string, args?: { endpoint?: string; params?: { remote?: string } }) => {
    if (cmd === "start_download") return Promise.resolve([]);
    if (cmd === "list_jobs") return Promise.resolve([]);
    // Live browse: the folder listing comes from rc_call/operations/list.
    if (cmd === "rc_call" && args?.endpoint === "operations/list") {
      const remote = args.params?.remote ?? "";
      return Promise.resolve({ list: remote ? [] : [d("FolderA"), f("a.mxf", 1000), f("b.mxf", 2000)] });
    }
    return Promise.resolve({});
  });
});

afterEach(() => useTransfers.getState().stopPolling());

describe("BrowsePane", () => {
  it("renders cached items with sizes and a selection total", async () => {
    render(<BrowsePane account={account} section="all" path="" />);
    const list = await screen.findByTestId("file-list");
    expect(within(list).queryByText("a.mxf")).not.toBeNull();
    expect(within(list).queryByText("1000 B")).not.toBeNull();
    expect(within(list).queryByText("2.0 KB")).not.toBeNull();

    fireEvent.click(screen.getByLabelText("Select a.mxf"));
    fireEvent.click(screen.getByLabelText("Select b.mxf"));
    expect(screen.queryByText(/2\.9 KB/)).not.toBeNull();
  });

  it("navigates into a folder by updating the view", async () => {
    render(<BrowsePane account={account} section="all" path="" />);
    const list = await screen.findByTestId("file-list");
    fireEvent.click(within(list).getByText("FolderA"));
    await waitFor(() => {
      const v = useApp.getState().view;
      expect(v.kind === "browse" && v.path).toBe("FolderA");
    });
  });

  it("prompts for a destination then downloads the selected files there", async () => {
    // Download now ALWAYS prompts for a folder (the dialog returns it here).
    const { open } = await import("@tauri-apps/plugin-dialog");
    (open as unknown as ReturnType<typeof vi.fn>).mockResolvedValue("/Volumes/EXT");
    render(<BrowsePane account={account} section="all" path="" />);
    await screen.findByTestId("file-list");
    fireEvent.click(screen.getByLabelText("Select a.mxf"));
    // Click the Download in the selection pill (the preview panel also has one).
    const pill = screen.getByText(/\bselected\b/).closest("div")!;
    fireEvent.click(within(pill).getByText("Download"));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "start_download",
        expect.objectContaining({
          accountId: "drive_x",
          dest: "/Volumes/EXT",
          items: [{ path: "a.mxf", name: "a.mxf", isDir: false, size: 1000, id: "" }],
        }),
      );
    });
  });
});
