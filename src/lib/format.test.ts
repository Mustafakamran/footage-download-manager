import { describe, it, expect } from "vitest";
import { formatBytes, formatSpeed, formatEta, formatDate } from "./format";

describe("formatBytes", () => {
  it("handles zero, negative, and NaN", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(NaN)).toBe("—");
  });

  it("formats across units", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.00 GB");
    expect(formatBytes(2 * 1024 ** 4)).toBe("2.00 TB");
  });
});

describe("formatSpeed", () => {
  it("appends /s and handles zero", () => {
    expect(formatSpeed(0)).toBe("—");
    expect(formatSpeed(5 * 1024 * 1024)).toBe("5.00 MB/s");
  });
});

describe("formatDate", () => {
  it("shows '—' for empty, invalid, or placeholder dates", () => {
    expect(formatDate("")).toBe("—");
    expect(formatDate("not-a-date")).toBe("—");
    expect(formatDate("2000-01-01T00:00:00Z")).toBe("—"); // rclone placeholder
    expect(formatDate("0001-01-01T00:00:00Z")).toBe("—");
  });
  it("formats real dates", () => {
    expect(formatDate("2026-06-19T00:00:00Z")).toMatch(/2026/);
  });
});

describe("formatEta", () => {
  it("formats seconds, minutes, hours, and null", () => {
    expect(formatEta(null)).toBe("—");
    expect(formatEta(-1)).toBe("—");
    expect(formatEta(45)).toBe("45s");
    expect(formatEta(200)).toBe("3m 20s");
    expect(formatEta(3720)).toBe("1h 02m");
  });
});
