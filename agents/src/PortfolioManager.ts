import type { ReporterAgent, RankedOpportunity } from "./ReporterAgent";
import { ZeroGMemory }  from "./storage/ZeroGMemory";
import { LLMClient }    from "./llm/LLMClient";
import type { AgentDecision, DecisionCycle } from "./llm/LLMClient";

// ─── Config ───────────────────────────────────────────────────────────────────
const INITIAL_CAPITAL_USD = 10_000;
const MAX_POSITION_PCT    = 0.30;   // max 30% of capital per pair
const TARGET_POSITIONS    = 4;      // aim for this many concurrent positions
const REBALANCE_THRESHOLD = 0.30;   // candidate must have 30% better RAR7d to trigger
const MIN_HOLD_HOURS      = 24;     // never rebalance a position younger than this
const MAX_BREAKEVEN_DAYS  = 7;      // only rebalance if fee recovers within this many days
const ENTRY_FEE_PCT        = 0.001;  // 0.1% simulated swap cost to enter
const EXIT_FEE_PCT         = 0.001;  // 0.1% simulated swap cost to exit
const CHECK_INTERVAL_MS    = 5 * 60_000;
const CONFIDENCE_THRESHOLD = 0.75;
const DECISION_HISTORY_MAX = 50;

// ─── Exit trigger thresholds ─────────────────────────────────────────────────
const RAR_DETERIORATION_RATIO  = 0.50;  // exit if current RAR7d < entry × 0.5
const BETTER_OPP_RAR_RATIO     = 1.50;  // flag/exit if competitor RAR7d > current × 1.5
const PRICE_MOVE_THRESHOLD_PCT = 15;    // exit if |pairPriceChange7d| > 15%
const TIME_IN_RANGE_MIN_PCT    = 80;    // exit if estimated time-in-range < 80%
const STALE_DAYS               = 30;    // position is "stale" after this many days
const STALE_NET_APY_MIN        = 5;     // stale position must have at least this net APY

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
  /** 0–100. Estimated % of time price was within tick range (proxy: decreases with pair price divergence). */
  timeInRangePct:  number;
  /** Active exit trigger descriptions. Updated every tick; empty = healthy. */
  exitAlerts:      string[];
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
}

export type { AgentDecision, DecisionCycle };

// ─── PortfolioManager ─────────────────────────────────────────────────────────

export class PortfolioManager {
  private reporter:      ReporterAgent;
  private cash:          number = INITIAL_CAPITAL_USD;
  private positions:     Map<string, MockPosition> = new Map();
  private trades:        PortfolioTrade[] = [];
  private feesPaid:      number = 0;
  private lastRebalance: number | null = null;
  private running        = false;

  private memory:          ZeroGMemory;
  private llm:             LLMClient | null = null;
  private llmReady         = false;
  private lastCycle:       DecisionCycle | null = null;
  private decisionHistory: DecisionCycle[] = [];

  constructor(reporter: ReporterAgent) {
    this.reporter = reporter;
    this.memory   = new ZeroGMemory();
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

  stop(): void { this.running = false; }

  // ─── Main tick ───────────────────────────────────────────────────────────
  private async tick(): Promise<void> {
    this.updateValues();

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
        this.executeDecision(d);
      }

      // Persist primary (non-hold) decision to 0G memory
      const primary = cycle.decisions.find(d => d.action !== "hold" && d.action !== "wait")
        ?? cycle.decisions[0];
      if (primary) {
        await this.memory.append({
          timestamp: cycle.timestamp,
          action:    primary.action as any,
          poolId:    primary.pool,
          reasoning: cycle.reasoning || primary.reasoning,
        });
      }

      this.lastRebalance = Date.now();
    } catch (err: any) {
      console.warn(`[Portfolio] LLM failed (${err.message}), falling back to rule-based`);
      if (trigger === "deploy") this.deploy();
      else                      this.rebalance();
    }
  }

  private executeDecision(d: AgentDecision): void {
    switch (d.action) {
      case "enter":
        if (d.pool) this.toolOpen(d.pool, d.reasoning, d.allocationPct);
        break;

      case "exit":
        if (d.pool) this.toolClose(d.pool, d.reasoning);
        break;

      case "rebalance": {
        // Close weakest current position, then enter the target pool
        const worst = this.openList()
          .sort((a, b) => a.pnlPct - b.pnlPct)[0];
        if (worst) {
          this.toolClose(worst.poolId, `Rebalancing into ${d.pool}: ${d.reasoning}`);
        }
        if (d.pool) this.toolOpen(d.pool, d.reasoning, d.allocationPct);
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

  private toolOpen(poolId: string, reason: string, allocationPct?: number): boolean {
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

    this.enter(opp, INITIAL_CAPITAL_USD * pct, pct * 100, reason);
    this.lastRebalance = Date.now();
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
    console.log(`[Portfolio] closed ${pos.pair} — proceeds $${proceeds.toFixed(2)}`);
    return true;
  }

  // ─── Kelly-inspired position sizing ─────────────────────────────────────
  // f* = (RAR − 1) / RAR, scaled to ¼ Kelly, capped at MAX_POSITION_PCT.
  // Falls back to equal-weight when RAR ≤ 1 or unavailable.
  private kellyAllocation(opp: RankedOpportunity): number {
    if (opp.rar7d > 1) {
      const full = (opp.rar7d - 1) / opp.rar7d;
      return Math.min(full * 0.25, MAX_POSITION_PCT);
    }
    return MAX_POSITION_PCT / TARGET_POSITIONS;  // equal-weight fallback
  }

  // ─── Rule-based fallback: initial deployment ─────────────────────────────
  private deploy(): void {
    const candidates = this.rankedCandidates();
    if (candidates.length === 0) {
      console.log("[Portfolio] No yield opportunities available yet — will retry");
      return;
    }

    const n   = Math.min(candidates.length, TARGET_POSITIONS);
    const top = candidates.slice(0, n);

    // Compute raw Kelly allocations then normalize so they sum to ≤ 1
    const rawFracs = top.map(c => this.kellyAllocation(c));
    const rawSum   = rawFracs.reduce((a, b) => a + b, 0);
    const scale    = rawSum > 1 ? 1 / rawSum : 1;

    for (let i = 0; i < n; i++) {
      const pct = rawFracs[i] * scale;
      const usd = INITIAL_CAPITAL_USD * pct;
      this.enter(top[i], usd, pct * 100, "Initial deployment");
      console.log(`[Portfolio] Deployed ${top[i].pair} Kelly=${(rawFracs[i]*100).toFixed(1)}% → allocated ${(pct*100).toFixed(1)}% ($${usd.toFixed(0)})`);
    }
    this.lastRebalance = Date.now();
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
      const currentRAR = currentOpp?.rar7d    ?? pos.entryRAR7d;
      const currentAPY = currentOpp?.displayAPY ?? pos.entryAPY;

      const best = candidates.find(c => !inPortfolio.has(c.poolId));
      if (!best) continue;

      // Compare by RAR when available; fall back to APY-only comparison
      const hasRAR = best.rar7d > 0 && currentRAR > 0;
      if (hasRAR) {
        if (best.rar7d <= currentRAR * (1 + REBALANCE_THRESHOLD)) continue;
      } else {
        if (best.displayAPY <= currentAPY * (1 + REBALANCE_THRESHOLD)) continue;
      }

      const cost        = pos.currentValueUsd * (ENTRY_FEE_PCT + EXIT_FEE_PCT);
      const extraPerDay = pos.currentValueUsd * (best.displayAPY - currentAPY) / 100 / 365;
      if (extraPerDay <= 0 || cost / extraPerDay > MAX_BREAKEVEN_DAYS) continue;

      const rarLabel = hasRAR
        ? `RAR ${best.rar7d.toFixed(2)} vs ${currentRAR.toFixed(2)}`
        : `APY ${best.displayAPY.toFixed(1)}% vs ${currentAPY.toFixed(1)}%`;
      const reason   = `Rebalanced: ${best.pair} ${rarLabel} (fee recovers in ${(cost / extraPerDay).toFixed(1)}d)`;
      const proceeds = this.exit(pos, reason);
      this.enter(best, proceeds, pos.allocationPct, `Rebalanced from ${pos.pair}`);
      this.lastRebalance = Date.now();

      inPortfolio.delete(pos.poolId);
      inPortfolio.add(best.poolId);

      console.log(`[Portfolio] Rebalanced ${pos.pair} → ${best.pair}`);
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
      const currentRAR = opp?.rar7d     ?? 0;
      const currentNet = opp?.netAPY    ?? pos.entryAPY;
      const pairMove   = Math.abs(opp?.pairPriceChange7d ?? 0) * 100; // %

      // Time-in-range proxy: 100% at <5% price move, drops ~4%/pct-move beyond that
      // Represents a ±10% tick range — drifts out as price diverges
      pos.timeInRangePct = Math.max(0, Math.min(100, 100 - Math.max(0, pairMove - 5) * 4));

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
      if (opp && pairMove > PRICE_MOVE_THRESHOLD_PCT) {
        const dir = (opp.pairPriceChange7d > 0 ? "+" : "") + (opp.pairPriceChange7d * 100).toFixed(1);
        alerts.push(`Price move ${dir}% in 7d — IL risk (threshold ±${PRICE_MOVE_THRESHOLD_PCT}%)`);
      }

      // 4. Time-in-range below threshold
      if (pos.timeInRangePct < TIME_IN_RANGE_MIN_PCT) {
        alerts.push(`Out of range: ~${pos.timeInRangePct.toFixed(0)}% time-in-range (< ${TIME_IN_RANGE_MIN_PCT}%)`);
      }

      // 5. Stale and low-yield
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
    }
  }

  // ─── Simulated LP value accrual ──────────────────────────────────────────
  private updateValues(): void {
    for (const pos of this.openList()) {
      const yrs           = (Date.now() - pos.entryTimestamp) / (365 * 24 * 3_600_000);
      pos.earnedFeesUsd   = pos.entryValueUsd * (pos.entryAPY / 100) * yrs;
      pos.currentValueUsd = pos.entryValueUsd + pos.earnedFeesUsd;
      pos.pnlUsd          = pos.currentValueUsd - pos.entryValueUsd;
      pos.pnlPct          = (pos.pnlUsd / pos.entryValueUsd) * 100;
      pos.hoursHeld       = (Date.now() - pos.entryTimestamp) / 3_600_000;
    }
  }

  // ─── Trade helpers ───────────────────────────────────────────────────────
  private enter(opp: RankedOpportunity, spend: number, allocationPct: number, reason: string): void {
    const fee      = spend * ENTRY_FEE_PCT;
    const invested = spend - fee;
    this.cash     -= spend;
    this.feesPaid += fee;

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
      timeInRangePct:  100,
      exitAlerts:      [],
    };
    this.positions.set(opp.poolId, pos);
    this.trades.push({
      id: pos.id, timestamp: Date.now(), action: "open",
      poolId: opp.poolId, pair: opp.pair, chainName: opp.chainName,
      feeTierLabel: opp.feeTierLabel, valueUsd: invested,
      apy: opp.displayAPY, rar7d: opp.rar7d, feePaidUsd: fee, reason,
    });
  }

  private exit(pos: MockPosition, reason: string): number {
    const fee      = pos.currentValueUsd * EXIT_FEE_PCT;
    const proceeds = pos.currentValueUsd - fee;
    this.cash     += proceeds;
    this.feesPaid += fee;

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
    return proceeds;
  }

  // ─── Opportunity ranking ─────────────────────────────────────────────────
  private rankedCandidates(): RankedOpportunity[] {
    return this.reporter.getLatest()
      .filter(o => o.displayAPY > 0)
      .sort(rarOrApySort);
  }

  private openList(): MockPosition[] {
    return [...this.positions.values()].filter(p => p.status === "open");
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
    };
  }

  getPositions(): MockPosition[] {
    this.updateValues();
    return [...this.positions.values()];
  }

  getTrades(): PortfolioTrade[] {
    return [...this.trades];
  }

  getDecisionHistory(limit = 20): DecisionCycle[] {
    return this.decisionHistory.slice(0, limit);
  }
}

// Prefer RAR-7d when both sides have it; otherwise rank by net APY (fee APY − expected IL)
function rarOrApySort(a: RankedOpportunity, b: RankedOpportunity): number {
  if (a.rar7d > 0 && b.rar7d > 0) return b.rar7d - a.rar7d;
  if (a.rar7d > 0) return -1;
  if (b.rar7d > 0) return 1;
  return b.netAPY - a.netAPY;
}
