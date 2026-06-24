import { useState } from "react";
import { Loader2, X } from "lucide-react";
import { addAccount, getSecret, SECRET_KEYS, type Provider } from "../lib/tauri/commands";
import { providerName } from "./icons";
import { useApp } from "../store/app";
import { useToasts } from "../store/toast";
import { useIndex } from "../store/index-store";
import { useAccountMeta } from "../store/account-meta";
import { useUI } from "../store/ui";
import { Button, TextField, Card } from "./ui";

interface Props {
  provider: Provider;
  onClose: () => void;
}

type Phase = "form" | "missing-creds" | "waiting" | "error";

export function AddAccountDialog({ provider, onClose }: Props) {
  const [label, setLabel] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState("");
  const { loadAccounts, selectAccount } = useApp();
  const openSettings = useUI((s) => s.openSettings);
  const toast = useToasts((s) => s.push);

  async function submit() {
    if (!label.trim()) return;
    const keys = SECRET_KEYS[provider];
    const [clientId, clientSecret] = await Promise.all([getSecret(keys.id), getSecret(keys.secret)]);
    if (!clientId || !clientSecret) {
      setPhase("missing-creds");
      return;
    }
    setPhase("waiting");
    try {
      const account = await addAccount(provider, label.trim(), clientId, clientSecret);
      useAccountMeta.getState().setLabel(account.id, label.trim()); // keep original casing
      await loadAccounts();
      toast(`Connected ${providerName(provider)} · ${label.trim()}`, "success");
      void useIndex.getState().ensure(account); // start crawling/indexing in the background
      selectAccount(account.id);
      onClose();
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20"
      role="dialog"
      aria-modal="true"
    >
      <Card className="animate-rise w-[420px] p-5 shadow-[var(--shadow-lg)]">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--text)]">
            Connect {providerName(provider)}
          </h2>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            <X size={16} />
          </Button>
        </div>

        {phase === "waiting" ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <Loader2 className="animate-spin text-[var(--accent)]" size={24} />
            <p className="text-sm text-[var(--text-2)]">
              Waiting for browser sign-in… approve access in the window that opened. To add a
              different account than the one you're already signed into, choose
              <span className="text-[var(--text)]"> “Use another account”</span>.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <TextField
              label="Account label"
              placeholder="e.g. Client A"
              value={label}
              autoFocus
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />

            {phase === "missing-creds" && (
              <p className="text-sm text-[var(--warning)]">
                Set your {providerName(provider)} API credentials in Settings first.{" "}
                <button
                  className="underline"
                  onClick={() => {
                    openSettings();
                    onClose();
                  }}
                >
                  Open Settings
                </button>
              </p>
            )}

            {phase === "error" && <p className="text-sm text-[var(--error)]">{error}</p>}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" onClick={submit} disabled={!label.trim()}>
                Connect
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
