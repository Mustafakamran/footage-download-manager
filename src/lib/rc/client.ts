import type { RcConnection, CoreVersion } from "./types";

export class RcClient {
  constructor(private readonly conn: RcConnection) {}

  private authHeader(): string {
    return "Basic " + btoa(`${this.conn.user}:${this.conn.pass}`);
  }

  /** Generic rc POST. All rclone rc calls are POST with a JSON body. */
  async call<T>(endpoint: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`${this.conn.base_url}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: this.authHeader() },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`rc ${endpoint} failed: ${res.status} ${detail}`);
    }
    return (await res.json()) as T;
  }

  coreVersion(): Promise<CoreVersion> {
    return this.call<CoreVersion>("core/version");
  }
}
