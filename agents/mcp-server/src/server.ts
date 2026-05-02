import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { EarnlabClient } from "./client/earnlab.js";
import { asToolResult, asToolError } from "./types.js";

const YIELDS_TOOL: Tool = {
  name: "list_yields",
  description:
    "Get ranked Uniswap v4 yield opportunities from EarnYld. Returns pools sorted by effective net APY with risk metrics.",
  inputSchema: {
    type: "object",
    properties: {
      chainId: {
        type: "number",
        description: "Filter by chain ID (e.g. 1 for Ethereum, 8453 for Base)",
      },
      network: {
        type: "string",
        enum: ["mainnet", "testnet", "all"],
        description: "Filter by network environment",
      },
      minAPY: {
        type: "number",
        description: "Minimum display APY percentage",
      },
      limit: {
        type: "number",
        description: "Maximum number of results (1-100)",
      },
    },
  },
};

const GET_POOL_TOOL: Tool = {
  name: "get_pool",
  description: "Get detailed data for a single Uniswap v4 pool by its pool ID.",
  inputSchema: {
    type: "object",
    properties: {
      poolId: {
        type: "string",
        description: "Pool ID (keccak256 of pool key)",
      },
    },
    required: ["poolId"],
  },
};

const PORTFOLIO_TOOL: Tool = {
  name: "get_portfolio",
  description: "Get the current simulated portfolio summary from EarnYld.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

const POSITIONS_TOOL: Tool = {
  name: "get_positions",
  description: "Get open simulated liquidity positions from EarnYld.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

const TRADES_TOOL: Tool = {
  name: "get_trades",
  description: "Get the trade log from the EarnYld portfolio manager.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

const DECISIONS_TOOL: Tool = {
  name: "get_decisions",
  description: "Get LLM decision cycle history from EarnYld.",
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max decisions to return (1-50)",
      },
    },
  },
};

const SLIPPAGE_TOOL: Tool = {
  name: "check_slippage",
  description:
    "Simulate a swap on a Uniswap v4 pool and check price impact. Returns expected output and slippage percentage.",
  inputSchema: {
    type: "object",
    properties: {
      chainId: {
        type: "number",
        description: "Chain ID where the pool exists",
      },
      poolKey: {
        type: "object",
        description: "Uniswap v4 pool key object",
        properties: {
          currency0: { type: "string" },
          currency1: { type: "string" },
          fee: { type: "number" },
          tickSpacing: { type: "number" },
          hooks: { type: "string" },
        },
        required: ["currency0", "currency1", "fee", "tickSpacing", "hooks"],
      },
      zeroForOne: {
        type: "boolean",
        description: "true = selling currency0 for currency1",
        default: true,
      },
      amountIn: {
        type: "string",
        description: "Amount in smallest token unit (uint128 as string)",
      },
      maxSlippageBps: {
        type: "number",
        description: "Max acceptable slippage in basis points (50 = 0.5%)",
        default: 50,
      },
      inputTokenPriceUsd: {
        type: "number",
        description: "USD price of input token for gas estimation",
      },
      inputTokenDecimals: {
        type: "number",
        description: "Decimals of input token",
        default: 18,
      },
    },
    required: ["chainId", "poolKey", "amountIn"],
  },
};

const CHAINS_TOOL: Tool = {
  name: "get_chains",
  description: "List all chain configurations supported by EarnYld.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

const HEALTH_TOOL: Tool = {
  name: "health_check",
  description: "Check if the EarnYld agent API is healthy and return pool scan count.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

export function createMcpServer(client: EarnlabClient): Server {
  const server = new Server(
    {
      name: "earnyld-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      YIELDS_TOOL,
      GET_POOL_TOOL,
      PORTFOLIO_TOOL,
      POSITIONS_TOOL,
      TRADES_TOOL,
      DECISIONS_TOOL,
      SLIPPAGE_TOOL,
      CHAINS_TOOL,
      HEALTH_TOOL,
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, any>;

    try {
      switch (name) {
        case "list_yields": {
          const qs = client.buildQueryString({
            chainId: args.chainId,
            network: args.network,
            minAPY: args.minAPY,
            limit: args.limit ?? 20,
          });
          const data = await client.request(`/yields${qs}`);
          return asToolResult(data);
        }

        case "get_pool": {
          const poolId = String(args.poolId ?? "");
          if (!poolId) {
            return asToolError("poolId is required");
          }
          const data = await client.request(`/yields/${encodeURIComponent(poolId)}`);
          return asToolResult(data);
        }

        case "get_portfolio": {
          const data = await client.request(`/portfolio`);
          return asToolResult(data);
        }

        case "get_positions": {
          const data = await client.request(`/portfolio/positions`);
          return asToolResult(data);
        }

        case "get_trades": {
          const data = await client.request(`/portfolio/trades`);
          return asToolResult(data);
        }

        case "get_decisions": {
          const qs = client.buildQueryString({
            limit: args.limit ?? 20,
          });
          const data = await client.request(`/portfolio/decisions${qs}`);
          return asToolResult(data);
        }

        case "check_slippage": {
          const amountInRaw = String(args.amountIn ?? "");
          if (!/^\d+$/.test(amountInRaw)) {
            return asToolError("amountIn must be a non-negative integer string (e.g. \"1000000000000000000\")");
          }
          const data = await client.request(`/slippage/check`, {
            method: "POST",
            body: JSON.stringify({
              chainId: args.chainId,
              poolKey: args.poolKey,
              zeroForOne: args.zeroForOne ?? true,
              amountIn: args.amountIn,
              maxSlippageBps: args.maxSlippageBps ?? 50,
              inputTokenPriceUsd: args.inputTokenPriceUsd,
              inputTokenDecimals: args.inputTokenDecimals ?? 18,
            }),
          });
          return asToolResult(data);
        }

        case "get_chains": {
          const data = await client.request(`/chains`);
          return asToolResult(data);
        }

        case "health_check": {
          const data = await client.request(`/health`);
          return asToolResult(data);
        }

        default:
          return asToolError(`Unknown tool: ${name}`);
      }
    } catch (err: any) {
      return asToolError(err.message ?? String(err));
    }
  });

  return server;
}
