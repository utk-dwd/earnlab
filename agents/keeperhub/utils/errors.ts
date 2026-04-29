import { KeeperhubError } from "../types";

export function asKeeperhubError(err: unknown): KeeperhubError {
  if (err instanceof KeeperhubError) return err;
  const message = err instanceof Error ? err.message : "Unknown error";
  return new KeeperhubError(message, 500);
}
