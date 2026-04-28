/**
 * LLMClient — single structured-JSON call per portfolio cycle.
 *
 * The LLM receives current opportunities + portfolio state and returns a
 * DecisionCycle: an array of AgentDecision objects plus overall reasoning.
 * The PortfolioManager executes decisions whose confidence >= 0.75.
 */

import OpenAI from "openai";
import type { RankedOpportunity } from "../ReporterAgent";
import type { MockPosition, PortfolioSummary, MacroRegime } from "../PortfolioManager";
import type { ZeroGMemory, MarketConditions, DecisionRecord } from "../storage/ZeroGMemory";
import { gasBreakEvenDays } from "../config/chains";

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
- Rebalance: executor checks switchBenefit = (effAPY_new − effAPY_cur) × posValue × 30d/365 − gas − slippage; must exceed 0.5% of position value — only propose rebalances with a compelling improvement in effectiveNetAPY
- Only decisions with confidence >= 0.75 are executed
- Portfolio risk budget (all limits are % of $10,000 total capital):
    chain ≤ 40%  ·  token ≤ 40%  ·  volatile pairs ≤ 50%  ·  stablecoin issuer ≤ 60%  ·  single pool ≤ 30%  ·  cash ≥ 10%
  Current budget state is shown below — do NOT propose entries that would breach any limit shown as ✗

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
    const ts = Date.now();
    // Retrieve past outcomes whose market conditions most resemble the current top opportunity
    const topOpp    = opps[0];
    const queryCond: MarketConditions = topOpp
      ? { rar7d: topOpp.rar7d, vol7d: topOpp.vol7d, change7d: topOpp.pairPriceChange7d * 100 }
      : { rar7d: 0, vol7d: 10, change7d: 0 };
    const similar   = this.memory.getSimilar(queryCond, CONTEXT_LIMIT);
    const context   = buildContext(opps, summary, positions, similar);

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
      const conditions: MarketConditions = {
        rar7d:    opp.rar7d,
        vol7d:    opp.vol7d,
        change7d: opp.pairPriceChange7d * 100,
      };
      const similar = this.memory.getSimilar(conditions, 3);
      const context = buildCritiqueContext(decision, opp, summary, positions, similar);
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
  similar:   DecisionRecord[],
): string {
  const oppLines = opps.slice(0, 15).map(o => {
    const il    = o.expectedIL > 0 ? `IL=${o.expectedIL.toFixed(1)}%` : "IL=n/a";
    const net   = o.expectedIL > 0 ? `netAPY=${o.netAPY.toFixed(1)}%` : `netAPY=${o.displayAPY.toFixed(1)}%`;
    const be    = gasBreakEvenDays(o.chainId, 2500, o.displayAPY);
    const beLabel = be === Infinity ? "be=∞" : be > 99 ? "be=>99d" : `be=${be.toFixed(1)}d`;
    const lqLabel      = o.liquidityQuality > 0 ? `lq=${o.liquidityQuality}` : "lq=?";
    const persistLabel = o.medianAPY7d > 0
      ? `persist=${(o.apyPersistence * 100).toFixed(0)}%(med=${o.medianAPY7d.toFixed(0)}%)`
      : "persist=?";
    const trLabel = o.tokenRisk
      ? (o.tokenRisk.blockEntry
          ? `tRisk=BLOCKED(${o.tokenRisk.flags[0] ?? ""})`
          : `tRisk=${o.tokenRisk.poolRiskScore}`)
      : "tRisk=?";
    const srLabel = o.stablecoinRisk
      ? (o.stablecoinRisk.blockEntry
          ? `sRisk=BLOCKED(${o.stablecoinRisk.flags[0] ?? ""})`
          : `sRisk=${o.stablecoinRisk.compositeScore}(peg±${o.stablecoinRisk.pegDeviation.toFixed(2)}%${o.stablecoinRisk.poolImbalance > 0.5 ? ` imb=${o.stablecoinRisk.poolImbalance.toFixed(1)}%` : ""})`)
      : "";
    const srPart  = srLabel ? ` | ${srLabel}` : "";
    const cuLabel = o.capitalUtilization > 0
      ? `cu=${(o.capitalUtilization * 100).toFixed(0)}%(TiR=${(o.timeInRangePct * 100).toFixed(0)}% FCE=${(o.feeCaptureEfficiency * 100).toFixed(0)}%)`
      : "cu=?";
    const effLabel = o.effectiveNetAPY > 0 ? `effAPY=${o.effectiveNetAPY.toFixed(1)}%` : "";
    const effPart  = effLabel ? ` | ${effLabel}` : "";
    const advLabel = o.adverseSelection
      ? `adv=${o.adverseSelection.score}(${o.adverseSelection.quality})`
      : "adv=?";
    const stressLabel = o.stressTest
      ? `stress=worst${o.stressTest.worstCase.netReturn30dPct.toFixed(1)}%(ES${o.stressTest.expectedShortfall30dPct.toFixed(1)}%)`
      : "stress=?";
    const scorecardLabel = o.scorecard
      ? `score=${o.scorecard.composite}/100[Y${o.scorecard.yield}|IL${o.scorecard.il}|LQ${o.scorecard.liquidity}|V${o.scorecard.volatility}|TR${o.scorecard.tokenRisk}|G${o.scorecard.gas}|C${o.scorecard.correlation}|R${o.scorecard.regime}] alloc=${o.scorecard.allocationPct.toFixed(0)}%`
      : "score=?";
    return `  ${o.poolId} | ${o.pair} | ${o.chainName} | feeAPY=${o.displayAPY.toFixed(1)}% | ${net} | ${il} | RAR7d=${o.rar7d > 0 ? o.rar7d.toFixed(2) : "n/a"} | TVL=${fmtUsd(o.tvlUsd)} | Δ7d=${(o.pairPriceChange7d * 100).toFixed(1)}% | ${beLabel} | ${lqLabel} | ${persistLabel} | ${cuLabel}${effPart} | ${trLabel}${srPart} | ${advLabel} | ${stressLabel} | ${scorecardLabel}`;
  }).join("\n") || "  (none yet)";

  const posLines = positions.length > 0
    ? positions.map(p => {
        const range  = p.halfRangePct > 0 ? ` range=±${p.halfRangePct.toFixed(1)}%` : "";
        const tir    = p.timeInRangePct != null ? ` TiR=${p.timeInRangePct.toFixed(0)}%` : "";
        const alerts = p.exitAlerts?.length ? ` ⚠ ${p.exitAlerts.join("; ")}` : "";
        return `  ${p.poolId} | ${p.pair} | ${p.chainName} | invested=$${p.entryValueUsd.toFixed(0)} | entryAPY=${p.entryAPY.toFixed(1)}% | held=${fmtHours(p.hoursHeld)} | PnL=$${p.pnlUsd.toFixed(2)}${range}${tir}${alerts}`;
      }).join("\n")
    : "  (none — portfolio is empty)";

  const simLines  = fmtSimilar(similar);
  const optLines  = fmtOptimization(summary);

  const expEntries = Object.entries(summary.tokenExposure ?? {})
    .filter(([, pct]) => pct >= 1)
    .sort(([, a], [, b]) => b - a)
    .map(([token, pct]) => `${token}=${pct.toFixed(1)}%`);
  const exposureLine = expEntries.length > 0
    ? `TOKEN EXPOSURE (40% limit): ${expEntries.join("  ")}`
    : "TOKEN EXPOSURE: none yet";

  const regimeLabel  = fmtRegime(summary.regime);
  const budgetLines  = fmtRiskBudget(summary);

  return [
    `Time: ${new Date().toUTCString()}`,
    ``,
    `MACRO REGIME: ${regimeLabel}`,
    `PORTFOLIO: cash=$${summary.cashUsd.toFixed(0)} invested=$${summary.investedUsd.toFixed(0)} totalCapital=$${summary.totalCapitalUsd} positions=${summary.openPositions}/4 unrealizedPnL=$${summary.unrealizedPnlUsd.toFixed(2)} realizedPnL=$${summary.realizedPnlUsd.toFixed(2)}`,
    exposureLine,
    budgetLines,
    ``,
    ...(optLines ? [`PORTFOLIO OPTIMIZER (marginal-Sharpe ranked):`, optLines, ``] : []),
    `OPPORTUNITIES (ranked RAR-7d > APY):`,
    oppLines,
    ``,
    `OPEN POSITIONS:`,
    posLines,
    ...(simLines ? [``, `PAST OUTCOMES — similar market conditions (0G memory):`, simLines] : []),
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

function fmtOptimization(summary: PortfolioSummary): string {
  const opt = summary.portfolioOptimization;
  if (!opt || opt.allocations.length === 0) return "";
  const header = `portSharpe=${opt.portfolioSharpe.toFixed(2)} portReturn=${opt.portfolioReturn.toFixed(1)}% portRisk=${opt.portfolioRisk.toFixed(0)}/100 cash=${opt.cashReservedPct.toFixed(0)}%`;
  const rows = opt.allocations.map(a =>
    `  rank${a.rank} ${a.pair}@${a.chainName} alloc=${a.allocationPct.toFixed(0)}% score=${a.scorecard.composite}/100 mSharpe=${a.marginalSharpe.toFixed(3)} — ${a.reasoning}`
  ).join("\n");
  return `${header}\n${rows}`;
}

function fmtRiskBudget(summary: PortfolioSummary): string {
  const rb = summary.riskBudget;
  if (!rb) return "RISK BUDGET: (not yet computed)";
  const dimStr = rb.dimensions.map(d => {
    const ok   = d.ok ? "✓" : "✗";
    const top  = d.topItem ? `(${d.topItem})` : "";
    return `${d.label}=${d.usedPct.toFixed(0)}%/${d.limitPct}%${ok}${top}`;
  }).join("  ");
  const cashStr = `Cash=${rb.cashBufferPct.toFixed(0)}%≥10%${rb.cashOk ? "✓" : "✗"}`;
  const viols   = rb.violations.length > 0 ? `  ⚠ VIOLATIONS: ${rb.violations.join("; ")}` : "";
  return `RISK BUDGET: ${dimStr}  ${cashStr}${viols}`;
}

function fmtRegime(regime: MacroRegime | undefined): string {
  switch (regime) {
    case "risk-off": return "RISK-OFF 🔴 (median ETH Δ7d < -5%) — prefer stable pools, sizing halved";
    case "risk-on":  return "RISK-ON 🟢 (median ETH Δ7d > +5%) — higher IL tolerance, 1.5× Kelly";
    default:         return "NEUTRAL ⚪ (median ETH Δ7d within ±5%)";
  }
}

function fmtSimilar(records: DecisionRecord[]): string {
  if (records.length === 0) return "";
  return records.map(r => {
    const cond = `rar=${r.conditions.rar7d > 0 ? r.conditions.rar7d.toFixed(1) : "n/a"} vol=${r.conditions.vol7d.toFixed(1)}% Δ=${r.conditions.change7d >= 0 ? "+" : ""}${r.conditions.change7d.toFixed(1)}%`;
    const date = new Date(r.timestamp).toLocaleString("en", { month: "short", day: "numeric" });
    if (!r.outcome) {
      return `  [${date}] ${r.decision.action} ${r.pair} on ${r.chainName} | ${cond} | (still open)`;
    }
    const { actualAPY, netReturn, daysHeld, closeReason } = r.outcome;
    const sign   = netReturn >= 0 ? "+" : "";
    const result = netReturn >= 0 ? "✓" : "✗";
    const why    = closeReason ? ` (${closeReason.slice(0, 40)})` : "";
    return `  [${date}] ${r.decision.action} ${r.pair} on ${r.chainName} | ${cond} → ${daysHeld.toFixed(1)}d | APY=${actualAPY.toFixed(0)}% ret=${sign}$${netReturn.toFixed(2)} ${result}${why}`;
  }).join("\n");
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
- APY mirage: unsustainably high APY driven by one-off volume spikes — will it revert? Check lq score: < 40 is a strong warning
- Liquidity quality: lq/100 composite score (TVL adequacy × vol/TVL activity × APY stability × depth). Score < 40 = thin/unstable pool; weight this heavily
- APY persistence: medianAPY7d / currentAPY. If persist < 50%, the current APY is a spike vs the 7-day median — treat as temporary, not durable yield
- Overconcentration: does the portfolio already hold similar token exposure?
- Capital efficiency (cu): cu = timeInRange × feeCaptureEfficiency. effectiveNetAPY = netAPY × cu. A 40% netAPY pool with cu=50% earns the same as a 20% netAPY pool that stays in range — compare effectiveNetAPY, not raw netAPY. cu < 50% is a strong warning. Check also: if feeCaptureEfficiency < 60%, fees are spike-driven (one-off volume), not sustained.
- Adverse selection (adv): detects toxic LP flow — fees paid by informed directional traders who are extracting value from LPs. Score 0–100. Score ≥ 45 (elevated) means fee APY, volume, or price drift signals suggest LPs are on the wrong side of informed trades. Score ≥ 70 (high) = strong signal — the fees earned likely don't offset the IL caused by the same traders. Key sub-signals: feeVsPriceMove (fee spike + directional move), postTradePriceDrift (momentum rather than mean reversion), volAcceleration (vol building in second half = ongoing price discovery).
- Stale data: if RAR is n/a, you have incomplete information — is that acceptable?
- Token risk: tRisk score (0=safe, 100=dangerous). BLOCKED = hard block (honeypot / balance manipulation / depeg). Score > 40 = meaningful concern. Score > 70 = veto unless everything else is exceptional.
- Stablecoin risk (sRisk): for stable pools — low APY is NOT automatically safe. Check: peg deviation > 1% is a warning, pool imbalance > 1% shows the pool absorbed a depeg, bridged stablecoins carry extra risk, depeg volatility > 0.5% stdDev means the peg has been unstable. sRisk composite > 40 warrants scrutiny; > 60 is a strong veto signal for what may look like "safe" yield.
- Switch cost: for rebalances — gas + slippage erodes the gain. The executor enforces a switchBenefit hurdle (0.5% of position value over 30 days), but you should still flag rebalances where effectiveNetAPY is only marginally better.
- Scenario stress test: downsideScore 0–100 (100 = worst case ≥ −20% in 30 days). expectedShortfall = average of 3 worst scenarios (CVaR proxy). Veto when downsideScore > 60 unless upside is exceptional. Flag when ES < −10%: even average-bad outcomes are deeply negative. Check which scenario is worst — if it's price_down_10 or price_down_20, the pool's IL at concentration leverage is severe. If it's vol_double, the pool's tick range will be breached frequently.
- Opportunity cost: is this meaningfully better than cash given the risks?
- Decision scorecard: composite score 0–100 shown as score=X/100[Y|IL|LQ|V|TR|G|C|R]. Each dimension is 0–100. A composite < 40 is weak; < 25 is very weak. Check which specific dimension is pulling the score down — a single 0 (e.g. TR=0 = BLOCKED, G=0 = never breaks even) is a hard red flag even if other dimensions are strong.

Set veto=true and confidence high when you find real risks. Only set veto=false when the opportunity is genuinely compelling AND risks are manageable.`;

// ─── Critic context builder ───────────────────────────────────────────────────

function buildCritiqueContext(
  decision:  AgentDecision,
  opp:       RankedOpportunity,
  summary:   PortfolioSummary,
  positions: MockPosition[],
  similar:   DecisionRecord[],
): string {
  const il    = opp.expectedIL > 0 ? `${opp.expectedIL.toFixed(1)}%` : "n/a";
  const net   = opp.expectedIL > 0 ? `${opp.netAPY.toFixed(1)}% (after IL)` : `${opp.displayAPY.toFixed(1)}% (IL unquantified)`;
  const alloc = decision.allocationPct != null ? `${decision.allocationPct.toFixed(1)}%` : "Kelly-sized";
  const posSize = ((decision.allocationPct ?? 10) / 100) * summary.totalCapitalUsd;
  const be      = gasBreakEvenDays(opp.chainId, posSize, opp.displayAPY);
  const beLabel = be === Infinity ? "∞" : be > 99 ? ">99d" : `${be.toFixed(1)}d`;
  const posLines = positions.length > 0
    ? positions.map(p => `  ${p.pair} | ${p.chainName} | APY=${p.entryAPY.toFixed(1)}% | held=${fmtHours(p.hoursHeld)} | PnL=$${p.pnlUsd.toFixed(2)}`).join("\n")
    : "  (none)";

  // Token-level correlation impact for this proposed trade
  const CORR_EQUIV: Record<string, string> = {
    WETH: "ETH", CBETH: "ETH", WSTETH: "ETH", RETH: "ETH", EZETH: "ETH", WEETH: "ETH", WBTC: "BTC",
  };
  const normTok = (s: string) => { const u = s.trim().toUpperCase(); return CORR_EQUIV[u] ?? u; };
  const newTokens   = opp.pair.split("/").map(normTok);
  const addedUsd    = ((decision.allocationPct ?? 10) / 100 * summary.totalCapitalUsd) / 2;
  const corrLines   = newTokens.map(token => {
    const currentPct = summary.tokenExposure?.[token] ?? 0;
    const addedPct   = addedUsd / summary.totalCapitalUsd * 100;
    const newPct     = currentPct + addedPct;
    const flag       = newPct > 40 ? " ✗ EXCEEDS 40% LIMIT" : " ✓";
    return `  ${token}: ${currentPct.toFixed(1)}% + ${addedPct.toFixed(1)}% = ${newPct.toFixed(1)}%${flag}`;
  }).join("\n");

  const simLines = fmtSimilar(similar);

  return [
    `MACRO REGIME: ${fmtRegime(summary.regime)}`,
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
    `  Gas break-even: ${beLabel} (entry+exit gas vs LP fees at this size)`,
    `  Liquidity quality: ${opp.liquidityQuality > 0 ? opp.liquidityQuality + "/100" : "?"} (TVL adequacy × vol/TVL activity × APY stability × depth vs vol)`,
    `  APY persistence:   ${opp.medianAPY7d > 0 ? `${(opp.apyPersistence * 100).toFixed(0)}% — current ${opp.displayAPY.toFixed(1)}% vs 7d median ${opp.medianAPY7d.toFixed(1)}%` : "? (collecting history)"}`,
    `  Capital efficiency: ${opp.capitalUtilization > 0 ? `TiR=${(opp.timeInRangePct * 100).toFixed(0)}%  FCE=${(opp.feeCaptureEfficiency * 100).toFixed(0)}%  utilization=${(opp.capitalUtilization * 100).toFixed(0)}%  effectiveNetAPY=${opp.effectiveNetAPY.toFixed(1)}% (±${opp.halfRangePct.toFixed(2)}% range)` : "? (not yet computed)"}`,
    ...(opp.adverseSelection ? [
      `  Adverse selection: score=${opp.adverseSelection.score}/100 (${opp.adverseSelection.quality})`,
      `    Fee vs price move:       ${opp.adverseSelection.feeVsPriceMove.toFixed(0)}/100`,
      `    Volume during moves:     ${opp.adverseSelection.volumeDuringLargeMoves.toFixed(0)}/100`,
      `    Price drift (momentum):  ${(opp.adverseSelection.postTradePriceDrift * 100).toFixed(0)}%`,
      `    Vol acceleration:        ${opp.adverseSelection.volatilityAfterVolumeSpikes.toFixed(2)}×`,
      ...(opp.adverseSelection.flags.length ? [`    Flags: ${opp.adverseSelection.flags.join("; ")}`] : []),
    ] : [`  Adverse selection: ? (not yet computed)`]),
    ...(opp.stressTest ? [
      `  Stress test (8 scenarios, 30d horizon):`,
      `    Downside score:    ${opp.stressTest.downsideScore.toFixed(0)}/100  (100 = worst case ≥ −20% loss)`,
      `    Baseline 30d:      ${opp.stressTest.baseline30dPct >= 0 ? "+" : ""}${opp.stressTest.baseline30dPct.toFixed(2)}%`,
      `    Worst case:        ${opp.stressTest.worstCase.netReturn30dPct.toFixed(2)}%  (${opp.stressTest.worstCase.name}: ${opp.stressTest.worstCase.description})`,
      `    Exp. shortfall:    ${opp.stressTest.expectedShortfall30dPct.toFixed(2)}%  (avg of 3 worst)`,
      `    All scenarios (worst-first):`,
      ...opp.stressTest.scenarios.map(s =>
        `      ${s.name.padEnd(16)} net=${s.netReturn30dPct >= 0 ? "+" : ""}${s.netReturn30dPct.toFixed(2)}%  fees=${s.feeReturn30dPct.toFixed(2)}%  IL+gas=${s.ilLoss30dPct.toFixed(2)}%${s.breachesRange ? "  [out of range]" : ""}`
      ),
    ] : [`  Stress test: ? (not yet computed)`]),
    `  Token risk score:  ${opp.tokenRisk ? `${opp.tokenRisk.poolRiskScore}/100${opp.tokenRisk.blockEntry ? " [BLOCKED]" : ""}${opp.tokenRisk.flags.length ? " — " + opp.tokenRisk.flags.join("; ") : ""}` : "? (not yet assessed)"}`,
    ...(opp.stablecoinRisk ? [
      `  Stablecoin risk:`,
      `    Peg deviation:    ${opp.stablecoinRisk.pegDeviation.toFixed(3)}% from $1${opp.stablecoinRisk.blockEntry ? " [HARD BLOCK — depeg > 5%]" : ""}`,
      `    Pool imbalance:   ${opp.stablecoinRisk.isStablePool ? opp.stablecoinRisk.poolImbalance.toFixed(3) + "%" : "n/a (not a stable pair)"}`,
      `    Issuer risk:      ${opp.stablecoinRisk.issuerRisk}/30 (${opp.stablecoinRisk.token0Risk ? opp.stablecoinRisk.token0Risk.symbol + "=" + opp.stablecoinRisk.token0Risk.issuerRisk : "—"}${opp.stablecoinRisk.token1Risk ? " / " + opp.stablecoinRisk.token1Risk.symbol + "=" + opp.stablecoinRisk.token1Risk.issuerRisk : ""})`,
      `    Bridge risk:      ${opp.stablecoinRisk.bridgeRisk}/35${opp.stablecoinRisk.bridgeRisk > 0 ? " — bridged token" : " — native"}`,
      `    Chain risk:       ${opp.stablecoinRisk.chainRisk}/25`,
      `    Depeg volatility: ${opp.stablecoinRisk.depegVolatility > 0 ? opp.stablecoinRisk.depegVolatility.toFixed(3) + "% stdDev 7d" : "no history"}`,
      `    Composite score:  ${opp.stablecoinRisk.compositeScore}/100${opp.stablecoinRisk.compositeScore > 50 ? " ⚠ elevated" : ""}`,
      ...(opp.stablecoinRisk.flags.length ? [`    Flags: ${opp.stablecoinRisk.flags.join("; ")}`] : []),
    ] : []),
    ``,
    `PORTFOLIO STATE: cash=$${summary.cashUsd.toFixed(0)} positions=${summary.openPositions}/4`,
    `OPEN POSITIONS:`,
    posLines,
    ``,
    `TOKEN CORRELATION IMPACT (40% limit per token):`,
    corrLines,
    ...(simLines ? [``, `PAST OUTCOMES — 3 closest market conditions (0G memory):`, simLines] : []),
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
