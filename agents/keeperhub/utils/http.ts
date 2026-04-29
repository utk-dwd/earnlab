import { KeeperhubError } from "../types";

const DEFAULT_TIMEOUT_MS = 10_000;

export async function getJson<T>(
  url: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new KeeperhubError(`HTTP ${res.status}`, res.status, text);
    }
    return (await res.json()) as T;
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new KeeperhubError("Request timed out", 504);
    }
    if (err instanceof KeeperhubError) throw err;
    throw new KeeperhubError("HTTP request failed", 502, err?.message);
  } finally {
    clearTimeout(timeout);
  }
}
