/**
 * LLMClient wraps OpenRouter (DeepSeek V3) with a tool-use loop.
 *
 * The LLM receives portfolio state + recent 0G memories and may call:
 *   list_opportunities  — inspect yield data
 *   get_portfolio_state — inspect positions/summary
 *   open_position       — enter a pool
 *   close_position      — exit a pool
 *   hold                — do nothing (terminal)
 *
 * The loop terminates when the LLM calls a terminal action or after
 * MAX_ITERATIONS safeguard steps.
 */

import OpenAI from "openai";
import type { RankedOpportunity } from "../ReporterAgent";
import type { MockPosition, PortfolioSummary } from "../PortfolioManager";
import type { ZeroGMemory, DecisionRecord } from "../storage/ZeroGMemory";

const MODEL         = process.env.LLM_MODEL  ?? "deepseek/deepseek-chat-v3-0324";
const MAX_ITER      = 6;  // safety cap on tool calls per think() invocation
const CONTEXT_LIMIT = 8;  // how many past decisions to include in prompt

// ─── Result type ─────────────────────────────────────────────────────────────

export type LLMAction =
  | { type: "open";  poolId: string; reason: string }
  | { type: "close"; poolId: string; reason: string }
  | { type: "hold";  reason: string };

export interface ThinkResult {
  actions:   LLMAction[];
  reasoning: string;
  rawTokens: number;
}

// ─── Tool schemas ─────────────────────────────────────────────────────────────

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name:        "list_opportunities",
      description: "Return the top yield opportunities sorted by risk-adjusted return (RAR-7d). Call this first to decide which pools to enter.",
      parameters: {
        type: "object",
        properties: {
          limit:     { type: "number",  description: "Max results (default 10, max 20)" },
          min_rar7d: { type: "number",  description: "Filter: minimum RAR-7d score (optional)" },
          network:   { type: "string",  enum: ["mainnet", "testnet", "all"], description: "Filter by network (default all)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name:        "get_portfolio_state",
      description: "Return the current portfolio summary and all open positions.",
      parameters:  { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name:        "open_position",
      description: "Open a new LP position in the given pool. The portfolio manager will allocate capital according to its rules (max 30% per pool, up to 4 positions).",
      parameters: {
        type: "object",
        required: ["pool_id", "reason"],
        properties: {
          pool_id: { type: "string", description: "The poolId from list_opportunities" },
          reason:  { type: "string", description: "Concise explanation of why this pool was chosen" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name:        "close_position",
      description: "Close an existing LP position. Only call if the position no longer meets return criteria or must be rebalanced.",
      parameters: {
        type: "object",
        required: ["pool_id", "reason"],
        properties: {
          pool_id: { type: "string", description: "The poolId of the open position to close" },
          reason:  { type: "string", description: "Concise explanation of why this position is being closed" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name:        "hold",
      description: "Take no action. Call this when the portfolio is already well-positioned or when conditions are uncertain.",
      parameters: {
        type: "object",
        required: ["reason"],
        properties: {
          reason: { type: "string", description: "Brief explanation for holding" },
        },
      },
    },
  },
];

const TERMINAL_TOOLS = new Set(["hold"]);

// ─── LLMClient ───────────────────────────────────────────────────────────────

export class LLMClient {
  private client: OpenAI;
  private memory: ZeroGMemory;

  // Injected by PortfolioManager so the LLM can execute real tool calls
  onListOpportunities!: (limit?: number, minRar7d?: number, network?: string) => RankedOpportunity[];
  onGetPortfolioState!: () => { summary: PortfolioSummary; positions: MockPosition[] };
  onOpenPosition!:  (poolId: string, reason: string) => boolean;
  onClosePosition!: (poolId: string, reason: string) => boolean;

  constructor(memory: ZeroGMemory) {
    this.memory = memory;
    this.client = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey:  process.env.OPENROUTER_API_KEY ?? "",
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/utk-dwd/earnlab",
        "X-Title":      "EarnYld Portfolio Manager",
      },
    });
  }

  async think(trigger: "deploy" | "rebalance"): Promise<ThinkResult> {
    const recentDecisions = this.memory.getRecent(CONTEXT_LIMIT);

    const systemPrompt = `You are EarnYld's portfolio manager agent. You manage a $10,000 mock portfolio of Uniswap v4 LP positions across multiple chains.

Rules you MUST follow (enforced by the system — violations are silently ignored):
- Never allocate more than 30% of capital to a single pool
- Never hold more than 4 concurrent positions
- Never close a position held for less than 24 hours
- Only rebalance if the new pool's RAR-7d is >30% better and the extra return covers the round-trip fee (0.2%) within 7 days

Your objective: maximise risk-adjusted returns (RAR-7d) while minimising unnecessary rebalancing costs.

When triggered for "${trigger}", use list_opportunities and get_portfolio_state to assess the situation, then decide: open new positions, close and rebalance existing ones, or hold.

Call hold() once you have finished all desired open/close operations — it is the signal that you are done for this cycle.`;

    const historySnippet = recentDecisions.length > 0
      ? `\nRecent decisions (from memory):\n${recentDecisions.map(d =>
          `  [${new Date(d.timestamp).toISOString()}] ${d.action.toUpperCase()} ${d.pair ?? ""} — ${d.reasoning}`
        ).join("\n")}`
      : "";

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system",  content: systemPrompt + historySnippet },
      { role: "user",    content: `Portfolio cycle triggered: ${trigger}. Please assess and act.` },
    ];

    const actions:   LLMAction[] = [];
    let   totalTokens = 0;
    let   reasoning   = "";

    for (let i = 0; i < MAX_ITER; i++) {
      const response = await this.client.chat.completions.create({
        model:       MODEL,
        messages,
        tools:       TOOLS,
        tool_choice: "auto",
      });

      const choice = response.choices[0];
      totalTokens += response.usage?.total_tokens ?? 0;

      if (choice.finish_reason === "stop" || !choice.message.tool_calls?.length) {
        reasoning = choice.message.content ?? "No reasoning provided";
        break;
      }

      // Push assistant message (with tool_calls) into history
      messages.push(choice.message);

      // Process each tool call
      const toolResults: OpenAI.Chat.ChatCompletionToolMessageParam[] = [];
      let   terminal = false;

      for (const tc of choice.message.tool_calls) {
        if (tc.type !== "function") continue;
        let args: any = {};
        try { args = JSON.parse(tc.function.arguments); } catch {}

        const result = this.executeTool(tc.function.name, args, actions);
        toolResults.push({
          role:         "tool",
          tool_call_id: tc.id,
          content:      JSON.stringify(result),
        });

        if (TERMINAL_TOOLS.has(tc.function.name)) {
          reasoning = args.reason ?? "";
          terminal  = true;
        }
        if (tc.function.name === "open_position" || tc.function.name === "close_position") {
          reasoning += (reasoning ? " | " : "") + (args.reason ?? "");
        }
      }

      messages.push(...toolResults);
      if (terminal) break;
    }

    return { actions, reasoning, rawTokens: totalTokens };
  }

  private executeTool(name: string, args: any, actions: LLMAction[]): unknown {
    switch (name) {
      case "list_opportunities": {
        const limit  = Math.min(Number(args.limit ?? 10), 20);
        const opps   = this.onListOpportunities(limit, args.min_rar7d, args.network);
        return opps.map(o => ({
          poolId:      o.poolId,
          pair:        o.pair,
          chainName:   o.chainName,
          network:     o.network,
          displayAPY:  o.displayAPY,
          rar7d:       o.rar7d,
          rar24h:      o.rar24h,
          vol7d:       o.vol7d,
          tvlUsd:      o.tvlUsd,
          rarQuality:  o.rarQuality,
          feeTierLabel: o.feeTierLabel,
          pairPriceChange7d: o.pairPriceChange7d,
        }));
      }

      case "get_portfolio_state": {
        return this.onGetPortfolioState();
      }

      case "open_position": {
        const ok = this.onOpenPosition(args.pool_id, args.reason ?? "LLM decision");
        if (ok) actions.push({ type: "open", poolId: args.pool_id, reason: args.reason ?? "" });
        return { success: ok, message: ok ? "Position opened" : "Open rejected (constraint violated or pool not found)" };
      }

      case "close_position": {
        const ok = this.onClosePosition(args.pool_id, args.reason ?? "LLM decision");
        if (ok) actions.push({ type: "close", poolId: args.pool_id, reason: args.reason ?? "" });
        return { success: ok, message: ok ? "Position closed" : "Close rejected (position not found or too young)" };
      }

      case "hold": {
        actions.push({ type: "hold", reason: args.reason ?? "" });
        return { success: true };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  }
}
