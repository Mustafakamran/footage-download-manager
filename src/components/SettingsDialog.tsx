import { useEffect } from "react";
import { X } from "lucide-react";
import { useUI } from "../store/ui";
import { SettingsView } from "./SettingsView";

export function SettingsDialog() {
  const { settingsOpen, closeSettings } = useUI();

  // Esc closes the dialog (standard dialog affordance).
  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeSettings();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [settingsOpen, closeSettings]);

  if (!settingsOpen) return null;
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center overflow-auto bg-black/20 p-6"
      onClick={closeSettings}
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
    >
      <div
        className="animate-rise relative my-auto max-h-[88vh] w-full max-w-2xl overflow-auto rounded-[14px] border border-[var(--border-strong)] bg-[var(--surface)] shadow-[var(--shadow-lg)]"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={closeSettings}
          aria-label="Close settings"
          data-tip="Close (Esc)"
          className="absolute right-4 top-5 z-10 flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-3)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          <X size={16} />
        </button>
        <SettingsView />
      </div>
    </div>
  );
}
