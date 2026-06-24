import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Global custom-tooltip layer. Mount ONCE near the app root.
 *
 * Instead of forcing every call site to adopt a <Tooltip> wrapper, this watches
 * the document for hover/focus on any element carrying `data-tip` — OR a native
 * `title`. When it sees a `title`, it moves the text to `data-tip` and strips the
 * attribute, which both suppresses the browser's native (ugly, un-themed, slow)
 * tooltip and lets every existing `title="…"` in the app render as our styled
 * tooltip with zero code changes elsewhere.
 */

const SHOW_DELAY = 350; // ms hover-intent before showing
const GAP = 8; // px between target and tooltip

interface TipState {
  text: string;
  x: number; // viewport px (tooltip is position:fixed)
  y: number;
  side: "top" | "bottom";
}

export function TooltipLayer() {
  const [tip, setTip] = useState<TipState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const clear = () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
    const hide = () => {
      clear();
      setTip(null);
    };

    // Resolve the nearest ancestor that should show a tooltip, normalizing a
    // native `title` into `data-tip` (so the native tooltip never appears).
    const tipTarget = (start: EventTarget | null): { el: HTMLElement; text: string } | null => {
      let el = start instanceof Element ? (start as HTMLElement) : null;
      el = el?.closest<HTMLElement>("[data-tip], [title]") ?? null;
      if (!el) return null;
      const native = el.getAttribute("title");
      if (native) {
        el.setAttribute("data-tip", native);
        el.removeAttribute("title");
      }
      const text = el.getAttribute("data-tip")?.trim();
      if (!text) return null;
      return { el, text };
    };

    const show = (start: EventTarget | null) => {
      const found = tipTarget(start);
      if (!found) return;
      clear();
      timer.current = setTimeout(() => {
        const r = found.el.getBoundingClientRect();
        // Prefer above; flip below when there isn't room.
        const side: TipState["side"] = r.top > 56 ? "top" : "bottom";
        const y = side === "top" ? r.top - GAP : r.bottom + GAP;
        const x = Math.min(Math.max(r.left + r.width / 2, 60), window.innerWidth - 60);
        setTip({ text: found.text, x, y, side });
      }, SHOW_DELAY);
    };

    const onOver = (e: MouseEvent) => show(e.target);
    const onOut = () => hide();
    const onFocus = (e: FocusEvent) => show(e.target);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };

    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onOut);
    // Any scroll/wheel/resize invalidates the anchor position — just dismiss.
    document.addEventListener("scroll", hide, true);
    window.addEventListener("wheel", hide, { passive: true });
    window.addEventListener("resize", hide);
    document.addEventListener("keydown", onKey);
    return () => {
      clear();
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onOut);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("wheel", hide);
      window.removeEventListener("resize", hide);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  if (!tip) return null;
  return createPortal(
    <div
      ref={tipRef}
      role="tooltip"
      className="animate-tip pointer-events-none fixed z-[200] max-w-[260px] -translate-x-1/2 rounded-[7px] bg-[var(--text)] px-2 py-1 text-[11.5px] font-medium leading-snug text-[var(--bg)] shadow-[var(--shadow)]"
      style={{
        left: tip.x,
        top: tip.y,
        transform: `translateX(-50%) translateY(${tip.side === "top" ? "-100%" : "0"})`,
      }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}
