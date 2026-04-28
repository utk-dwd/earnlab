/**
 * LLMClient — single structured-JSON call per portfolio cycle.
 *
 * The LLM receives current opportunities + portfolio state and returns a
 * DecisionCycle: an array of AgentDecision objects plus overall reasoning.
 * The PortfolioManager executes decisions whose confidence >= 0.75.
 */

import OpenAI from "openai";
import type { RankedOpportunity } from "../ReporterAgent";
import type { MockPosition, PortfolioSummary } from "../PortfolioManager";
import type { ZeroGMemory } from "../storage/ZeroGMemory";

const MODEL         = process.env.LLM_MODEL ?? "deepseek/deepseek-chat-v3-0324";
const CONTEXT_LIMIT = 8;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface AgentDecision {
  action:         "enter" | "exit" | "rebalance" | "hold" | "wait";
  pool?:          string;   // poolId from opportunities list
  allocationPct?: number;   // % of total capital (enter only, max 30)
  confidence:     number;   // 0–1
  reasoning:      string;
  exitCondition?: string;   // forward-looking exit trigger
}

export interface DecisionCycle {
  decisions:  AgentDecision[];
  reasoning:  string;        // overall cycle summary
  timestamp:  number;
  rawTokens:  number;
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are EarnYld's autonomous portfolio manager for Uniswap v4 LP positions.

Every 5 minutes you receive current yield opportunities and portfolio state.
Return ONLY valid JSON — no markdown fences, no keys outside the schema:

{
  "decisions": [
    {
      "action":        "enter" | "exit" | "rebalance" | "hold" | "wait",
      "pool":          "<poolId>",       // required for enter / exit / rebalance
      "allocationPct": <number 1–30>,    // % of $10,000 total capital (enter only)
      "confidence":    <0.0–1.0>,        // your conviction in this decision
      "reasoning":     "<1–2 sentences>",
      "exitCondition": "<optional forward trigger>"
    }
  ],
  "reasoning": "<1–2 sentence overall summary>"
}

Hard constraints (enforced by executor — violations are silently ignored):
- Max 30 % of capital per pool
- Max 4 concurrent positions
- Min 24 h hold before any exit
- Rebalance: new pool must be >30 % better RAR-7d; fee must recover within 7 days
- Only decisions with confidence >= 0.75 are executed

Decision guide:
- enter:     open a new LP position in pool (use when cash is available and there are strong opportunities)
- exit:      close an existing position (use when RAR degrades or better opportunity exists and position is ≥24 h old)
- rebalance: exit the weakest current position and enter pool in one step
- hold:      keep current state — use a single hold decision when no action is warranted
- wait:      data not ready (e.g. RAR still computing) — treated same as hold

Provide multiple decisions if warranted (e.g. enter 2 pools when portfolio is empty).
For hold/wait, include exactly one decision with no pool field.`;

// ─── LLMClient ────────────────────────────────────────────────────────────────

export class LLMClient {
  private client: OpenAI;
  private memory: ZeroGMemory;

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

  async decide(
    opps:      RankedOpportunity[],
    summary:   PortfolioSummary,
    positions: MockPosition[],
  ): Promise<DecisionCycle> {
    const ts     = Date.now();
    const recent = this.memory.getRecent(CONTEXT_LIMIT);
    const context = buildContext(opps, summary, positions, recent);

    const response = await this.client.chat.completions.create({
      model:           MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: context },
      ],
      response_format: { type: "json_object" },
      max_tokens:      600,
    });

    const raw    = response.choices[0]?.message?.content ?? "{}";
    const tokens = response.usage?.total_tokens ?? 0;

    return { ...parseCycle(raw), timestamp: ts, rawTokens: tokens };
  }
}

// ─── Context builder ──────────────────────────────────────────────────────────

function buildContext(
  opps:      RankedOpportunity[],
  summary:   PortfolioSummary,
  positions: MockPosition[],
  recent:    any[],
): string {
  const oppLines = opps.slice(0, 15).map(o =>
    `  ${o.poolId} | ${o.pair} | ${o.chainName} | APY=${o.displayAPY.toFixed(1)}% | RAR7d=${o.rar7d > 0 ? o.rar7d.toFixed(2) : "n/a"} | TVL=${fmtUsd(o.tvlUsd)} | Δ7d=${(o.pairPriceChange7d * 100).toFixed(1)}% | quality=${o.rarQuality}`
  ).join("\n") || "  (none yet)";

  const posLines = positions.length > 0
    ? positions.map(p =>
        `  ${p.poolId} | ${p.pair} | ${p.chainName} | invested=$${p.entryValueUsd.toFixed(0)} | entryAPY=${p.entryAPY.toFixed(1)}% | held=${fmtHours(p.hoursHeld)} | PnL=$${p.pnlUsd.toFixed(2)}`
      ).join("\n")
    : "  (none — portfolio is empty)";

  const memLines = recent.length > 0
    ? recent.map(d =>
        `  [${new Date(d.timestamp).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}] ${d.action} ${d.poolId ?? ""} — ${d.reasoning}`
      ).join("\n")
    : "";

  return [
    `Time: ${new Date().toUTCString()}`,
    ``,
    `PORTFOLIO: cash=$${summary.cashUsd.toFixed(0)} invested=$${summary.investedUsd.toFixed(0)} totalCapital=$${summary.totalCapitalUsd} positions=${summary.openPositions}/4 unrealizedPnL=$${summary.unrealizedPnlUsd.toFixed(2)} realizedPnL=$${summary.realizedPnlUsd.toFixed(2)}`,
    ``,
    `OPPORTUNITIES (ranked RAR-7d > APY):`,
    oppLines,
    ``,
    `OPEN POSITIONS:`,
    posLines,
    ...(memLines ? [``, `RECENT DECISIONS (0G memory):`, memLines] : []),
  ].join("\n");
}

// ─── Response parser ──────────────────────────────────────────────────────────

function parseCycle(raw: string): Omit<DecisionCycle, "timestamp" | "rawTokens"> {
  try {
    const parsed    = JSON.parse(raw);
    const decisions: AgentDecision[] = (Array.isArray(parsed.decisions) ? parsed.decisions : [])
      .map((d: any): AgentDecision => ({
        action:         validateAction(d.action),
        pool:           typeof d.pool === "string" ? d.pool : undefined,
        allocationPct:  typeof d.allocationPct === "number" ? Math.min(d.allocationPct, 30) : undefined,
        confidence:     Math.max(0, Math.min(1, Number(d.confidence ?? 0))),
        reasoning:      String(d.reasoning ?? ""),
        exitCondition:  typeof d.exitCondition === "string" ? d.exitCondition : undefined,
      }));

    if (decisions.length === 0) {
      decisions.push({ action: "hold", confidence: 1, reasoning: parsed.reasoning ?? "No decisions returned" });
    }

    return { decisions, reasoning: String(parsed.reasoning ?? "") };
  } catch {
    return {
      decisions: [{ action: "hold", confidence: 1, reasoning: "Failed to parse LLM response" }],
      reasoning: "Parse error",
    };
  }
}

function validateAction(a: unknown): AgentDecision["action"] {
  const valid: AgentDecision["action"][] = ["enter", "exit", "rebalance", "hold", "wait"];
  return valid.includes(a as any) ? (a as AgentDecision["action"]) : "hold";
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtUsd(n: number): string {
  if (!n)      return "$0";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtHours(h: number): string {
  if (h < 1)  return `${Math.round(h * 60)}m`;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}
