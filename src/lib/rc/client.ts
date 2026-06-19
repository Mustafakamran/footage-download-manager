import { invoke } from "@tauri-apps/api/core";
import type { CoreVersion } from "./types";

export class RcClient {
  /** Generic rc call routed through the Rust core (avoids CORS; creds stay in Rust). */
  call<T>(endpoint: string, params: Record<string, unknown> = {}): Promise<T> {
    return invoke<T>("rc_call", { endpoint, params });
  }

  coreVersion(): Promise<CoreVersion> {
    return this.call<CoreVersion>("core/version");
  }
}
