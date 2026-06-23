import type { ButtonHTMLAttributes, CSSProperties, InputHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "ghost" | "danger";

const variants: Record<Variant, string> = {
  primary:
    "bg-[var(--accent)] font-semibold text-[var(--accent-ink)] shadow-[0_4px_14px_var(--accent-glow)] hover:bg-[var(--accent-hover)] active:translate-y-px",
  ghost:
    "bg-transparent text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)] active:translate-y-px",
  danger: "bg-transparent text-[var(--text-3)] hover:bg-[var(--hover)] hover:text-[var(--error)]",
};

export function Button({
  variant = "ghost",
  className = "",
  children,
  ...rest
}: { variant?: Variant; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`focus-accent inline-flex items-center gap-2 rounded-[7px] px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 disabled:active:translate-y-0 ${variants[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function TextField({
  label,
  className = "",
  ...rest
}: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-[var(--text-2)]">{label}</span>
      <input
        className={`focus-accent rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-3)] ${className}`}
        {...rest}
      />
    </label>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] shadow-[var(--shadow-sm)] ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * A shimmering placeholder block shown while real content loads. Prefer this
 * over a bare spinner for list/row loading — it hints at the shape of what's
 * coming, which reads as faster. Pass width/height via className (e.g. `h-4 w-32`).
 */
export function Skeleton({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return <div aria-hidden className={`skeleton ${className}`} style={style} />;
}
