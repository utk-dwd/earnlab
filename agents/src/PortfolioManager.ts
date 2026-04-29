import type { ReporterAgent, RankedOpportunity } from "./ReporterAgent";
import { ZeroGMemory }  from "./storage/ZeroGMemory";
import type { MarketConditions, DecisionSummary, DecisionOutcome } from "./storage/ZeroGMemory";
import { SnapshotStore } from "./storage/SnapshotStore";
import { LLMClient }    from "./llm/LLMClient";
import type { AgentDecision, CritiqueResult, DecisionCycle } from "./llm/LLMClient";
import { TICK_SPACINGS, gasBreakEvenDays, GAS_COST_USD } from "./config/chains";
import type { FeeTier } from "./config/chains";
// Uniswap v4 SDK utilities for position tick range computation
import { nearestUsableTick, TickMath } from "@uniswap/v3-sdk";
import { rankFactor } from "./calculator/LiquidityQualityCalculator";
import {
  RISK_BUDGET,
  computeRiskBudgetState,
  checkRiskBudget,
  rbPairTokens,
  rbIssuerOf,
  rbIsVolatile,
} from "./calculator/RiskBudget";
import type { RiskBudgetState } from "./calculator/RiskBudget";
import { enrichWithPortfolio } from "./calculator/DecisionScorecard";
import { optimizePortfolio } from "./calculator/PortfolioOptimizer";
import type { OptimizationResult } from "./calculator/PortfolioOptimizer";
import { buildCorrelationMatrix } from "./calculator/PortfolioCorrelation";
import type { CorrelationMatrix } from "./calculator/PortfolioCorrelation";

// ─── Regime ───────────────────────────────────────────────────────────────────
export type MacroRegime = "risk-off" | "neutral" | "risk-on";
const REGIME_ETH_THRESHOLD_PCT = 5;   // |median ETH Δ7d| threshold
const KELLY_SCALE_RISK_OFF     = 0.5; // halve sizing when risk-off
const KELLY_SCALE_RISK_ON      = 1.5; // allow 50% larger Kelly when risk-on

// Stablecoins — used for stable-pool preference in risk-off mode
const STABLECOINS = new Set([
  "USDC","USDT","DAI","USDB","CUSD","FRAX","LUSD","BUSD","PYUSD","GHO","CRVUSD","SUSD","MIM","USDBC",
]);

function isStablePool(pair: string): boolean {
  return pair.split("/").every(t => STABLECOINS.has(t.trim().toUpperCase()));
}

// ─── Config ───────────────────────────────────────────────────────────────────
const INITIAL_CAPITAL_USD = 10_000;
const MAX_POSITION_PCT    = 0.30;   // max 30% of capital per pair
const TARGET_POSITIONS    = 4;      // aim for this many concurrent positions
const MIN_HOLD_HOURS         = 24;     // never rebalance a position younger than this
const MAX_BREAKEVEN_DAYS     = 7;      // initial entry only: gas break-even must be ≤ this
const HOLD_HORIZON_DAYS      = 30;     // projection horizon for switchBenefit calculation
const MIN_SWITCH_BENEFIT_PCT = 0.005;  // switch benefit must exceed 0.5% of position value over horizon
const GAS_COST_USD_FALLBACK  = 1.00;   // fallback gas cost for unlisted chains
const ENTRY_FEE_PCT        = 0.001;  // 0.1% simulated swap cost to enter
const EXIT_FEE_PCT         = 0.001;  // 0.1% simulated swap cost to exit
const CHECK_INTERVAL_MS    = 5 * 60_000;
const CONFIDENCE_THRESHOLD    = 0.75;
const DECISION_HISTORY_MAX    = 50;

// ─── Exit trigger thresholds ─────────────────────────────────────────────────
const RAR_DETERIORATION_RATIO  = 0.50;  // exit if current RAR7d < entry × 0.5
const BETTER_OPP_RAR_RATIO     = 1.50;  // flag/exit if competitor RAR7d > current × 1.5
const PRICE_MOVE_THRESHOLD_PCT = 15;    // exit if |pairPriceChange7d| > 15%
const TIME_IN_RANGE_MIN_PCT    = 80;    // exit if estimated time-in-range < 80%
const STALE_DAYS               = 30;    // position is "stale" after this many days
const STALE_NET_APY_MIN        = 5;     // stale position must have at least this net APY
const RAR_TREND_TICKS          = 3;     // predictive exit: RAR falling for N consecutive ticks
const RAR_TREND_MIN_DROP_PCT   = 10;    // ignore tiny RAR drift
const NEG_MOMENTUM_STEP_PCT    = 2;     // predictive exit: 24h move worsening by at least this much per tick

let _seq = 0;
const nextId = () => `${Date.now()}-${++_seq}`;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MockPosition {
  id:              string;
  poolId:          string;
  chainId:         number;
  chainName:       string;
  pair:            string;
  feeTierLabel:    string;
  entryTimestamp:  number;
  entryValueUsd:   number;
  allocationPct:   number;
  entryAPY:        number;
  entryRAR7d:      number;
  currentValueUsd: number;
  earnedFeesUsd:   number;
  pnlUsd:          number;
  pnlPct:          number;
  hoursHeld:       number;
  status:          "open" | "closed";
  closedTimestamp?: number;
  closedValueUsd?:  number;
  closeReason?:     string;
  /** Lower tick of the 2σ concentrated range (entry-relative, negative). */
  tickLower:       number;
  /** Upper tick of the 2σ concentrated range (entry-relative, positive). */
  tickUpper:       number;
  /** Half-width of the range in % (vol7d × 2). Used for TiR calculation. */
  halfRangePct:    number;
  /** 0–100. Estimated % of time price was within tick range. */
  timeInRangePct:  number;
  /** Active exit trigger descriptions. Updated every tick; empty = healthy. */
  exitAlerts:      string[];
  /** Recent RAR samples for predictive deterioration alerts. */
  rarTrend:        number[];
  /** Recent pairPriceChange24h samples, in percent, for momentum acceleration alerts. */
  pairMove24hTrend: number[];
}

export interface PortfolioTrade {
  id:           string;
  timestamp:    number;
  action:       "open" | "close";
  poolId:       string;
  pair:         string;
  chainName:    string;
  feeTierLabel: string;
  valueUsd:     number;
  apy:          number;
  rar7d:        number;
  feePaidUsd:   number;
  reason:       string;
}

export interface PortfolioSummary {
  totalCapitalUsd:        number;
  cashUsd:                number;
  investedUsd:            number;
  totalValueUsd:          number;
  unrealizedPnlUsd:       number;
  unrealizedPnlPct:       number;
  realizedPnlUsd:         number;
  totalEarnedFeesUsd:     number;
  totalFeesPaidUsd:       number;
  openPositions:          number;
  tradeCount:             number;
  lastRebalanceTimestamp: number | null;
  llmEnabled:             boolean;
  lastDecision:           AgentDecision | null;
  lastDecisionAt:         number | null;
  tokenExposure:          Record<string, number>;  // normalised token → % of totalCapital
  regime:                 MacroRegime;
  riskBudget:             RiskBudgetState;
  portfolioOptimization:  OptimizationResult | null;
}

export type { AgentDecision, DecisionCycle };

interface PortfolioSnapshot {
  cash:            number;
  positions:       MockPosition[];
  trades:          PortfolioTrade[];
  feesPaid:        number;
  lastRebalance:   number | null;
  lastCycle:       DecisionCycle | null;
  decisionHistory: DecisionCycle[];
  regime:          MacroRegime;
  savedAt:         number;
}

// ─── PortfolioManager ─────────────────────────────────────────────────────────

export class PortfolioManager {
  private reporter:      ReporterAgent;
  private snapshots      = new SnapshotStore();
  private cash:          number = INITIAL_CAPITAL_USD;
  private positions:     Map<string, MockPosition> = new Map();
  private trades:        PortfolioTrade[] = [];
  private feesPaid:      number = 0;
  private lastRebalance: number | null = null;
  private running        = false;

  private memory:             ZeroGMemory;
  private llm:                LLMClient | null = null;
  private llmReady            = false;
  private lastCycle:          DecisionCycle | null = null;
  private decisionHistory:    DecisionCycle[] = [];
  private regime:             MacroRegime = "neutral";
  private latestOptimization: OptimizationResult | null = null;

  constructor(reporter: ReporterAgent) {
    this.reporter = reporter;
    this.memory   = new ZeroGMemory();
    this.restoreState();
  }

  async start(): Promise<void> {
    this.running = true;

    // Initialise 0G memory (gracefully falls back to in-memory)
    await this.memory.init();

    // Wire up LLM client if OPENROUTER_API_KEY is set
    if (process.env.OPENROUTER_API_KEY) {
      this.llm      = new LLMClient(this.memory);
      this.llmReady = true;
      console.log(`[Portfolio] LLM enabled — model: ${process.env.LLM_MODEL ?? "deepseek/deepseek-chat-v3-0324"}`);
    } else {
      console.log("[Portfolio] OPENROUTER_API_KEY not set — running rule-based mode");
    }

    console.log(`[Portfolio] Starting — $${INITIAL_CAPITAL_USD.toLocaleString()} mock capital`);
    await this.tick();
    const interval = setInterval(async () => {
      if (!this.running) { clearInterval(interval); return; }
      await this.tick();
    }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    this.running = false;
    this.persistState();
    this.snapshots.close();
  }

  // ─── Main tick ───────────────────────────────────────────────────────────
  private async tick(): Promise<void> {
    const prev = this.regime;
    this.regime = this.detectRegime();
    if (this.regime !== prev) {
      console.log(`[Portfolio] Regime changed: ${prev} → ${this.regime}`);
    }
    this.updateValues();

    // Enrich scorecards with portfolio-aware correlation + regime, then run optimizer
    this.enrichScorecards();
    const corrMatrix = this.buildCorrMatrix();
    this.latestOptimization = optimizePortfolio(
      this.reporter.getLatest(),
      [...this.positions.values()],
      this.cash,
      this.regime,
      corrMatrix,
    );

    // Evaluate exit triggers every tick — updates alerts for UI and auto-exits when warranted
    this.evaluateExitTriggers();

    const trigger = this.openList().length === 0 ? "deploy" : "rebalance";

    if (this.llmReady && this.llm) {
      await this.thinkWithLLM(trigger);
    } else {
      if (trigger === "deploy") {
        this.deploy();
      } else {
        this.rebalance();
      }
    }
    this.persistState();
  }

  // ─── LLM-driven decision ─────────────────────────────────────────────────
  private async thinkWithLLM(trigger: "deploy" | "rebalance"): Promise<void> {
    console.log(`[Portfolio] LLM deciding (${trigger})…`);
    try {
      const opps               = this.toolListOpps(15);
      const { summary, positions } = this.toolGetState();

      const cycle = await this.llm!.decide(opps, summary, positions);

      // Store in ring buffer
      this.lastCycle = cycle;
      this.decisionHistory.unshift(cycle);
      if (this.decisionHistory.length > DECISION_HISTORY_MAX) {
        this.decisionHistory.length = DECISION_HISTORY_MAX;
      }

      console.log(`[Portfolio] LLM: ${cycle.decisions.length} decision(s) | ${cycle.rawTokens} tokens`);
      if (cycle.reasoning) console.log(`[Portfolio] LLM reasoning: ${cycle.reasoning}`);

      for (const d of cycle.decisions) {
        const tag = `${d.action}${d.pool ? ` pool=${d.pool.slice(0, 10)}…` : ""} conf=${d.confidence.toFixed(2)}`;
        if (d.confidence < CONFIDENCE_THRESHOLD) {
          console.log(`[Portfolio] Skip (low confidence): ${tag} — ${d.reasoning}`);
          continue;
        }
        console.log(`[Portfolio] Execute: ${tag} — ${d.reasoning}`);
        await this.executeDecision(d);
      }

      this.lastRebalance = Date.now();
      this.persistState();
    } catch (err: any) {
      console.warn(`[Portfolio] LLM failed (${err.message}), falling back to rule-based`);
      if (trigger === "deploy") this.deploy();
      else                      this.rebalance();
    }
  }

  private async executeDecision(d: AgentDecision): Promise<void> {
    switch (d.action) {
      case "enter": {
        if (!d.pool) break;
        const opp = this.reporter.getLatest().find(o => o.poolId === d.pool);
        if (opp && this.llm) {
          const critique = await this.llm.critique(d, opp, this.getSummary(), this.openList());
          d.critique = critique;
          if (critique.veto && critique.confidence >= CONFIDENCE_THRESHOLD) {
            console.log(`[Portfolio] Critic VETOED ${opp.pair}: ${critique.reasoning}`);
            break;
          }
          console.log(`[Portfolio] Critic approved ${opp.pair} (conf=${(critique.confidence * 100).toFixed(0)}%): ${critique.reasoning}`);
        }
        this.toolOpen(d.pool, d.reasoning, d.allocationPct, d);
        break;
      }

      case "exit":
        if (d.pool) this.toolClose(d.pool, d.reasoning);
        break;

      case "rebalance": {
        const worst = this.openList().sort((a, b) => a.pnlPct - b.pnlPct)[0];
        if (d.pool) {
          const opp = this.reporter.getLatest().find(o => o.poolId === d.pool);
          if (opp && this.llm) {
            const critique = await this.llm.critique(d, opp, this.getSummary(), this.openList());
            d.critique = critique;
            if (critique.veto && critique.confidence >= CONFIDENCE_THRESHOLD) {
              console.log(`[Portfolio] Critic VETOED rebalance into ${opp.pair}: ${critique.reasoning}`);
              break;  // skip both close and open — don't unwind a good position for a vetoed target
            }
            console.log(`[Portfolio] Critic approved rebalance into ${opp.pair} (conf=${(critique.confidence * 100).toFixed(0)}%)`);
          }
          // Transaction-cost-aware hurdle: applies to LLM-driven rebalances too
          if (worst && opp) {
            const currentOpp = this.reporter.getLatest().find(o => o.poolId === worst.poolId);
            const sw = switchBenefitCheck(worst, currentOpp, opp);
            if (!sw.ok) {
              console.log(`[Portfolio] LLM rebalance hold (switch hurdle): ${sw.log}`);
              break;
            }
          }
          if (worst) this.toolClose(worst.poolId, `Rebalancing into ${d.pool}: ${d.reasoning}`);
          this.toolOpen(d.pool, d.reasoning, d.allocationPct, d);
        }
        break;
      }

      case "hold":
      case "wait":
        // intentional no-op
        break;
    }
  }

  // ─── LLM tool implementations ────────────────────────────────────────────

  private toolListOpps(limit = 10, minRar7d?: number, network?: string): RankedOpportunity[] {
    let opps = this.reporter.getLatest()
      .filter(o => o.displayAPY > 0);
    if (minRar7d != null) opps = opps.filter(o => o.rar7d >= minRar7d);
    if (network && network !== "all") opps = opps.filter(o => o.network === network);
    return opps
      .sort(rarOrApySort)
      .slice(0, Math.min(limit, 20));
  }

  private toolGetState(): { summary: PortfolioSummary; positions: MockPosition[] } {
    return {
      summary:   this.getSummary(),
      positions: this.getPositions().filter(p => p.status === "open"),
    };
  }

  private toolOpen(poolId: string, reason: string, allocationPct?: number, agentDecision?: AgentDecision): boolean {
    const open = this.openList();
    if (open.length >= TARGET_POSITIONS) {
      console.log(`[Portfolio] open rejected — already at max positions (${TARGET_POSITIONS})`);
      return false;
    }
    const opp = this.reporter.getLatest().find(o => o.poolId === poolId);
    if (!opp) {
      console.log(`[Portfolio] open rejected — pool ${poolId} not found`);
      return false;
    }
    if (this.positions.has(poolId) && this.positions.get(poolId)!.status === "open") {
      console.log(`[Portfolio] open rejected — already in pool ${poolId}`);
      return false;
    }

    // Use LLM-requested allocation if provided; else Kelly-inspired sizing
    const pct = allocationPct != null
      ? Math.min(allocationPct / 100, MAX_POSITION_PCT)
      : this.kellyAllocation(opp);

    // Risk budget: block if any portfolio-level constraint would be breached
    const viols = checkRiskBudget(opp.pair, opp.chainName, INITIAL_CAPITAL_USD * pct, this.openList(), this.cash, INITIAL_CAPITAL_USD);
    if (viols.length > 0) {
      console.log(`[Portfolio] Risk budget blocked ${opp.pair}: ${viols.map(v => v.message).join(" | ")}`);
      return false;
    }

    // Gas break-even guard: skip if gas costs take more than MAX_BREAKEVEN_DAYS to recover
    const beDays = gasBreakEvenDays(opp.chainId, INITIAL_CAPITAL_USD * pct, opp.displayAPY);
    if (beDays > MAX_BREAKEVEN_DAYS) {
      console.log(`[Portfolio] Gas break-even ${beDays.toFixed(1)}d > ${MAX_BREAKEVEN_DAYS}d — skip ${opp.pair} on ${opp.chainName}`);
      return false;
    }

    // Token risk guard: block honeypots, balance-manipulable contracts, depegged stables
    if (opp.tokenRisk?.blockEntry) {
      console.log(`[Portfolio] Token risk BLOCK: ${opp.pair} — ${opp.tokenRisk.flags.join("; ")}`);
      return false;
    }

    // Stablecoin depeg guard: block if any stablecoin is > 5% off peg
    if (opp.stablecoinRisk?.blockEntry) {
      console.log(`[Portfolio] Stable depeg BLOCK: ${opp.pair} — ${opp.stablecoinRisk.flags[0]}`);
      return false;
    }

    this.enter(opp, INITIAL_CAPITAL_USD * pct, pct * 100, reason, agentDecision);
    this.lastRebalance = Date.now();
    this.persistState();
    console.log(`[Portfolio] opened ${opp.pair} on ${opp.chainName} (${(pct * 100).toFixed(0)}%)`);
    return true;
  }

  private toolClose(poolId: string, reason: string): boolean {
    const pos = this.positions.get(poolId);
    if (!pos || pos.status !== "open") {
      console.log(`[Portfolio] LLM close rejected — no open position for ${poolId}`);
      return false;
    }
    const hoursHeld = (Date.now() - pos.entryTimestamp) / 3_600_000;
    if (hoursHeld < MIN_HOLD_HOURS) {
      console.log(`[Portfolio] close rejected — ${pos.pair} only held ${hoursHeld.toFixed(1)}h (min ${MIN_HOLD_HOURS}h)`);
      return false;
    }
    const proceeds = this.exit(pos, reason);
    this.persistState();
    console.log(`[Portfolio] closed ${pos.pair} — proceeds $${proceeds.toFixed(2)}`);
    return true;
  }

  // ─── Portfolio-aware scorecard enrichment ────────────────────────────────
  // Updates correlation + regime scores on all latest opportunities in-place
  // so the API response always reflects the current portfolio state.
  private enrichScorecards(): void {
    const positions = [...this.positions.values()];
    for (const opp of this.reporter.getLatest()) {
      if (opp.scorecard) {
        opp.scorecard = enrichWithPortfolio(opp.scorecard, opp, positions, this.regime);
      }
    }
  }

  // ─── APY correlation matrix ──────────────────────────────────────────────
  // Fetches hourly APY series for every ranked pool from SQLite and builds a
  // pairwise Pearson correlation matrix.  Pure in-memory computation; cheap.
  private buildCorrMatrix(): CorrelationMatrix {
    const store    = this.reporter.getApyHistoryStore();
    const poolIds  = store.getPoolIds();
    const seriesMap = new Map(
      poolIds.map(id => [id, store.getTimeSeries7d(id)] as const),
    );
    return buildCorrelationMatrix(seriesMap);
  }

  // ─── Kelly-inspired position sizing ─────────────────────────────────────
  // f* = (RAR − 1) / RAR, scaled to ¼ Kelly, capped at MAX_POSITION_PCT.
  // Regime multiplier: risk-off halves sizing; risk-on adds 50% (still capped).
  private kellyAllocation(opp: RankedOpportunity): number {
    const base = opp.rar7d > 1
      ? Math.min((opp.rar7d - 1) / opp.rar7d * 0.25, MAX_POSITION_PCT)
      : MAX_POSITION_PCT / TARGET_POSITIONS;
    if (this.regime === "risk-off") return base * KELLY_SCALE_RISK_OFF;
    if (this.regime === "risk-on")  return Math.min(base * KELLY_SCALE_RISK_ON, MAX_POSITION_PCT);
    return base;
  }

  // ─── Rule-based fallback: initial deployment ─────────────────────────────
  private deploy(): void {
    const candidates = this.rankedCandidates();
    if (candidates.length === 0) {
      console.log("[Portfolio] No yield opportunities available yet — will retry");
      return;
    }

    // Greedy selection: iterate ranked candidates, skip any that would breach any budget limit.
    // Uses provisional tracking maps so multi-position batches don't exceed any constraint.
    const selected:     RankedOpportunity[] = [];
    const hypTokenMap   = new Map<string, number>();  // token → provisional USD
    const hypChainMap   = new Map<string, number>();  // chain → provisional USD
    const hypIssuerMap  = new Map<string, number>();  // issuer → provisional USD
    let   hypVolUsd     = 0;
    let   hypCash       = this.cash;

    for (const c of candidates) {
      if (selected.length >= TARGET_POSITIONS) break;
      const valueUsd  = INITIAL_CAPITAL_USD * this.kellyAllocation(c);
      const [pt0, pt1] = rbPairTokens(c.pair);
      const half      = valueUsd / 2;
      const isVol     = rbIsVolatile(c.pair);

      // ── Gas break-even ──────────────────────────────────────────────────────
      const beDays = gasBreakEvenDays(c.chainId, valueUsd, c.displayAPY);
      if (beDays > MAX_BREAKEVEN_DAYS) {
        console.log(`[Portfolio] Deploy: skip ${c.pair} on ${c.chainName} — gas break-even ${beDays.toFixed(1)}d`);
        continue;
      }

      // ── Token / stable risk blocks ──────────────────────────────────────────
      if (c.tokenRisk?.blockEntry) {
        console.log(`[Portfolio] Deploy: token risk BLOCK ${c.pair} — ${c.tokenRisk.flags.join("; ")}`);
        continue;
      }
      if (c.stablecoinRisk?.blockEntry) {
        console.log(`[Portfolio] Deploy: stable depeg BLOCK ${c.pair} — ${c.stablecoinRisk.flags[0]}`);
        continue;
      }

      // ── Risk budget constraints ─────────────────────────────────────────────
      let skipReason = "";

      // Cash buffer (after this and all already-selected allocations)
      if ((hypCash - valueUsd) / INITIAL_CAPITAL_USD * 100 < RISK_BUDGET.minCashBufferPct) {
        skipReason = `cash buffer would fall to ${((hypCash - valueUsd) / INITIAL_CAPITAL_USD * 100).toFixed(0)}%`;
      }

      // Chain exposure
      if (!skipReason) {
        const after = ((hypChainMap.get(c.chainName) ?? 0) + valueUsd) / INITIAL_CAPITAL_USD * 100;
        if (after > RISK_BUDGET.maxChainExposurePct)
          skipReason = `${c.chainName} chain would reach ${after.toFixed(0)}% (max ${RISK_BUDGET.maxChainExposurePct}%)`;
      }

      // Token exposure
      if (!skipReason) {
        for (const t of [pt0, pt1]) {
          const after = ((hypTokenMap.get(t) ?? 0) + half) / INITIAL_CAPITAL_USD * 100;
          if (after > RISK_BUDGET.maxTokenExposurePct) {
            skipReason = `${t} token would reach ${after.toFixed(0)}% (max ${RISK_BUDGET.maxTokenExposurePct}%)`;
            break;
          }
        }
      }

      // Volatile pair exposure
      if (!skipReason && isVol) {
        const after = (hypVolUsd + valueUsd) / INITIAL_CAPITAL_USD * 100;
        if (after > RISK_BUDGET.maxVolatilePairExposurePct)
          skipReason = `volatile pairs would reach ${after.toFixed(0)}% (max ${RISK_BUDGET.maxVolatilePairExposurePct}%)`;
      }

      // Stablecoin issuer exposure
      if (!skipReason) {
        const seen = new Set<string>();
        for (const t of [pt0, pt1]) {
          const iss = rbIssuerOf(t);
          if (iss && !seen.has(iss)) {
            seen.add(iss);
            const after = ((hypIssuerMap.get(iss) ?? 0) + half) / INITIAL_CAPITAL_USD * 100;
            if (after > RISK_BUDGET.maxStablecoinIssuerExposurePct) {
              skipReason = `${iss} issuer would reach ${after.toFixed(0)}% (max ${RISK_BUDGET.maxStablecoinIssuerExposurePct}%)`;
              break;
            }
          }
        }
      }

      if (skipReason) {
        console.log(`[Portfolio] Deploy: skip ${c.pair} — ${skipReason}`);
        continue;
      }

      // ── Accept candidate ────────────────────────────────────────────────────
      selected.push(c);
      for (const t of [pt0, pt1]) hypTokenMap.set(t, (hypTokenMap.get(t) ?? 0) + half);
      hypChainMap.set(c.chainName, (hypChainMap.get(c.chainName) ?? 0) + valueUsd);
      if (isVol) hypVolUsd += valueUsd;
      const seen2 = new Set<string>();
      for (const t of [pt0, pt1]) {
        const iss = rbIssuerOf(t);
        if (iss && !seen2.has(iss)) { seen2.add(iss); hypIssuerMap.set(iss, (hypIssuerMap.get(iss) ?? 0) + half); }
      }
      hypCash -= valueUsd;
    }

    if (selected.length === 0) {
      console.log("[Portfolio] No deployable candidates after correlation guard — will retry");
      return;
    }

    // Normalize Kelly fractions so total allocation ≤ 100%
    const rawFracs = selected.map(c => this.kellyAllocation(c));
    const rawSum   = rawFracs.reduce((a, b) => a + b, 0);
    const scale    = rawSum > 1 ? 1 / rawSum : 1;

    for (let i = 0; i < selected.length; i++) {
      const pct = rawFracs[i] * scale;
      const usd = INITIAL_CAPITAL_USD * pct;
      this.enter(selected[i], usd, pct * 100, "Initial deployment");
      console.log(`[Portfolio] Deployed ${selected[i].pair} Kelly=${(rawFracs[i]*100).toFixed(1)}% → allocated ${(pct*100).toFixed(1)}% ($${usd.toFixed(0)})`);
    }
    this.lastRebalance = Date.now();
    this.persistState();
  }

  // ─── Rule-based fallback: rebalancing ────────────────────────────────────
  private rebalance(): void {
    const open        = this.openList();
    const allOpps     = this.reporter.getLatest();
    const candidates  = this.rankedCandidates();
    const inPortfolio = new Set(open.map(p => p.poolId));

    for (const pos of open) {
      if (pos.status !== "open") continue;
      if ((Date.now() - pos.entryTimestamp) / 3_600_000 < MIN_HOLD_HOURS) continue;

      const currentOpp = allOpps.find(o => o.poolId === pos.poolId);
      const best       = candidates.find(c => !inPortfolio.has(c.poolId));
      if (!best) continue;

      // Transaction-cost-aware switch benefit hurdle
      const sw = switchBenefitCheck(pos, currentOpp, best);
      if (!sw.ok) {
        console.log(`[Portfolio] Rebalance hold: ${sw.log}`);
        continue;
      }

      // Risk budget: check against portfolio WITHOUT the position being exited,
      // funded by the exit proceeds (simulated cash = this.cash + simProceeds).
      const openWithoutPos = open.filter(p => p.poolId !== pos.poolId);
      const simProceeds    = pos.currentValueUsd * (1 - EXIT_FEE_PCT);
      const budgetViols    = checkRiskBudget(best.pair, best.chainName, simProceeds, openWithoutPos, this.cash + simProceeds, INITIAL_CAPITAL_USD);
      if (budgetViols.length > 0) {
        console.log(`[Portfolio] Rebalance budget: skip ${best.pair} — ${budgetViols.map(v => v.message).join(" | ")}`);
        continue;
      }

      const reason   = `Rebalanced: ${sw.log}`;
      const proceeds = this.exit(pos, reason);
      this.enter(best, proceeds, pos.allocationPct, `Rebalanced from ${pos.pair}`);
      this.lastRebalance = Date.now();
      this.persistState();

      inPortfolio.delete(pos.poolId);
      inPortfolio.add(best.poolId);

      console.log(`[Portfolio] Rebalanced ${pos.pair} → ${best.pair}: benefit=$${sw.benefit.toFixed(2)} hurdle=$${sw.hurdle.toFixed(2)}`);
    }
  }

  // ─── Exit trigger evaluation ─────────────────────────────────────────────
  private evaluateExitTriggers(): void {
    const allOpps = this.reporter.getLatest();
    const open    = this.openList();
    if (open.length === 0) return;

    // Best candidate NOT currently held — used for "better opportunity" trigger
    const held    = new Set(open.map(p => p.poolId));
    const bestOpp = [...allOpps]
      .filter(o => !held.has(o.poolId) && o.displayAPY > 0)
      .sort(rarOrApySort)[0] ?? null;

    for (const pos of open) {
      const opp        = allOpps.find(o => o.poolId === pos.poolId);
      const currentRAR  = opp?.rar7d  ?? 0;
      const currentNet  = opp?.netAPY ?? pos.entryAPY;
      const pairMovePct = Math.abs((opp?.pairPriceChange7d ?? 0) * 100);
      this.recordPredictiveSignals(pos, opp);

      // TiR based on actual 2σ tick range stored at entry.
      // rangeFraction: 0 = at center, 1 = at range boundary, 2 = 2× out of range.
      // Linear decay: 100% at center → 50% at boundary → 0% at 2× outside.
      const halfRange = pos.halfRangePct > 0 ? pos.halfRangePct : 5;
      const rangeFraction = pairMovePct / halfRange;
      pos.timeInRangePct = Math.max(0, Math.min(100, Math.round((1 - rangeFraction / 2) * 100)));

      const heldH  = pos.hoursHeld;
      const alerts: string[] = [];

      // 1. RAR deteriorated (only meaningful if both entry and current RAR are available)
      if (pos.entryRAR7d > 0 && currentRAR > 0 && currentRAR < pos.entryRAR7d * RAR_DETERIORATION_RATIO) {
        const drop = ((1 - currentRAR / pos.entryRAR7d) * 100).toFixed(0);
        alerts.push(`RAR deteriorated: ${pos.entryRAR7d.toFixed(2)} → ${currentRAR.toFixed(2)} (−${drop}% from entry)`);
      }

      // 2. Better opportunity exists
      if (bestOpp && bestOpp.rar7d > 0 && currentRAR > 0 && bestOpp.rar7d > currentRAR * BETTER_OPP_RAR_RATIO) {
        const pct = ((bestOpp.rar7d / currentRAR - 1) * 100).toFixed(0);
        alerts.push(`Better opportunity: ${bestOpp.pair} RAR ${bestOpp.rar7d.toFixed(2)} vs ${currentRAR.toFixed(2)} (+${pct}%)`);
      }

      // 3. Significant price move (IL accelerates)
      if (opp && pairMovePct > PRICE_MOVE_THRESHOLD_PCT) {
        const dir = (opp.pairPriceChange7d > 0 ? "+" : "") + (opp.pairPriceChange7d * 100).toFixed(1);
        alerts.push(`Price move ${dir}% in 7d — IL risk (threshold ±${PRICE_MOVE_THRESHOLD_PCT}%)`);
      }

      // 4. Time-in-range below threshold
      if (pos.timeInRangePct < TIME_IN_RANGE_MIN_PCT) {
        alerts.push(`Out of range: ~${pos.timeInRangePct.toFixed(0)}% time-in-range (< ${TIME_IN_RANGE_MIN_PCT}%)`);
      }

      // 5. Predictive RAR momentum: falling for 3 consecutive ticks
      const rarTrendAlert = predictiveRarAlert(pos);
      if (rarTrendAlert) alerts.push(rarTrendAlert);

      // 6. Predictive negative price momentum: 24h drawdown accelerating
      const negMomentumAlert = predictiveNegativeMomentumAlert(pos);
      if (negMomentumAlert) alerts.push(negMomentumAlert);

      // 7. Stale and low-yield
      if (heldH > STALE_DAYS * 24 && currentNet < STALE_NET_APY_MIN) {
        alerts.push(`Stale: ${(heldH / 24).toFixed(0)}d held, netAPY ${currentNet.toFixed(1)}% < ${STALE_NET_APY_MIN}%`);
      }

      pos.exitAlerts = alerts;

      // ── Auto-exit: fire when held ≥ minimum and at least one trigger is active ──
      if (heldH < MIN_HOLD_HOURS || alerts.length === 0) continue;

      const [reason] = alerts;
      console.log(`[Portfolio] Exit trigger — ${pos.pair}@${pos.chainName}: ${reason}`);
      this.exit(pos, reason);
      this.lastRebalance = Date.now();
      this.persistState();
    }
  }

  private recordPredictiveSignals(pos: MockPosition, opp: RankedOpportunity | undefined): void {
    pos.rarTrend = Array.isArray(pos.rarTrend) ? pos.rarTrend : [];
    pos.pairMove24hTrend = Array.isArray(pos.pairMove24hTrend) ? pos.pairMove24hTrend : [];

    if (opp?.rar7d && opp.rar7d > 0 && Number.isFinite(opp.rar7d)) {
      pushBounded(pos.rarTrend, +opp.rar7d.toFixed(6), RAR_TREND_TICKS);
    }
    if (opp && Number.isFinite(opp.pairPriceChange24h)) {
      pushBounded(pos.pairMove24hTrend, +(opp.pairPriceChange24h * 100).toFixed(4), RAR_TREND_TICKS);
    }
  }

  // ─── Simulated LP value accrual ──────────────────────────────────────────
  private updateValues(): void {
    for (const pos of this.openList()) {
      const yrs = (Date.now() - pos.entryTimestamp) / (365 * 24 * 3_600_000);
      // Concentrated LP earns fees only while in range — scale by TiR fraction
      const tirFraction   = pos.timeInRangePct / 100;
      pos.earnedFeesUsd   = pos.entryValueUsd * (pos.entryAPY / 100) * yrs * tirFraction;
      pos.currentValueUsd = pos.entryValueUsd + pos.earnedFeesUsd;
      pos.pnlUsd          = pos.currentValueUsd - pos.entryValueUsd;
      pos.pnlPct          = (pos.pnlUsd / pos.entryValueUsd) * 100;
      pos.hoursHeld       = (Date.now() - pos.entryTimestamp) / 3_600_000;
    }
  }

  // ─── Trade helpers ───────────────────────────────────────────────────────
  private enter(
    opp:           RankedOpportunity,
    spend:         number,
    allocationPct: number,
    reason:        string,
    agentDecision?: AgentDecision,
  ): void {
    const fee      = spend * ENTRY_FEE_PCT;
    const invested = spend - fee;
    this.cash     -= spend;
    this.feesPaid += fee;

    const { tickLower, tickUpper, halfRangePct } = computeTickRange(opp);

    const conditions: MarketConditions = {
      rar7d:    opp.rar7d,
      vol7d:    opp.vol7d,
      change7d: opp.pairPriceChange7d * 100,
    };
    const decisionSummary: DecisionSummary = agentDecision ? {
      action:             agentDecision.action as DecisionSummary["action"],
      confidence:         agentDecision.confidence,
      allocationPct:      agentDecision.allocationPct,
      reasoning:          agentDecision.reasoning,
      vetoed:             false,
      critiqueReasoning:  agentDecision.critique?.reasoning,
    } : {
      action:     "enter",
      confidence: 1,
      reasoning:  reason,
      vetoed:     false,
    };
    this.memory.recordEntry(opp.poolId, opp.pair, opp.chainName, conditions, decisionSummary);

    const pos: MockPosition = {
      id:              nextId(),
      poolId:          opp.poolId,
      chainId:         opp.chainId,
      chainName:       opp.chainName,
      pair:            opp.pair,
      feeTierLabel:    opp.feeTierLabel,
      entryTimestamp:  Date.now(),
      entryValueUsd:   invested,
      allocationPct,
      entryAPY:        opp.displayAPY,
      entryRAR7d:      opp.rar7d,
      currentValueUsd: invested,
      earnedFeesUsd:   0,
      pnlUsd:          0,
      pnlPct:          0,
      hoursHeld:       0,
      status:          "open",
      tickLower,
      tickUpper,
      halfRangePct,
      timeInRangePct:  100,
      exitAlerts:      [],
      rarTrend:        [],
      pairMove24hTrend: [],
    };
    this.positions.set(opp.poolId, pos);
    this.trades.push({
      id: pos.id, timestamp: Date.now(), action: "open",
      poolId: opp.poolId, pair: opp.pair, chainName: opp.chainName,
      feeTierLabel: opp.feeTierLabel, valueUsd: invested,
      apy: opp.displayAPY, rar7d: opp.rar7d, feePaidUsd: fee, reason,
    });
    this.persistState();
  }

  private exit(pos: MockPosition, reason: string): number {
    const fee      = pos.currentValueUsd * EXIT_FEE_PCT;
    const proceeds = pos.currentValueUsd - fee;
    this.cash     += proceeds;
    this.feesPaid += fee;

    const outcome: DecisionOutcome = {
      actualAPY:   pos.hoursHeld >= 1
        ? (pos.earnedFeesUsd / pos.entryValueUsd) / pos.hoursHeld * 8760 * 100
        : 0,
      ilCost:      0,
      netReturn:   proceeds - pos.entryValueUsd,
      daysHeld:    pos.hoursHeld / 24,
      closeReason: reason,
    };
    this.memory.recordExit(pos.poolId, outcome);

    pos.status          = "closed";
    pos.closedTimestamp = Date.now();
    pos.closedValueUsd  = proceeds;
    pos.closeReason     = reason;

    this.trades.push({
      id: nextId(), timestamp: Date.now(), action: "close",
      poolId: pos.poolId, pair: pos.pair, chainName: pos.chainName,
      feeTierLabel: pos.feeTierLabel, valueUsd: proceeds,
      apy: pos.entryAPY, rar7d: pos.entryRAR7d, feePaidUsd: fee, reason,
    });
    this.persistState();
    return proceeds;
  }

  // ─── Opportunity ranking ─────────────────────────────────────────────────
  // In risk-off, stable-stable pools are promoted to the front of the list.
  private rankedCandidates(): RankedOpportunity[] {
    const opps = this.reporter.getLatest()
      .filter(o => o.displayAPY > 0)
      .sort(rarOrApySort);
    if (this.regime === "risk-off") {
      const stable = opps.filter(o =>  isStablePool(o.pair));
      const other  = opps.filter(o => !isStablePool(o.pair));
      return [...stable, ...other];
    }
    return opps;
  }

  private openList(): MockPosition[] {
    return [...this.positions.values()].filter(p => p.status === "open");
  }

  // ─── Macro regime detection ───────────────────────────────────────────────
  // Compute median 7-day price change across all ETH-containing pools.
  // Risk-off < -5%, neutral -5%–+5%, risk-on > +5%.
  private detectRegime(): MacroRegime {
    const ethPairs = this.reporter.getLatest()
      .filter(o => rbPairTokens(o.pair).includes("ETH"));
    if (ethPairs.length === 0) return "neutral";

    const changes = ethPairs
      .map(o => o.pairPriceChange7d * 100)
      .sort((a, b) => a - b);
    const mid    = Math.floor(changes.length / 2);
    const median = changes.length % 2 === 1
      ? changes[mid]
      : (changes[mid - 1] + changes[mid]) / 2;

    if (median < -REGIME_ETH_THRESHOLD_PCT) return "risk-off";
    if (median >  REGIME_ETH_THRESHOLD_PCT) return "risk-on";
    return "neutral";
  }

  // ─── Public API ──────────────────────────────────────────────────────────
  getSummary(): PortfolioSummary {
    this.updateValues();
    const all         = [...this.positions.values()];
    const open        = all.filter(p => p.status === "open");
    const closed      = all.filter(p => p.status === "closed");
    const investedUsd = open.reduce((s, p) => s + p.currentValueUsd, 0);
    const totalValue  = this.cash + investedUsd;
    const unrealizedPnl = totalValue - INITIAL_CAPITAL_USD;

    const realizedPnlUsd     = closed.reduce((s, p) => s + ((p.closedValueUsd ?? p.entryValueUsd) - p.entryValueUsd), 0);
    const totalEarnedFeesUsd = all.reduce((s, p) => s + p.earnedFeesUsd, 0);

    // Primary decision from the last LLM cycle (first non-hold, or the hold itself)
    const lastDecision = this.lastCycle?.decisions.find(d => d.action !== "hold" && d.action !== "wait")
      ?? this.lastCycle?.decisions[0]
      ?? null;

    const expMap      = tokenExposureMap(open);
    const tokenExposure: Record<string, number> = {};
    for (const [token, usd] of expMap) {
      tokenExposure[token] = +(usd / INITIAL_CAPITAL_USD * 100).toFixed(1);
    }

    return {
      totalCapitalUsd:        INITIAL_CAPITAL_USD,
      cashUsd:                +this.cash.toFixed(2),
      investedUsd:            +investedUsd.toFixed(2),
      totalValueUsd:          +totalValue.toFixed(2),
      unrealizedPnlUsd:       +unrealizedPnl.toFixed(2),
      unrealizedPnlPct:       +(unrealizedPnl / INITIAL_CAPITAL_USD * 100).toFixed(4),
      realizedPnlUsd:         +realizedPnlUsd.toFixed(2),
      totalEarnedFeesUsd:     +totalEarnedFeesUsd.toFixed(2),
      totalFeesPaidUsd:       +this.feesPaid.toFixed(2),
      openPositions:          open.length,
      tradeCount:             this.trades.length,
      lastRebalanceTimestamp: this.lastRebalance,
      llmEnabled:             this.llmReady,
      lastDecision,
      lastDecisionAt:         this.lastCycle?.timestamp ?? null,
      tokenExposure,
      regime:                 this.regime,
      riskBudget:             computeRiskBudgetState([...this.positions.values()], this.cash, INITIAL_CAPITAL_USD),
      portfolioOptimization:  this.latestOptimization,
    };
  }

  getPositions(): MockPosition[] {
    this.updateValues();
    return [...this.positions.values()];
  }

  getTrades(): PortfolioTrade[] {
    return [...this.trades];
  }

  getOptimization(): OptimizationResult | null {
    return this.latestOptimization;
  }

  getDecisionHistory(limit = 20): DecisionCycle[] {
    return this.decisionHistory.slice(0, limit);
  }

  private restoreState(): void {
    try {
      const snapshot = this.snapshots.load<PortfolioSnapshot>("portfolio.state");
      if (!snapshot) return;

      this.cash            = snapshot.cash ?? INITIAL_CAPITAL_USD;
      this.positions       = new Map((snapshot.positions ?? []).map(p => [p.poolId, p]));
      this.trades          = snapshot.trades ?? [];
      this.feesPaid        = snapshot.feesPaid ?? 0;
      this.lastRebalance   = snapshot.lastRebalance ?? null;
      this.lastCycle       = snapshot.lastCycle ?? null;
      this.decisionHistory = snapshot.decisionHistory ?? [];
      this.regime          = snapshot.regime ?? "neutral";
      this.updateValues();

      console.log(
        `[Portfolio] Restored state from SQLite snapshot: ` +
        `$${this.cash.toFixed(2)} cash, ${this.openList().length} open position(s), ${this.trades.length} trade(s)`,
      );
    } catch (err) {
      console.warn(`[Portfolio] Failed to restore snapshot: ${portfolioErrorMessage(err)}`);
    }
  }

  private persistState(): void {
    try {
      this.snapshots.save<PortfolioSnapshot>("portfolio.state", {
        cash:            this.cash,
        positions:       [...this.positions.values()],
        trades:          this.trades,
        feesPaid:        this.feesPaid,
        lastRebalance:   this.lastRebalance,
        lastCycle:       this.lastCycle,
        decisionHistory: this.decisionHistory,
        regime:          this.regime,
        savedAt:         Date.now(),
      });
    } catch (err) {
      console.warn(`[Portfolio] Failed to persist snapshot: ${portfolioErrorMessage(err)}`);
    }
  }
}

// ─── Tick range calculator ────────────────────────────────────────────────────
// Uniswap v4: price = 1.0001^tick  →  tickDelta = ln(1 + pct/100) / ln(1.0001)
// Range = ±2σ (vol7d × 2%) — covers ~95% of 7-day price movement.
// Tick math uses the same log-base-1.0001 formula as Uniswap v4.
// nearestUsableTick (Uniswap v3/v4 SDK) snaps to the nearest valid spacing
// multiple; we pass the ceiling so the range is always at least as wide as 2σ.
// Results are clamped to TickMath.MIN_TICK / MAX_TICK (±887272).

const LN_1_0001 = Math.log(1.0001); // ≈ 9.9995e-5

function computeTickRange(opp: RankedOpportunity): {
  tickLower:    number;
  tickUpper:    number;
  halfRangePct: number;
} {
  const vol          = opp.vol7d > 0 ? opp.vol7d : 5;
  const halfRangePct = vol * 2;
  const rawHalfTicks = Math.log(1 + halfRangePct / 100) / LN_1_0001;
  const spacing      = TICK_SPACINGS[opp.feeTier as FeeTier] ?? 60;
  // Snap to nearest valid tick multiple (outward: ceil before passing to SDK)
  const rawCeiled    = Math.ceil(rawHalfTicks / spacing) * spacing;
  const halfTicks    = Math.min(
    nearestUsableTick(rawCeiled, spacing),
    TickMath.MAX_TICK,
  );
  return { tickLower: -halfTicks, tickUpper: halfTicks, halfRangePct };
}

// ─── Token exposure map (used only for PortfolioSummary.tokenExposure) ────────

/** Sum each token's USD exposure across open positions (50/50 split per position). */
function tokenExposureMap(positions: MockPosition[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const pos of positions) {
    const half = pos.currentValueUsd / 2;
    for (const token of rbPairTokens(pos.pair)) {
      map.set(token, (map.get(token) ?? 0) + half);
    }
  }
  return map;
}

function pushBounded(series: number[], value: number, maxLength: number): void {
  series.push(value);
  while (series.length > maxLength) series.shift();
}

function predictiveRarAlert(pos: MockPosition): string | null {
  const trend = pos.rarTrend ?? [];
  if (trend.length < RAR_TREND_TICKS) return null;
  const [first, second, third] = trend;
  if (!(first > second && second > third)) return null;
  const dropPct = first > 0 ? (1 - third / first) * 100 : 0;
  if (dropPct < RAR_TREND_MIN_DROP_PCT) return null;
  return `Predictive RAR momentum: ${first.toFixed(2)} → ${second.toFixed(2)} → ${third.toFixed(2)} (${dropPct.toFixed(0)}% drop over ${RAR_TREND_TICKS} ticks)`;
}

function predictiveNegativeMomentumAlert(pos: MockPosition): string | null {
  const trend = pos.pairMove24hTrend ?? [];
  if (trend.length < RAR_TREND_TICKS) return null;
  const [first, second, third] = trend;
  const acceleratingLower = second <= first - NEG_MOMENTUM_STEP_PCT
    && third <= second - NEG_MOMENTUM_STEP_PCT;
  if (!(first < 0 && second < 0 && third < 0 && acceleratingLower)) return null;
  return `Predictive negative momentum: 24h move ${first.toFixed(1)}% → ${second.toFixed(1)}% → ${third.toFixed(1)}%`;
}

// ─── Switch benefit check ────────────────────────────────────────────────────
// Computes the net dollar benefit of moving from `pos` to `best` over HOLD_HORIZON_DAYS.
// Returns ok=false when the projected gain doesn't clear the minimum hurdle after
// accounting for exit gas, entry gas, and round-trip swap slippage.
//
// Uses effectiveNetAPY (= netAPY × capitalUtilization) so out-of-range risk is priced in.
// Falls back to netAPY when capital efficiency hasn't been computed yet (early cycles).
interface SwitchCheck {
  ok:      boolean;
  benefit: number;  // USD projected gain over horizon, after all costs
  hurdle:  number;  // USD minimum benefit required
  log:     string;  // single-line label for console output
}

function switchBenefitCheck(
  pos:     MockPosition,
  current: RankedOpportunity | undefined,
  best:    RankedOpportunity,
): SwitchCheck {
  const currentEffAPY = (current?.effectiveNetAPY ?? 0) > 0
    ? current!.effectiveNetAPY
    : (current?.netAPY ?? pos.entryAPY);
  const bestEffAPY = best.effectiveNetAPY > 0 ? best.effectiveNetAPY : best.netAPY;

  const posValue = pos.currentValueUsd;
  const retNew   = posValue * (bestEffAPY    / 100) / 365 * HOLD_HORIZON_DAYS;
  const retCur   = posValue * (currentEffAPY / 100) / 365 * HOLD_HORIZON_DAYS;

  // Per-chain gas for each leg; slippage = round-trip swap spread
  const gasCostExit  = GAS_COST_USD[pos.chainId]  ?? GAS_COST_USD_FALLBACK;
  const gasCostEntry = GAS_COST_USD[best.chainId] ?? GAS_COST_USD_FALLBACK;
  const slippage     = posValue * (ENTRY_FEE_PCT + EXIT_FEE_PCT);
  const totalCost    = gasCostExit + gasCostEntry + slippage;

  const benefit = retNew - retCur - totalCost;
  const hurdle  = posValue * MIN_SWITCH_BENEFIT_PCT;
  const ok      = benefit >= hurdle;

  const log = `${pos.pair}→${best.pair}: ` +
    `benefit=$${benefit.toFixed(2)} hurdle=$${hurdle.toFixed(2)} ` +
    `(effAPY ${bestEffAPY.toFixed(1)}% vs ${currentEffAPY.toFixed(1)}%, ` +
    `cost=$${totalCost.toFixed(2)})`;

  return { ok, benefit, hurdle, log };
}

// Prefer RAR-7d × capitalUtilization when both sides have it; else rank by effectiveNetAPY.
// Combined rank factor: sqrt(lq/100) × persistence.
function rarOrApySort(a: RankedOpportunity, b: RankedOpportunity): number {
  const fa  = rankFactor(a.liquidityQuality ?? 50, a.apyPersistence ?? 1.0);
  const fb  = rankFactor(b.liquidityQuality ?? 50, b.apyPersistence ?? 1.0);
  const cua = (a.capitalUtilization ?? 0) > 0 ? a.capitalUtilization : 1.0;
  const cub = (b.capitalUtilization ?? 0) > 0 ? b.capitalUtilization : 1.0;
  if (a.rar7d > 0 && b.rar7d > 0) return b.rar7d * cub * fb - a.rar7d * cua * fa;
  if (a.rar7d > 0) return -1;
  if (b.rar7d > 0) return 1;
  const effA = (a.effectiveNetAPY ?? 0) > 0 ? a.effectiveNetAPY : a.netAPY;
  const effB = (b.effectiveNetAPY ?? 0) > 0 ? b.effectiveNetAPY : b.netAPY;
  return effB * fb - effA * fa;
}

function portfolioErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
