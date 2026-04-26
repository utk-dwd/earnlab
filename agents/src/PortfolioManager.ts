import type { ReporterAgent, RankedOpportunity } from "./ReporterAgent";

// ─── Config ───────────────────────────────────────────────────────────────────
const INITIAL_CAPITAL_USD = 10_000;
const MAX_POSITION_PCT    = 0.30;   // max 30% of capital per pair
const TARGET_POSITIONS    = 4;      // aim for this many concurrent positions
const REBALANCE_THRESHOLD = 0.30;   // candidate must have 30% better RAR7d to trigger
const MIN_HOLD_HOURS      = 24;     // never rebalance a position younger than this
const MAX_BREAKEVEN_DAYS  = 7;      // only rebalance if fee recovers within this many days
const ENTRY_FEE_PCT       = 0.001;  // 0.1% simulated swap cost to enter
const EXIT_FEE_PCT        = 0.001;  // 0.1% simulated swap cost to exit
const CHECK_INTERVAL_MS   = 5 * 60_000;

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
  entryValueUsd:   number;    // USD invested after entry fee
  allocationPct:   number;    // % of initial capital (e.g. 25)
  entryAPY:        number;
  entryRAR7d:      number;
  currentValueUsd: number;    // simulated: entryValue + accrued fees
  earnedFeesUsd:   number;
  pnlUsd:          number;
  pnlPct:          number;
  hoursHeld:       number;
  status:          "open" | "closed";
  closedTimestamp?: number;
  closedValueUsd?:  number;
  closeReason?:     string;
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
  realizedPnlUsd:         number;   // PnL locked in from closed positions
  totalEarnedFeesUsd:     number;   // LP fee income across all positions
  totalFeesPaidUsd:       number;   // swap fees paid to enter/exit
  openPositions:          number;
  tradeCount:             number;
  lastRebalanceTimestamp: number | null;
}

// ─── PortfolioManager ────────────────────────────────────────────────────────

export class PortfolioManager {
  private reporter:      ReporterAgent;
  private cash:          number = INITIAL_CAPITAL_USD;
  private positions:     Map<string, MockPosition> = new Map();
  private trades:        PortfolioTrade[] = [];
  private feesPaid:      number = 0;
  private lastRebalance: number | null = null;
  private running        = false;

  constructor(reporter: ReporterAgent) {
    this.reporter = reporter;
  }

  async start(): Promise<void> {
    this.running = true;
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
    if (this.openList().length === 0) {
      this.deploy();
    } else {
      this.rebalance();
    }
  }

  // ─── Initial deployment ──────────────────────────────────────────────────
  private deploy(): void {
    const candidates = this.rankedCandidates();
    if (candidates.length === 0) {
      const total = this.reporter.getLatest().length;
      const withRar = this.reporter.getLatest().filter(o => o.rar7d > 0).length;
      console.log(`[Portfolio] Waiting for RAR data — ${withRar}/${total} pools enriched`);
      return;
    }

    const n   = Math.min(candidates.length, TARGET_POSITIONS);
    const pct = Math.min(MAX_POSITION_PCT, 1 / n);   // e.g. 4 positions → 25% each

    for (let i = 0; i < n; i++) {
      this.enter(candidates[i], INITIAL_CAPITAL_USD * pct, pct * 100, "Initial deployment");
    }
    this.lastRebalance = Date.now();
    console.log(`[Portfolio] Deployed into ${n} positions (${(pct * 100).toFixed(0)}% each)`);
  }

  // ─── Rebalancing ─────────────────────────────────────────────────────────
  private rebalance(): void {
    const open        = this.openList();
    const allOpps     = this.reporter.getLatest();
    const candidates  = this.rankedCandidates();
    const inPortfolio = new Set(open.map(p => p.poolId));

    for (const pos of open) {
      if (pos.status !== "open") continue;  // may have been closed earlier in this loop
      if ((Date.now() - pos.entryTimestamp) / 3_600_000 < MIN_HOLD_HOURS) continue;

      const currentOpp = allOpps.find(o => o.poolId === pos.poolId);
      const currentRAR = currentOpp?.rar7d    ?? pos.entryRAR7d;
      const currentAPY = currentOpp?.displayAPY ?? pos.entryAPY;

      // Best opportunity not already held
      const best = candidates.find(c => !inPortfolio.has(c.poolId));
      if (!best) continue;
      if (best.rar7d <= currentRAR * (1 + REBALANCE_THRESHOLD)) continue;

      // Only switch if the extra return recovers the round-trip fee quickly enough
      const cost        = pos.currentValueUsd * (ENTRY_FEE_PCT + EXIT_FEE_PCT);
      const extraPerDay = pos.currentValueUsd * (best.displayAPY - currentAPY) / 100 / 365;
      if (extraPerDay <= 0 || cost / extraPerDay > MAX_BREAKEVEN_DAYS) continue;

      const reason   = `Rebalanced: ${best.pair} RAR ${best.rar7d.toFixed(2)} vs ${pos.pair} ${currentRAR.toFixed(2)} (fee recovers in ${(cost / extraPerDay).toFixed(1)}d)`;
      const proceeds = this.exit(pos, reason);
      this.enter(best, proceeds, pos.allocationPct, `Rebalanced from ${pos.pair}`);
      this.lastRebalance = Date.now();

      inPortfolio.delete(pos.poolId);
      inPortfolio.add(best.poolId);

      console.log(`[Portfolio] Rebalanced ${pos.pair} → ${best.pair}`);
    }
  }

  // ─── Simulated LP value accrual ─────────────────────────────────────────
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
      .filter(o => o.rar7d > 0 && o.displayAPY > 0)
      .sort((a, b) => b.rar7d - a.rar7d);
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
    };
  }

  getPositions(): MockPosition[] {
    this.updateValues();
    return [...this.positions.values()];
  }

  getTrades(): PortfolioTrade[] {
    return [...this.trades];
  }
}
