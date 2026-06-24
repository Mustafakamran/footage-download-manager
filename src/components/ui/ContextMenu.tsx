import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Draw a divider above this item. */
  separator?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/**
 * Cursor-anchored context menu rendered in a portal. Clamps itself inside the
 * viewport after measuring, closes on click-outside / Esc / scroll / blur, and
 * routes keyboard focus so it's usable without a mouse.
 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y, ready: false });

  // Measure once mounted, then nudge in-bounds so the menu never clips off-screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx = Math.min(x, window.innerWidth - r.width - 8);
    const ny = Math.min(y, window.innerHeight - r.height - 8);
    setPos({ x: Math.max(8, nx), y: Math.max(8, ny), ready: true });
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onScroll = () => onClose();
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return createPortal(
    <>
      {/* Invisible full-screen catcher: any click/right-click outside closes. */}
      <div className="fixed inset-0 z-[150]" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        ref={ref}
        role="menu"
        className="animate-pop fixed z-[151] min-w-[190px] overflow-hidden rounded-[10px] border border-[var(--border-strong)] bg-[var(--surface)] py-1 shadow-[var(--shadow-lg)]"
        style={{ left: pos.x, top: pos.y, visibility: pos.ready ? "visible" : "hidden" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {items.map((it, i) => (
          <div key={i}>
            {it.separator && <div className="my-1 h-px bg-[var(--border)]" />}
            <button
              role="menuitem"
              disabled={it.disabled}
              onClick={() => {
                if (it.disabled) return;
                onClose();
                it.onClick();
              }}
              className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] disabled:opacity-40 ${
                it.danger
                  ? "text-[var(--error)] hover:bg-[var(--error)]/12"
                  : "text-[var(--text)] hover:bg-[var(--hover)]"
              }`}
            >
              {it.icon && <it.icon size={15} className="shrink-0 opacity-80" />}
              <span className="truncate">{it.label}</span>
            </button>
          </div>
        ))}
      </div>
    </>,
    document.body,
  );
}
