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

export interface CritiqueResult {
  veto:       boolean;
  confidence: number;
  reasoning:  string;
}

export interface AgentDecision {
  action:         "enter" | "exit" | "rebalance" | "hold" | "wait";
  pool?:          string;   // poolId from opportunities list
  allocationPct?: number;   // % of total capital (enter only, max 30)
  confidence:     number;   // 0–1
  reasoning:      string;
  exitCondition?: string;   // forward-looking exit trigger
  critique?:      CritiqueResult;  // Critic's verdict (enter/rebalance only)
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

Ranking priority: prefer pools with high netAPY (= feeAPY − expectedIL). Stable pairs with low IL often beat volatile pairs with high fee APY. Use RAR-7d when available as secondary confirmation.

Decision guide:
- enter:     open a new LP position in pool (use when cash is available and netAPY is attractive)
- exit:      close an existing position (use when netAPY or RAR degrades, or better opportunity exists and position is ≥24 h old)
- rebalance: exit the weakest current position and enter pool in one step
- hold:      keep current state — use a single hold decision when no action is warranted
- wait:      data not ready (e.g. IL/RAR still computing) — treated same as hold

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

  async critique(
    decision:  AgentDecision,
    opp:       RankedOpportunity,
    summary:   PortfolioSummary,
    positions: MockPosition[],
  ): Promise<CritiqueResult> {
    try {
      const context  = buildCritiqueContext(decision, opp, summary, positions);
      const response = await this.client.chat.completions.create({
        model:           MODEL,
        messages: [
          { role: "system", content: CRITIC_PROMPT },
          { role: "user",   content: context },
        ],
        response_format: { type: "json_object" },
        max_tokens:      250,
      });
      return parseCritique(response.choices[0]?.message?.content ?? "{}");
    } catch {
      // If Critic fails, approve by default — don't let it block execution
      return { veto: false, confidence: 0, reasoning: "Critic unavailable — defaulting to approve" };
    }
  }
}

// ─── Context builder ──────────────────────────────────────────────────────────

function buildContext(
  opps:      RankedOpportunity[],
  summary:   PortfolioSummary,
  positions: MockPosition[],
  recent:    any[],
): string {
  const oppLines = opps.slice(0, 15).map(o => {
    const il = o.expectedIL > 0 ? `IL=${o.expectedIL.toFixed(1)}%` : "IL=n/a";
    const net = o.expectedIL > 0 ? `netAPY=${o.netAPY.toFixed(1)}%` : `netAPY=${o.displayAPY.toFixed(1)}%`;
    return `  ${o.poolId} | ${o.pair} | ${o.chainName} | feeAPY=${o.displayAPY.toFixed(1)}% | ${net} | ${il} | RAR7d=${o.rar7d > 0 ? o.rar7d.toFixed(2) : "n/a"} | TVL=${fmtUsd(o.tvlUsd)} | Δ7d=${(o.pairPriceChange7d * 100).toFixed(1)}%`;
  }).join("\n") || "  (none yet)";

  const posLines = positions.length > 0
    ? positions.map(p => {
        const range  = p.halfRangePct > 0 ? ` range=±${p.halfRangePct.toFixed(1)}%` : "";
        const tir    = p.timeInRangePct != null ? ` TiR=${p.timeInRangePct.toFixed(0)}%` : "";
        const alerts = p.exitAlerts?.length ? ` ⚠ ${p.exitAlerts.join("; ")}` : "";
        return `  ${p.poolId} | ${p.pair} | ${p.chainName} | invested=$${p.entryValueUsd.toFixed(0)} | entryAPY=${p.entryAPY.toFixed(1)}% | held=${fmtHours(p.hoursHeld)} | PnL=$${p.pnlUsd.toFixed(2)}${range}${tir}${alerts}`;
      }).join("\n")
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

// ─── Critic prompt ────────────────────────────────────────────────────────────

const CRITIC_PROMPT = `You are EarnYld's adversarial risk critic. Your sole job is to find every reason NOT to enter a proposed LP position.

You receive a Seeker's proposed entry and the pool's market data. Be skeptical, not balanced.

Return ONLY valid JSON — no markdown, no extra keys:
{
  "veto":       true | false,
  "confidence": <0.0–1.0>,
  "reasoning":  "<1–3 sentences — specific risks that justify your verdict>"
}

Challenge every proposed entry. Look hard for:
- IL destruction: volatile pairs where expectedIL eats most of the fee APY
- Weak RAR: RAR-7d ≤ 2.0 is mediocre — is this really worth the IL exposure?
- Price momentum risk: if the pair moved >5% in 7d, the position may already be out of range
- TVL red flags: low TVL means thin liquidity, high slippage, and rug exposure
- APY mirage: unsustainably high APY driven by one-off volume spikes — will it revert?
- Overconcentration: does the portfolio already hold similar token exposure?
- Stale data: if RAR is n/a, you have incomplete information — is that acceptable?
- Opportunity cost: is this meaningfully better than cash given the risks?

Set veto=true and confidence high when you find real risks. Only set veto=false when the opportunity is genuinely compelling AND risks are manageable.`;

// ─── Critic context builder ───────────────────────────────────────────────────

function buildCritiqueContext(
  decision:  AgentDecision,
  opp:       RankedOpportunity,
  summary:   PortfolioSummary,
  positions: MockPosition[],
): string {
  const il    = opp.expectedIL > 0 ? `${opp.expectedIL.toFixed(1)}%` : "n/a";
  const net   = opp.expectedIL > 0 ? `${opp.netAPY.toFixed(1)}% (after IL)` : `${opp.displayAPY.toFixed(1)}% (IL unquantified)`;
  const alloc = decision.allocationPct != null ? `${decision.allocationPct.toFixed(1)}%` : "Kelly-sized";
  const posLines = positions.length > 0
    ? positions.map(p => `  ${p.pair} | ${p.chainName} | APY=${p.entryAPY.toFixed(1)}% | held=${fmtHours(p.hoursHeld)} | PnL=$${p.pnlUsd.toFixed(2)}`).join("\n")
    : "  (none)";

  return [
    `SEEKER PROPOSES: ${decision.action.toUpperCase()} ${opp.pair} on ${opp.chainName}`,
    `Seeker reasoning: ${decision.reasoning}`,
    ``,
    `POOL DATA:`,
    `  Pair:           ${opp.pair} (${opp.feeTierLabel})`,
    `  Chain:          ${opp.chainName}  Risk tier: ${opp.risk}`,
    `  Fee APY:        ${opp.displayAPY.toFixed(1)}%`,
    `  Net APY:        ${net}`,
    `  Expected IL:    ${il}`,
    `  RAR-7d:         ${opp.rar7d > 0 ? opp.rar7d.toFixed(2) : "n/a (data missing)"}`,
    `  Tick range:     ±${(opp.vol7d > 0 ? opp.vol7d * 2 : 5).toFixed(1)}% (2σ of vol7d=${opp.vol7d > 0 ? opp.vol7d.toFixed(1) : "unknown"}%)`,
    `  TVL:            ${fmtUsd(opp.tvlUsd)}`,
    `  24h volume:     ${fmtUsd(opp.volume24hUsd)}`,
    `  Token0 Δ7d:     ${(opp.token0PriceChange7d * 100).toFixed(1)}%`,
    `  Token1 Δ7d:     ${(opp.token1PriceChange7d * 100).toFixed(1)}%`,
    `  Pair price Δ7d: ${(opp.pairPriceChange7d * 100).toFixed(1)}%`,
    `  Allocation:     ${alloc} of $${summary.totalCapitalUsd} total capital`,
    ``,
    `PORTFOLIO STATE: cash=$${summary.cashUsd.toFixed(0)} positions=${summary.openPositions}/4`,
    `OPEN POSITIONS:`,
    posLines,
  ].join("\n");
}

// ─── Critique parser ──────────────────────────────────────────────────────────

function parseCritique(raw: string): CritiqueResult {
  try {
    const p = JSON.parse(raw);
    return {
      veto:       Boolean(p.veto),
      confidence: Math.max(0, Math.min(1, Number(p.confidence ?? 0))),
      reasoning:  String(p.reasoning ?? ""),
    };
  } catch {
    return { veto: false, confidence: 0, reasoning: "Critic parse error — defaulting to approve" };
  }
}
