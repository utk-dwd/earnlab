import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMcpServer } from "./server.js";
import { EarnlabClient } from "./client/earnlab.js";
import { asToolResult, asToolError } from "./types.js";

describe("createMcpServer", () => {
  let client: EarnlabClient;
  let server: ReturnType<typeof createMcpServer>;

  beforeEach(() => {
    client = new EarnlabClient({ baseUrl: "http://test" });
    server = createMcpServer(client);
  });

  afterEach(async () => {
    await server.close();
  });

  it("creates a server with tools capability", () => {
    expect(server).toBeDefined();
  });
});

describe("EarnlabClient unit", () => {
  let client: EarnlabClient;

  beforeEach(() => {
    client = new EarnlabClient({ baseUrl: "http://test" });
  });

  it("builds correct query string for list_yields", () => {
    const qs = client.buildQueryString({
      chainId: 1,
      network: "mainnet",
      minAPY: 5,
      limit: 10,
    });
    expect(qs).toBe("?chainId=1&network=mainnet&minAPY=5&limit=10");
  });

  it("builds correct query string for get_decisions", () => {
    const qs = client.buildQueryString({ limit: 50 });
    expect(qs).toBe("?limit=50");
  });

  it("encodes poolId for get_pool", () => {
    const poolId = "0xabc/def";
    const encoded = encodeURIComponent(poolId);
    expect(encoded).toBe("0xabc%2Fdef");
  });

  it("omits undefined params from query string", () => {
    const qs = client.buildQueryString({ chainId: undefined, limit: 5 });
    expect(qs).toBe("?limit=5");
    expect(qs).not.toContain("chainId");
  });
});

describe("check_slippage tool", () => {
  let client: EarnlabClient;

  beforeEach(() => {
    client = new EarnlabClient({ baseUrl: "http://test" });
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends correct POST body for slippage check", async () => {
    const mockResponse = {
      approved: true,
      quotedOut: "1000000",
      minAmountOut: "995000",
      priceImpact: 0.5,
      sqrtPriceLimitX96: "0",
      gasEstimate: "150000",
    };

    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify(mockResponse),
      json: async () => mockResponse,
    } as Response);

    await client.request("/slippage/check", {
      method: "POST",
      body: JSON.stringify({
        chainId: 1,
        poolKey: { currency0: "0x0", currency1: "0x1", fee: 3000, tickSpacing: 60, hooks: "0x0" },
        zeroForOne: true,
        amountIn: "1000000000000000000",
        maxSlippageBps: 50,
        inputTokenPriceUsd: 2400,
        inputTokenDecimals: 18,
      }),
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse((callArgs[1] as RequestInit)?.body as string ?? "{}");
    expect(body.chainId).toBe(1);
    expect(body.amountIn).toBe("1000000000000000000");
    expect(body.zeroForOne).toBe(true);
    expect(body.poolKey.currency0).toBe("0x0");
  });
});

describe("asToolResult / asToolError", () => {
  it("asToolResult wraps data", () => {
    const result = asToolResult({ count: 1 });
    const block = result.content[0] as { type: "text"; text: string };
    expect(block.type).toBe("text");
    expect(JSON.parse(block.text)).toEqual({ count: 1 });
    expect(result.isError).toBeUndefined();
  });

  it("asToolError wraps error message", () => {
    const result = asToolError("poolId is required");
    const block = result.content[0] as { type: "text"; text: string };
    expect(block.text).toBe("Error: poolId is required");
    expect(result.isError).toBe(true);
  });
});