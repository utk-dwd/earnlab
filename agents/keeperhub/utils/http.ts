import { KeeperhubError } from "../types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ERROR_DETAIL_CHARS = 500;

function sanitizeErrorDetail(text: string): string {
  // Strip ANSI escape codes and control characters
  const stripped = text
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/[\n\r\t]/g, " ");
  if (stripped.length <= MAX_ERROR_DETAIL_CHARS) return stripped;
  return `${stripped.slice(0, MAX_ERROR_DETAIL_CHARS - 3)}...`;
}

export async function getJson<T>(
  url: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  init?: RequestInit
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let cleanupSignalListener: (() => void) | undefined;

  if (init?.signal) {
    if (init.signal.aborted) {
      controller.abort();
    } else {
      const onAbort = () => controller.abort();
      init.signal.addEventListener("abort", onAbort);
      cleanupSignalListener = () =>
        init.signal!.removeEventListener("abort", onAbort);
    }
  }

  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new KeeperhubError(`HTTP ${res.status}`, res.status, sanitizeErrorDetail(text));
    }
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch (err: any) {
      const sanitizedText = sanitizeErrorDetail(text);
      const errorMessage = err?.message
        ? `${err.message}: ${sanitizedText}`
        : sanitizedText;
      throw new KeeperhubError("Invalid JSON response", 502, errorMessage);
    }
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new KeeperhubError("Request timed out", 408);
    }
    if (err instanceof KeeperhubError) throw err;
    throw new KeeperhubError("HTTP request failed", 502, err?.message);
  } finally {
    cleanupSignalListener?.();
    clearTimeout(timeout);
  }
}
