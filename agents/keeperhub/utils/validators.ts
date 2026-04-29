import { KeeperhubError, TemplateInputs } from "../types";

export function requireBaseUrl(baseUrl: string): string {
  if (!baseUrl) throw new KeeperhubError("earnlabBaseUrl is required", 400);
  try {
    const parsed = new URL(baseUrl);
    if (!parsed.protocol.startsWith("http")) {
      throw new KeeperhubError("earnlabBaseUrl must be http(s)", 400);
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    throw new KeeperhubError("earnlabBaseUrl is invalid", 400);
  }
}

export function validateTemplateInputs(inputs: TemplateInputs): TemplateInputs {
  if (!inputs.minAPY || inputs.minAPY <= 0) {
    throw new KeeperhubError("minAPY must be > 0", 400);
  }
  if (!inputs.notifyTarget) {
    throw new KeeperhubError("notifyTarget is required", 400);
  }
  return inputs;
}
