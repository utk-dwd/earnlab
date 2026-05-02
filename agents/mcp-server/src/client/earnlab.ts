import { EarnlabClientConfig } from "../types.js";

export class EarnlabClient {
  private baseUrl: string;
  private timeoutMs: number;

  constructor(config: Partial<EarnlabClientConfig> = {}) {
    this.baseUrl = (config.baseUrl ?? process.env.EARNYLD_API_URL ?? "http://localhost:3001").replace(/\/$/, "");
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`EarnYld API ${res.status}: ${text.slice(0, 200)}`);
      }

      return (await res.json()) as T;
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error("EarnYld API timed out");
      }
      if (err.message?.includes("fetch failed") || err.code === "ECONNREFUSED") {
        throw new Error("EarnYld API unreachable");
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  buildQueryString(params: Record<string, string | number | boolean | undefined>): string {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    return qs ? `?${qs}` : "";
  }
}


