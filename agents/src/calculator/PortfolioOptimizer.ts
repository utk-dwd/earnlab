/**
 * PortfolioOptimizer — answers "what allocation across pools gives the best
 * expected net return per unit of drawdown, gas, IL, token risk, chain risk,
 * and correlation?" rather than simply "which pool has the highest APY?"
 *
 * Algorithm: greedy marginal-Sharpe construction
 *
 *   1. Score every candidate with a portfolio-aware scorecard (correlation and
 *      regime updated against current + provisional holdings).
 *   2. Compute each candidate's marginalSharpe:
 *        marginalReturn  = alloc × effAPY
 *        marginalRisk    = alloc × (1 − composite/100) × correlationMultiplier
 *        marginalSharpe  = marginalReturn / marginalRisk
 *   3. Select the candidate with the highest marginalSharpe that also clears
 *      all risk-budget constraints.
 *   4. Add it to the provisional portfolio, update running state, repeat.
 *
 * This produces a ranked allocation list where rank-1 is the pool that most
 * improves the portfolio's return-per-unit-of-risk, not merely the highest APY.
 */

import { enrichWithPortfolio } from "./DecisionScorecard";
import { checkRiskBudget, rbPairTokens } from "./RiskBudget";
import { gasBreakEvenDays } from "../config/chains";
import type { DecisionScorecard } from "./DecisionScorecard";
import type { RankedOpportunity } from "../ReporterAgent";
import type { MockPosition }      from "../PortfolioManager";
import type { MacroRegime }       from "../PortfolioManager";

const INITIAL_CAPITAL_USD  = 10_000;
const MAX_POSITIONS        = 4;
const MAX_BREAKEVEN_DAYS   = 7;
const ENTRY_FEE_PCT        = 0.001;
const EXIT_FEE_PCT         = 0.001;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PortfolioAllocation {
  rank:             number;
  poolId:           string;
  pair:             string;
  chainName:        string;
  feeTierLabel:     string;
  effectiveNetAPY:  number;
  scorecard:        DecisionScorecard;
  allocationPct:    number;
  allocationUsd:    number;
  /** Incremental yield added to portfolio return (% annualised on total capital). */
  marginalReturn:   number;
  /** Composite risk contribution after correlation adjustment (0–100). */
  marginalRisk:     number;
  /** marginalReturn / marginalRisk — higher = better portfolio fit. */
  marginalSharpe:   number;
  /** One-sentence explanation of why this rank was assigned. */
  reasoning:        string;
}

export interface OptimizationResult {
  allocations:        PortfolioAllocation[];
  portfolioReturn:    number;   // expected weighted-avg effAPY on invested capital
  portfolioRisk:      number;   // composite portfolio risk score 0–100
  portfolioSharpe:    number;   // portfolioReturn / portfolioRisk
  cashReservedPct:    number;   // % kept as cash after allocations
}

// ─── Main function ────────────────────────────────────────────────────────────

export function optimizePortfolio(
  candidates:   RankedOpportunity[],
  positions:    MockPosition[],
  cash:         number,
  regime:       MacroRegime,
): OptimizationResult {
  const openPositions = positions.filter(p => p.status === "open");
  const heldPoolIds   = new Set(openPositions.map(p => p.poolId));

  // Candidates must not be already held, must have positive APY,
  // and must pass the gas break-even gate.
  const eligible = candidates.filter(opp =>
    !heldPoolIds.has(opp.poolId) &&
    opp.displayAPY > 0 &&
    !opp.tokenRisk?.blockEntry &&
    !opp.stablecoinRisk?.blockEntry &&
    gasBreakEvenDays(opp.chainId, INITIAL_CAPITAL_USD * 0.25, opp.displayAPY) <= MAX_BREAKEVEN_DAYS,
  );

  // Provisional tracking — mirrors RiskBudget.deploy() greedy approach but
  // uses marginal Sharpe as the selection criterion instead of APY rank.
  const selected:       RankedOpportunity[]  = [];
  const provisional:    PortfolioAllocation[] = [];
  let   provPositions:  MockPosition[]        = [...openPositions];
  let   provCash        = cash;

  while (selected.length < MAX_POSITIONS && eligible.length > 0) {
    // Find the next best candidate by marginal Sharpe
    let bestIdx     = -1;
    let bestSharpe  = -Infinity;
    let bestAlloc   = 0;
    let bestSc: DecisionScorecard | null = null;

    for (let i = 0; i < eligible.length; i++) {
      const opp = eligible[i];
      if (selected.some(s => s.poolId === opp.poolId)) continue;

      // Scorecard updated with provisional portfolio state
      const sc     = enrichWithPortfolio(opp.scorecard ?? fallbackScorecard(opp), opp, provPositions, regime);
      const alloc  = sc.allocationPct / 100;  // as fraction of total capital
      const value  = INITIAL_CAPITAL_USD * alloc;

      // Risk budget check against provisional state
      const viols = checkRiskBudget(opp.pair, opp.chainName, value, provPositions, provCash, INITIAL_CAPITAL_USD);
      if (viols.length > 0) continue;

      // Marginal Sharpe
      const { ms } = marginalSharpe(opp, sc, alloc, provPositions);
      if (ms > bestSharpe) {
        bestSharpe = ms;
        bestIdx    = i;
        bestAlloc  = alloc;
        bestSc     = sc;
      }
    }

    if (bestIdx === -1) break;  // no more feasible candidates

    const opp     = eligible[bestIdx];
    const sc      = bestSc!;
    const value   = INITIAL_CAPITAL_USD * bestAlloc;
    const { mr, mk } = marginalSharpe(opp, sc, bestAlloc, provPositions);

    const effAPY = opp.effectiveNetAPY > 0 ? opp.effectiveNetAPY : (opp.netAPY > 0 ? opp.netAPY : opp.displayAPY);

    provisional.push({
      rank:            selected.length + 1,
      poolId:          opp.poolId,
      pair:            opp.pair,
      chainName:       opp.chainName,
      feeTierLabel:    opp.feeTierLabel,
      effectiveNetAPY: effAPY,
      scorecard:       sc,
      allocationPct:   +( bestAlloc * 100).toFixed(1),
      allocationUsd:   +(value).toFixed(0),
      marginalReturn:  +mr.toFixed(3),
      marginalRisk:    +mk.toFixed(1),
      marginalSharpe:  +bestSharpe.toFixed(3),
      reasoning:       buildReasoning(opp, sc, bestSharpe, provPositions),
    });

    selected.push(opp);

    // Create a synthetic MockPosition so subsequent candidates see this as "held"
    provPositions = [
      ...provPositions,
      syntheticPosition(opp, value),
    ];
    provCash -= value * (1 + ENTRY_FEE_PCT);
  }

  // ── Portfolio-level metrics ────────────────────────────────────────────────
  const totalAllocated = provisional.reduce((s, a) => s + a.allocationPct / 100, 0);
  const portfolioReturn = provisional.length > 0
    ? provisional.reduce((s, a) => s + (a.allocationPct / 100) * a.effectiveNetAPY, 0) /
      Math.max(totalAllocated, 0.001)
    : 0;
  const portfolioRisk = provisional.length > 0
    ? provisional.reduce((s, a) => s + (a.allocationPct / 100) * (100 - a.scorecard.composite), 0) /
      Math.max(totalAllocated, 0.001)
    : 0;
  const portfolioSharpe   = portfolioRisk > 0 ? portfolioReturn / portfolioRisk : 0;
  const cashReservedPct   = +(100 - totalAllocated * 100).toFixed(1);

  return { allocations: provisional, portfolioReturn, portfolioRisk, portfolioSharpe, cashReservedPct };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Compute marginal return, risk, and Sharpe for adding this pool. */
function marginalSharpe(
  opp:      RankedOpportunity,
  sc:       DecisionScorecard,
  alloc:    number,
  existing: MockPosition[],
): { ms: number; mr: number; mk: number } {
  const effAPY = opp.effectiveNetAPY > 0 ? opp.effectiveNetAPY
               : opp.netAPY         > 0 ? opp.netAPY
               : opp.displayAPY;

  const mr = alloc * effAPY;  // marginal return: allocation × yield
  // Standalone pool risk = (1 − composite/100)
  const poolRiskFrac = Math.max(0.01, 1 - sc.composite / 100);

  // Correlation multiplier: existing positions with shared tokens/chain amplify risk
  const [t0, t1]   = rbPairTokens(opp.pair);
  const heldTokens = new Set(existing.flatMap(p => rbPairTokens(p.pair) as string[]));
  const heldChains = existing.map(p => p.chainName);
  const tokenOverlap = ([t0, t1].filter(t => heldTokens.has(t)).length / 2);
  const chainDupFrac = heldChains.filter(c => c === opp.chainName).length / Math.max(existing.length, 1);
  const corrMult = 1 + tokenOverlap * 0.5 + chainDupFrac * 0.3;

  const mk = alloc * poolRiskFrac * 100 * corrMult;  // marginal risk (0–100 scale)
  const ms = mk > 0 ? mr / mk : mr * 100;

  return { ms, mr, mk };
}

function buildReasoning(
  opp:      RankedOpportunity,
  sc:       DecisionScorecard,
  mSharpe:  number,
  existing: MockPosition[],
): string {
  const effAPY = opp.effectiveNetAPY > 0 ? opp.effectiveNetAPY : opp.netAPY;
  const corr   = sc.correlation >= 80 ? "high diversification" : sc.correlation >= 50 ? "moderate overlap" : "correlated with holdings";
  const regime = sc.regime >= 70 ? "regime-aligned" : sc.regime >= 40 ? "neutral regime fit" : "regime headwind";
  return `effAPY ${effAPY.toFixed(1)}%, composite ${sc.composite}/100, ${corr}, ${regime} — marginalSharpe ${mSharpe.toFixed(3)}`;
}

/** Synthetic minimal MockPosition so the optimizer can track provisional holdings. */
function syntheticPosition(opp: RankedOpportunity, valueUsd: number): MockPosition {
  return {
    id:              `prov-${opp.poolId}`,
    poolId:          opp.poolId,
    chainId:         opp.chainId,
    chainName:       opp.chainName,
    pair:            opp.pair,
    feeTierLabel:    opp.feeTierLabel,
    entryTimestamp:  Date.now(),
    entryValueUsd:   valueUsd,
    allocationPct:   valueUsd / INITIAL_CAPITAL_USD * 100,
    entryAPY:        opp.displayAPY,
    entryRAR7d:      opp.rar7d,
    currentValueUsd: valueUsd,
    earnedFeesUsd:   0,
    pnlUsd:          0,
    pnlPct:          0,
    hoursHeld:       0,
    status:          "open",
    tickLower:       0,
    tickUpper:       0,
    halfRangePct:    opp.vol7d * 2,
    timeInRangePct:  opp.timeInRangePct * 100,
    exitAlerts:      [],
  };
}

/** Minimal fallback scorecard when computeScorecard hasn't run yet. */
function fallbackScorecard(opp: RankedOpportunity): DecisionScorecard {
  const effAPY = opp.effectiveNetAPY > 0 ? opp.effectiveNetAPY : opp.displayAPY;
  const comp   = Math.round(Math.min(100, effAPY / 50 * 60 + 20));
  return {
    yield: Math.min(100, effAPY / 50 * 100), il: 50, liquidity: opp.liquidityQuality || 50,
    volatility: 50, tokenRisk: 50, gas: 50, correlation: 50, regime: 75,
    composite: comp, allocationPct: Math.min(30, comp * 0.25),
    labels: { yield: `effAPY=${effAPY.toFixed(1)}%`, il: "n/a", liquidity: `lq=${opp.liquidityQuality}`,
      volatility: "n/a", tokenRisk: "n/a", gas: "n/a", correlation: "pending", regime: "pending" },
  };
}
