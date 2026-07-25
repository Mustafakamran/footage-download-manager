import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
const EDGE_MARGIN = 8; // px kept clear of the viewport edge

interface TipAnchor {
  text: string;
  rect: DOMRect;
  side: "top" | "bottom";
}

export function TooltipLayer() {
  const [tip, setTip] = useState<TipAnchor | null>(null);
  // Final, edge-clamped position — computed from the tooltip's OWN measured
  // size (see the layout effect below), not a guessed width. Null until that
  // measurement lands, which a layout effect guarantees happens before paint.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
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
      setPos(null);
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
        // The anchor may have unmounted (or be mid-morph) during the delay —
        // don't show a stale tooltip at a bogus position.
        if (!found.el.isConnected) return;
        const rect = found.el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        // Prefer above; flip below when there isn't room.
        const side: TipAnchor["side"] = rect.top > 56 ? "top" : "bottom";
        setTip({ text: found.text, rect, side });
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

  // Clamp against the tooltip's ACTUAL rendered box, not a guessed half-width —
  // a fixed margin let long tooltips run off-screen at the left/right/top edges.
  // Runs before paint, so there's no visible jump from the unclamped position.
  useLayoutEffect(() => {
    if (!tip) return;
    const box = tipRef.current?.getBoundingClientRect();
    if (!box) return;
    const centerX = tip.rect.left + tip.rect.width / 2;
    const left = Math.min(
      Math.max(centerX, EDGE_MARGIN + box.width / 2),
      window.innerWidth - EDGE_MARGIN - box.width / 2,
    );
    const rawTop = tip.side === "top" ? tip.rect.top - GAP - box.height : tip.rect.bottom + GAP;
    const top = Math.min(Math.max(rawTop, EDGE_MARGIN), window.innerHeight - EDGE_MARGIN - box.height);
    setPos({ left, top });
  }, [tip]);

  if (!tip) return null;
  // Before the first measurement lands, render at a reasonable (unclamped)
  // guess so tipRef has a box to measure; the layout effect corrects it
  // synchronously pre-paint, so this guess is never actually shown.
  const left = pos?.left ?? tip.rect.left + tip.rect.width / 2;
  const top = pos?.top ?? (tip.side === "top" ? tip.rect.top - GAP : tip.rect.bottom + GAP);
  return createPortal(
    <div
      ref={tipRef}
      role="tooltip"
      className="animate-tip pointer-events-none fixed z-[200] max-w-[260px] rounded-[7px] bg-[var(--text)] px-2 py-1 text-[11.5px] font-medium leading-snug text-[var(--bg)] shadow-[var(--shadow)]"
      style={{
        left,
        top,
        transform: pos ? "translateX(-50%)" : `translateX(-50%) translateY(${tip.side === "top" ? "-100%" : "0"})`,
      }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}
