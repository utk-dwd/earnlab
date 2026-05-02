import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EarnlabClient } from "./earnlab.js";
import { asToolResult, asToolError } from "../types.js";

describe("EarnlabClient", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("builds correct query string from params", () => {
    const client = new EarnlabClient({ baseUrl: "http://test" });
    const qs = client.buildQueryString({ chainId: 1, limit: 10, network: undefined });
    expect(qs).toBe("?chainId=1&limit=10");
  });

  it("returns empty query string when no params", () => {
    const client = new EarnlabClient({ baseUrl: "http://test" });
    const qs = client.buildQueryString({});
    expect(qs).toBe("");
  });

  it("makes a successful GET request", async () => {
    const client = new EarnlabClient({ baseUrl: "http://test", timeoutMs: 5000 });
    const mockResponse = { count: 2, data: [{ poolId: "0x1" }] };

    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify(mockResponse),
      json: async () => mockResponse,
    } as Response);

    const result = await client.request("/yields");
    expect(result).toEqual(mockResponse);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://test/yields",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("throws on non-2xx response", async () => {
    const client = new EarnlabClient({ baseUrl: "http://test" });

    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => "Not found",
    } as Response);

    await expect(client.request("/yields")).rejects.toThrow("EarnYld API 404");
  });

  it("throws on timeout", async () => {
    const client = new EarnlabClient({ baseUrl: "http://test", timeoutMs: 10 });

    vi.mocked(globalThis.fetch).mockImplementation(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => {
            const err = new Error("The operation was aborted");
            (err as any).name = "AbortError";
            reject(err);
          }, 20);
        })
    );

    await expect(client.request("/yields")).rejects.toThrow("EarnYld API timed out");
  });

  it("throws on connection refused", async () => {
    const client = new EarnlabClient({ baseUrl: "http://test" });

    const err = new Error("fetch failed");
    (err as any).code = "ECONNREFUSED";
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(err);

    await expect(client.request("/yields")).rejects.toThrow("EarnYld API unreachable");
  });
});

describe("asToolResult", () => {
  it("wraps data in MCP content format", () => {
    const result = asToolResult({ foo: "bar" });
    expect(result.content).toHaveLength(1);
    const block = result.content[0] as { type: "text"; text: string };
    expect(block.type).toBe("text");
    expect(JSON.parse(block.text)).toEqual({ foo: "bar" });
    expect(result.isError).toBeUndefined();
  });
});

describe("asToolError", () => {
  it("wraps error in MCP error format", () => {
    const result = asToolError("Something went wrong");
    expect(result.content).toHaveLength(1);
    const block = result.content[0] as { type: "text"; text: string };
    expect(block.text).toBe("Error: Something went wrong");
    expect(result.isError).toBe(true);
  });
});
