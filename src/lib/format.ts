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

/** Short date for the file table; invalid → "—". */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
