import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { useTransfers } from "./transfers";
import type { JobStatus, DownloadItem } from "../lib/tauri/commands";

function item(name: string): DownloadItem {
  return { path: name, name, isDir: false, size: 1000 };
}
function job(over: Partial<JobStatus>): JobStatus {
  return {
    jobId: 1, accountId: "drive_x", name: "a", dest: "/dest", totalBytes: 1000, bytes: 0,
    speed: 0, eta: null, finished: false, success: false, cancelled: false, error: "", ...over,
  };
}

let nextJobId = 1;
let listReturns: JobStatus[] = [];

beforeEach(() => {
  invokeMock.mockReset();
  localStorage.clear();
  nextJobId = 1;
  listReturns = [];
  useTransfers.setState({ jobs: [], queue: [], concurrency: 1, dockOpen: true });
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "start_download") return Promise.resolve([job({ jobId: nextJobId++ })]);
    if (cmd === "list_jobs") return Promise.resolve(listReturns);
    return Promise.resolve(undefined);
  });
});

afterEach(() => useTransfers.getState().stopPolling());

describe("transfers queue", () => {
  it("starts one at a time at concurrency 1, leaving the rest queued", async () => {
    useTransfers.getState().enqueue("drive_x", [item("a"), item("b")], "/dest");
    await vi.waitFor(() => expect(useTransfers.getState().jobs).toHaveLength(1));
    expect(useTransfers.getState().queue).toHaveLength(1); // "b" still waiting
  });

  it("starts the next queued item when a slot frees", async () => {
    useTransfers.getState().enqueue("drive_x", [item("a"), item("b")], "/dest");
    await vi.waitFor(() => expect(useTransfers.getState().jobs).toHaveLength(1));

    // First job completes; a refresh frees the slot and pump starts "b".
    listReturns = [job({ jobId: 1, finished: true, success: true })];
    await useTransfers.getState().refresh();
    await vi.waitFor(() => expect(useTransfers.getState().jobs.length).toBe(2));
    expect(useTransfers.getState().queue).toHaveLength(0);
  });

  it("removes a queued item before it starts", async () => {
    useTransfers.getState().enqueue("drive_x", [item("a"), item("b")], "/dest");
    await vi.waitFor(() => expect(useTransfers.getState().queue).toHaveLength(1));
    const qid = useTransfers.getState().queue[0].id;
    useTransfers.getState().removeQueued(qid);
    expect(useTransfers.getState().queue).toHaveLength(0);
  });
});
