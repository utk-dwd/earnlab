import { describe, it, expect } from "vitest";
import { validateTemplateInputs, requireBaseUrl } from "./utils/validators.js";

describe("validateTemplateInputs", () => {
  const base = {
    earnlabBaseUrl: "http://localhost:3001",
    minAPY: 5,
    notifyTarget: "https://hooks.discord.com/fake",
    notifyProvider: "discord" as const,
  };

  it("accepts valid inputs", () => {
    expect(validateTemplateInputs(base)).toEqual(base);
  });

  it("accepts minAPY = 0 (retrieves all yields)", () => {
    expect(() => validateTemplateInputs({ ...base, minAPY: 0 })).not.toThrow();
  });

  it("rejects negative minAPY", () => {
    expect(() => validateTemplateInputs({ ...base, minAPY: -1 })).toThrow("minAPY must be > 0");
  });

  it("rejects missing notifyTarget", () => {
    expect(() => validateTemplateInputs({ ...base, notifyTarget: "" })).toThrow("notifyTarget is required");
  });
});

describe("requireBaseUrl", () => {
  it("accepts http URLs", () => {
    expect(requireBaseUrl("http://localhost:3001")).toBe("http://localhost:3001");
  });

  it("accepts https URLs", () => {
    expect(requireBaseUrl("https://api.example.com")).toBe("https://api.example.com");
  });

  it("strips trailing slash", () => {
    expect(requireBaseUrl("http://localhost:3001/")).toBe("http://localhost:3001");
  });

  it("rejects empty string", () => {
    expect(() => requireBaseUrl("")).toThrow("earnlabBaseUrl is required");
  });

  it("rejects non-http protocols", () => {
    expect(() => requireBaseUrl("ftp://bad")).toThrow("earnlabBaseUrl must be http(s)");
  });
});