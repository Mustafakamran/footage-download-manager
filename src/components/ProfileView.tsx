import { useCallback, useEffect, useMemo, useState } from "react";
import { Folder, File as FileIcon, Download, Loader2, AlertCircle } from "lucide-react";
import { useApp } from "../store/app";
import { ProviderIcon, providerName } from "./icons";
import { Button } from "./ui";
import { listFolder, type RcItem } from "../lib/rc/browse";
import { formatBytes, formatDate } from "../lib/format";

export function ProfileView({ id }: { id: string }) {
  const account = useApp((s) => s.accounts.find((a) => a.id === id));

  const [path, setPath] = useState("");
  const [items, setItems] = useState<RcItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!account) return;
    setLoading(true);
    setError(null);
    try {
      setItems(await listFolder(account, path));
    } catch (e) {
      setError(String(e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [account, path]);

  useEffect(() => {
    setSelected(new Set());
    load();
  }, [load]);

  const files = useMemo(() => items.filter((i) => !i.IsDir), [items]);
  const totalSelected = useMemo(
    () => files.filter((f) => selected.has(f.Path)).reduce((sum, f) => sum + Math.max(0, f.Size), 0),
    [files, selected],
  );

  const rootLabel = account?.provider === "drive" ? "Shared with me" : "Home";
  const segments = path ? path.split("/") : [];

  function toggle(p: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(p) ? next.delete(p) : next.add(p);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === files.length && files.length > 0 ? new Set() : new Set(files.map((f) => f.Path)),
    );
  }

  if (!account) return <div className="p-8 text-sm text-[var(--text-2)]">Account not found.</div>;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 pt-6">
        <span className="text-[var(--text-2)]">
          <ProviderIcon provider={account.provider} size={18} />
        </span>
        <div>
          <h1 className="text-base font-semibold text-[var(--text)]">{account.label}</h1>
          <div className="text-xs text-[var(--text-3)]">{providerName(account.provider)}</div>
        </div>
      </div>

      {/* Breadcrumb */}
      <div className="flex flex-wrap items-center gap-1 px-6 py-3 text-sm">
        <button
          className="rounded px-1.5 py-0.5 text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          onClick={() => setPath("")}
        >
          {rootLabel}
        </button>
        {segments.map((seg, i) => (
          <span key={i} className="flex items-center gap-1">
            <span className="text-[var(--text-3)]">/</span>
            <button
              className="rounded px-1.5 py-0.5 text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
              onClick={() => setPath(segments.slice(0, i + 1).join("/"))}
            >
              {seg}
            </button>
          </span>
        ))}
      </div>

      {/* Table */}
      <div className="min-h-0 flex-1 overflow-auto px-6">
        {error && (
          <div className="mb-3 flex items-center gap-2 rounded-[6px] border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--error)]">
            <AlertCircle size={16} /> {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-12 text-sm text-[var(--text-2)]">
            <Loader2 className="animate-spin" size={16} /> Loading…
          </div>
        ) : items.length === 0 ? (
          <div className="py-12 text-sm text-[var(--text-2)]">This folder is empty.</div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--text-3)]">
                <th className="w-8 py-2">
                  {files.length > 0 && (
                    <input
                      type="checkbox"
                      aria-label="Select all files"
                      checked={selected.size === files.length && files.length > 0}
                      onChange={toggleAll}
                    />
                  )}
                </th>
                <th className="py-2 font-medium">Name</th>
                <th className="w-32 py-2 text-right font-medium">Size</th>
                <th className="w-32 py-2 font-medium">Modified</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.Path} className="border-b border-[var(--border)]/50 hover:bg-[var(--hover)]">
                  <td className="py-2">
                    {!item.IsDir && (
                      <input
                        type="checkbox"
                        aria-label={`Select ${item.Name}`}
                        checked={selected.has(item.Path)}
                        onChange={() => toggle(item.Path)}
                      />
                    )}
                  </td>
                  <td className="py-2">
                    {item.IsDir ? (
                      <button
                        className="flex items-center gap-2 text-[var(--text)] hover:text-[var(--accent)]"
                        onClick={() => setPath(item.Path)}
                      >
                        <Folder size={16} className="text-[var(--accent)]" />
                        <span className="truncate">{item.Name}</span>
                      </button>
                    ) : (
                      <span className="flex items-center gap-2 text-[var(--text)]">
                        <FileIcon size={16} className="text-[var(--text-3)]" />
                        <span className="truncate">{item.Name}</span>
                      </span>
                    )}
                  </td>
                  <td className="tnum py-2 text-right text-[var(--text-2)]">
                    {item.IsDir ? "—" : formatBytes(item.Size)}
                  </td>
                  <td className="py-2 text-[var(--text-3)]">{formatDate(item.ModTime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Selection summary bar */}
      {selected.size > 0 && (
        <div className="flex items-center justify-between border-t border-[var(--border)] bg-[var(--surface)] px-6 py-3">
          <span className="text-sm text-[var(--text-2)]">
            Selected: <span className="tnum text-[var(--text)]">{selected.size}</span> items ·{" "}
            <span className="tnum text-[var(--text)]">{formatBytes(totalSelected)}</span>
          </span>
          <Button variant="primary" disabled title="Downloads arrive in the next update">
            <Download size={16} /> Download
          </Button>
        </div>
      )}
    </div>
  );
}
