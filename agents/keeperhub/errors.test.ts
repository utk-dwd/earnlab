import { describe, it, expect } from "vitest";
import { asKeeperhubError } from "./utils/errors.js";
import { KeeperhubError } from "./types.js";

describe("asKeeperhubError", () => {
  it("returns KeeperhubError as-is", () => {
    const err = new KeeperhubError("test", 400);
    expect(asKeeperhubError(err)).toBe(err);
  });

  it("wraps Error with original message and cause", () => {
    const err = new Error("something broke");
    const result = asKeeperhubError(err);
    expect(result).toBeInstanceOf(KeeperhubError);
    expect(result.message).toBe("something broke");
    expect(result.status).toBe(500);
    expect(result.cause).toBe(err);
  });

  it("wraps non-Error values", () => {
    const result = asKeeperhubError("string error");
    expect(result.message).toBe("Unknown error");
    expect(result.status).toBe(500);
  });
});