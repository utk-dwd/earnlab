import { describe, it, expect } from "vitest";
import { KeeperhubError } from "./types.js";

describe("KeeperhubError", () => {
  it("sets status and message", () => {
    const err = new KeeperhubError("not found", 404);
    expect(err.message).toBe("not found");
    expect(err.status).toBe(404);
    expect(err.details).toBeUndefined();
    expect(err.cause).toBeUndefined();
  });

  it("sets details and cause", () => {
    const cause = new Error("root");
    const err = new KeeperhubError("bad", 400, "field required", cause);
    expect(err.status).toBe(400);
    expect(err.details).toBe("field required");
    expect(err.cause).toBe(cause);
  });

  it("defaults status to 500", () => {
    const err = new KeeperhubError("oops");
    expect(err.status).toBe(500);
  });

  it("is instanceof Error and KeeperhubError", () => {
    const err = new KeeperhubError("test");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(KeeperhubError);
  });
});