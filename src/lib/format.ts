const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** Human-readable byte size (base 1024). Negative/NaN → "—", 0 → "0 B". */
export function formatBytes(n: number): string {
  if (Number.isNaN(n) || n < 0) return "—";
  if (n === 0) return "0 B";
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), UNITS.length - 1);
  const val = n / Math.pow(1024, i);
  const decimals = i >= 2 ? 2 : i === 1 ? 1 : 0;
  return `${val.toFixed(decimals)} ${UNITS[i]}`;
}

/** Transfer speed, e.g. "910 MB/s". */
export function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec < 0) return "—";
  return `${formatBytes(bytesPerSec)}/s`;
}

/** ETA seconds → "1h 02m", "3m 20s", "12s", or "—". */
export function formatEta(seconds: number | null): string {
  if (seconds == null || seconds < 0 || !Number.isFinite(seconds)) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Short date for the file table; invalid or placeholder → "—". */
export function formatDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  // rclone returns a zero/placeholder time when the backend has none (Dropbox
  // folders, etc.) — surfaces as year 0001 or 2000. Treat anything implausibly
  // old as "no date" rather than showing a misleading value.
  if (Number.isNaN(d.getTime()) || d.getTime() < Date.UTC(2001, 0, 1)) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
