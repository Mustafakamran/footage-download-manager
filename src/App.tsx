import { useEffect, useState } from "react";
import { RcClient } from "./lib/rc/client";

export default function App() {
  const [version, setVersion] = useState<string>("connecting…");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const v = await new RcClient().coreVersion();
        setVersion(`${v.version} (${v.os}/${v.arch})`);
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-3">
      <h1 className="text-xl font-semibold text-[#e6e8eb]">Downloader — engine check</h1>
      {error ? (
        <p className="text-red-400 font-mono text-sm">{error}</p>
      ) : (
        <p className="text-[#9ba1a8] font-mono text-sm">rclone {version}</p>
      )}
    </main>
  );
}
