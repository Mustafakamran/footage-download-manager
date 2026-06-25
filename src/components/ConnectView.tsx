import { useState } from "react";
import { Plus } from "lucide-react";
import { AddAccountDialog } from "./AddAccountDialog";
import { Card, Button } from "./ui";
import { LogoMark } from "./ui/Logo";
import { ProviderIcon, providerName } from "./icons";
import type { Provider } from "../lib/tauri/commands";

export function ConnectView() {
  const [provider, setProvider] = useState<Provider | null>(null);
  return (
    <div className="flex h-full items-center justify-center p-8">
      <Card className="flex max-w-md flex-col items-center gap-5 px-10 py-14 text-center">
        <LogoMark size={64} />
        <div>
          <p className="text-[20px] font-bold tracking-[-0.02em] text-[var(--ink)]">
            F<span className="text-[var(--mut)]">DM</span>
          </p>
          <p className="mt-0.5 font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--faint)]">Fast Download Manager</p>
          <p className="mt-3 max-w-sm text-[13.5px] leading-relaxed text-[var(--mut)]">
            Connect a Google Drive or Dropbox account to browse and download the footage shared with you.
          </p>
        </div>
        <div className="flex gap-2.5">
          {(["drive", "dropbox"] as Provider[]).map((p) => (
            <Button key={p} variant="primary" onClick={() => setProvider(p)}>
              <Plus size={15} /> <ProviderIcon provider={p} size={16} /> {providerName(p)}
            </Button>
          ))}
        </div>
      </Card>
      {provider && <AddAccountDialog provider={provider} onClose={() => setProvider(null)} />}
    </div>
  );
}
