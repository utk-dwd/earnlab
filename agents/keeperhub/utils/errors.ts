import { KeeperhubError } from "../types.js";

export function asKeeperhubError(err: unknown): KeeperhubError {
  if (err instanceof KeeperhubError) return err;
  const message = err instanceof Error ? err.message : "Unknown error";
  const wrapped = new KeeperhubError(message, 500, undefined, err);
  return wrapped;
}

