import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link2, Copy, Check, Loader2 } from "lucide-react";
import { driveShareLink, dropboxShareLink, type Account } from "../lib/tauri/commands";
import type { RcItem } from "../lib/rc/browse";

const W = 320; // flyout width

/**
 * "Copy link" flyout (Dropbox-style): an anchored morph popover — not a modal —
 * that grows from the click point. Fetches/creates an anyone-with-the-link share
 * URL for a Drive/Dropbox item and shows it with a Copy button. Drive shares by
 * file id; Dropbox by path.
 */
export function SharePopover({
  account, item, anchor, onClose,
}: { account: Account; item: RcItem; anchor?: { x: number; y: number }; onClose: () => void }) {
  // Defensive: fall back to screen centre if no anchor was supplied.
  const a = anchor ?? { x: window.innerWidth / 2, y: window.innerHeight / 3 };
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string }>({ left: a.x, top: a.y, origin: "top left" });

  useEffect(() => {
    let alive = true;
    const p =
      account.provider === "drive"
        ? item.ID
          ? driveShareLink(account.id, item.ID)
          : Promise.reject(new Error("This item has no Drive id to share."))
        : dropboxShareLink(account.id, item.Path);
    p.then((u) => alive && setUrl(u)).catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => { alive = false; };
  }, [account, item]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  // Clamp inside the viewport; flip the growth origin when near an edge.
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 120;
    const flipX = a.x + W + 12 > window.innerWidth;
    const flipY = a.y + h + 12 > window.innerHeight;
    const left = flipX ? Math.max(8, a.x - W) : a.x;
    const top = flipY ? Math.max(8, a.y - h) : a.y;
    setPos({ left, top, origin: `${flipY ? "bottom" : "top"} ${flipX ? "right" : "left"}` });
  }, [a.x, a.y, url, err]);

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setErr("Couldn’t write to the clipboard.");
    }
  };

  return createPortal(
    <>
      <div className="fixed inset-0 z-[200]" onMouseDown={onClose} />
      <div
        ref={ref}
        className="animate-pop fixed z-[201] rounded-[12px] border border-[var(--border-strong)] bg-[var(--surface)] p-3.5 shadow-[var(--shadow-lg)]"
        style={{ left: pos.left, top: pos.top, width: W, transformOrigin: pos.origin }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex min-w-0 items-center gap-2 text-[12.5px] font-semibold text-[var(--text)]">
          <Link2 size={14} className="shrink-0 text-[var(--accent)]" />
          <span className="shrink-0">Copy link</span>
          <span className="truncate font-normal text-[var(--text-3)]">· {item.Name}</span>
        </div>

        <div className="mt-3">
          {err ? (
            <p className="text-[12px] leading-relaxed text-[var(--error)]">{err}</p>
          ) : url == null ? (
            <div className="flex items-center gap-2 py-1 text-[12.5px] text-[var(--text-2)]">
              <Loader2 size={14} className="animate-spin" /> Creating link…
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={url}
                onFocus={(e) => e.currentTarget.select()}
                className="min-w-0 flex-1 rounded-[8px] border border-[var(--border)] bg-[var(--card)] px-2.5 py-1.5 text-[12px] text-[var(--text-2)] focus-accent"
              />
              <button
                onClick={copy}
                className="flex shrink-0 items-center gap-1.5 rounded-[8px] bg-[var(--accent)] px-2.5 py-1.5 text-[12px] font-semibold text-[var(--accent-ink)] transition active:translate-y-px"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
              </button>
            </div>
          )}
        </div>

        {!err && <p className="mt-2.5 text-[10.5px] text-[var(--faint)]">Anyone with this link can view.</p>}
      </div>
    </>,
    document.body,
  );
}
