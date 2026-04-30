/**
 * DecisionScorecard — 8-dimension scoring of a yield opportunity.
 *
 * Scores are 0–100 (higher = better) on eight orthogonal dimensions:
 *
 *   Yield       effective yield potential (effAPY → score, adverse-selection adjusted)
 *   IL          protection from impermanent loss (IL/APY ratio)
 *   Liquidity   pool depth & fee stability (liquidityQuality)
 *   Volatility  price stability & time-in-range
 *   TokenRisk   smart-contract / honeypot / manipulation risk (GoPlus)
 *   Gas         gas break-even speed
 *   Correlation portfolio diversification benefit (portfolio-aware)
 *   Regime      fit with current macro regime (risk-off / neutral / risk-on)
 *
 * Composite = weighted sum (weights sum to 1.0).
 * AllocationPct = Kelly-inspired sizing × composite / 100.
 *
 * Call computeScorecard(opp) from ReporterAgent for the standalone version.
 * Call enrichWithPortfolio(scorecard, opp, positions, regime) from PortfolioManager
 * to replace the correlation + regime scores with portfolio-aware values.
 */

import { gasBreakEvenDays }    from "../config/chains";
import { rbPairTokens, rbIsVolatile } from "./RiskBudget";
import type { MockPosition }   from "../PortfolioManager";
import type { RankedOpportunity } from "../ReporterAgent";
import type { MacroRegime }    from "../PortfolioManager";

// ─── Regime-conditional weights (each set must sum to 1.0) ───────────────────
//
// risk-off  Drawdown (ETH Δ7d < −5%): IL and token risk dominate.
//           Volatility is elevated because out-of-range = zero fees AND IL.
//           Yield is deprioritised — capital preservation first.
//
// neutral   Base case: yield-forward but balanced.
//
// risk-on   Bull market (ETH Δ7d > +5%): yield leads, correlation elevated
//           to prevent over-concentration during aggressive allocation.
//           IL tolerance increases because fee APY is rising too.

export type WeightSet = Record<
  "yield" | "il" | "liquidity" | "volatility" | "tokenRisk" | "gas" | "correlation" | "regime" | "hookRisk",
  number
>;

export const WEIGHTS_BY_REGIME = {
  "risk-off": { yield: 0.09, il: 0.28, liquidity: 0.14, volatility: 0.14, tokenRisk: 0.14, gas: 0.04, correlation: 0.06, regime: 0.03, hookRisk: 0.08 },
  "neutral":  { yield: 0.22, il: 0.18, liquidity: 0.13, volatility: 0.09, tokenRisk: 0.09, gas: 0.04, correlation: 0.09, regime: 0.04, hookRisk: 0.12 },
  "risk-on":  { yield: 0.32, il: 0.09, liquidity: 0.13, volatility: 0.07, tokenRisk: 0.07, gas: 0.04, correlation: 0.11, regime: 0.07, hookRisk: 0.10 },
} as const satisfies Record<string, WeightSet>;

/** Convenience alias kept for any callers that still import WEIGHTS. */
export const WEIGHTS = WEIGHTS_BY_REGIME["neutral"];

export function weightsForRegime(regime: MacroRegime): WeightSet {
  return WEIGHTS_BY_REGIME[regime];
}

const TARGET_POSITIONS = 4;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DecisionScorecard {
  /** Individual dimension scores 0–100 */
  yield:       number;
  il:          number;
  liquidity:   number;
  volatility:  number;
  tokenRisk:   number;
  gas:         number;
  /** Updated by enrichWithPortfolio; defaults to 50 (neutral) */
  correlation: number;
  /** Updated by enrichWithPortfolio; defaults to 75 (neutral regime) */
  regime:      number;
  /** Hook smart-contract risk: 100 − riskScore. 100 for vanilla pools. */
  hookRisk:    number;

  /** Weighted composite of the nine scores. */
  composite:   number;

  /** Which weight table was applied ("neutral" until enrichWithPortfolio runs). */
  weightSet:   "risk-off" | "neutral" | "risk-on";

  /** Recommended position size as % of total capital (Kelly × composite). */
  allocationPct: number;

  /** One-line labels explaining each score (for tooltip / LLM context). */
  labels: {
    yield:       string;
    il:          string;
    liquidity:   string;
    volatility:  string;
    tokenRisk:   string;
    gas:         string;
    correlation: string;
    regime:      string;
    hookRisk:    string;
  };
}

// ─── Standalone computation ───────────────────────────────────────────────────

const DEFAULT_POS_USD = 2_500;

/**
 * Compute a standalone scorecard.  Correlation defaults to 50 (neutral) and
 * regime to 75 (neutral).  Call enrichWithPortfolio to update those two.
 */
export function computeScorecard(opp: RankedOpportunity): DecisionScorecard {
  // ── Hook Risk (0–100) — computed first so it feeds into yield ─────────────
  const hookRiskScore = opp.hookAnalysis
    ? Math.max(0, 100 - opp.hookAnalysis.riskScore)
    : 100;  // vanilla pool scores full marks
  const hookRiskLabel = opp.hookAnalysis
    ? opp.hookAnalysis.isBlocked
      ? `BLOCKED riskScore=${opp.hookAnalysis.riskScore} (${opp.hookAnalysis.riskLevel})`
      : `riskScore=${opp.hookAnalysis.riskScore} (${opp.hookAnalysis.riskLevel}) fee=${opp.hookAnalysis.feeType} ${opp.hookAnalysis.rebalanceType !== "none" ? opp.hookAnalysis.rebalanceType : ""}`
    : "no hook — vanilla pool";

  // ── Yield (0–100) ──────────────────────────────────────────────────────────
  const hookMultiplier   = opp.hookAnalysis?.netAPYMultiplier ?? 1.0;
  const incentiveHaircut = opp.hookAnalysis?.incentiveHaircut ?? 1.0;
  const effAPY   = opp.effectiveNetAPY > 0 ? opp.effectiveNetAPY
                 : opp.netAPY         > 0 ? opp.netAPY
                 : opp.displayAPY;
  const hookAdjEffAPY = effAPY * hookMultiplier * incentiveHaircut;
  // Adverse selection penalty: reduce effective yield by up to 30% when score ≥ 50
  const advPenalty = opp.adverseSelection
    ? Math.max(0, (opp.adverseSelection.score - 50)) / 100 * 0.30
    : 0;
  const adjEffAPY  = hookAdjEffAPY * (1 - advPenalty);
  const yieldScore = clamp(adjEffAPY / 50 * 100);
  const hookNote   = opp.hookAnalysis && (hookMultiplier !== 1.0 || incentiveHaircut !== 1.0)
    ? ` hook×${hookMultiplier.toFixed(2)} haircut×${incentiveHaircut.toFixed(2)}`
    : "";
  const yieldLabel = opp.adverseSelection && advPenalty > 0
    ? `effAPY=${effAPY.toFixed(1)}% → ${adjEffAPY.toFixed(1)}%${hookNote} (adv-sel −${(advPenalty*100).toFixed(0)}%)`
    : `effAPY=${effAPY.toFixed(1)}%${hookNote}`;

  // ── IL (0–100) ─────────────────────────────────────────────────────────────
  let ilScore: number;
  let ilLabel: string;
  if (opp.expectedIL <= 0 || opp.displayAPY <= 0) {
    ilScore = opp.vol7d <= 0 ? 80 : clamp(100 - opp.vol7d);  // vol proxy when IL uncomputed
    ilLabel = opp.expectedIL <= 0 ? `vol=${opp.vol7d.toFixed(0)}% (IL not computed)` : "IL=0%";
  } else {
    const ilRatio = opp.expectedIL / opp.displayAPY;  // fraction of fees eaten by IL
    ilScore = clamp(100 - ilRatio * 100);
    ilLabel = `IL=${opp.expectedIL.toFixed(1)}% / APY=${opp.displayAPY.toFixed(1)}% → eats ${(ilRatio*100).toFixed(0)}%`;
  }

  // ── Liquidity (0–100) ──────────────────────────────────────────────────────
  const lqScore = clamp(opp.liquidityQuality > 0 ? opp.liquidityQuality : 50);
  const lqLabel = opp.liquidityQuality > 0
    ? `lq=${opp.liquidityQuality} (TVL × activity × stability × depth)`
    : "lq=not yet computed";

  // ── Volatility / TiR (0–100) ───────────────────────────────────────────────
  // Time-in-range is the primary signal; large recent price moves add a penalty.
  const tirPct = opp.timeInRangePct > 0 ? opp.timeInRangePct * 100
                 : opp.vol7d > 0 ? Math.max(0, 100 - opp.vol7d) : 70;
  const pairMovePct  = Math.abs((opp.pairPriceChange7d ?? 0) * 100);
  const halfRange    = opp.vol7d > 0 ? opp.vol7d * 2 : 10;
  const movePenalty  = pairMovePct > halfRange ? 25
                     : pairMovePct > halfRange * 0.5 ? 12 : 0;
  const volScore     = clamp(tirPct - movePenalty);
  const volLabel     = `TiR=${tirPct.toFixed(0)}% vol=${opp.vol7d.toFixed(0)}%`
    + (movePenalty ? ` Δ7d=${pairMovePct.toFixed(0)}% (−${movePenalty}pts)` : "");

  // ── Token Risk (0–100) ─────────────────────────────────────────────────────
  let trScore: number;
  let trLabel: string;
  if (!opp.tokenRisk) {
    trScore = 50;
    trLabel = "not yet assessed";
  } else if (opp.tokenRisk.blockEntry) {
    trScore = 0;
    trLabel = `BLOCKED: ${opp.tokenRisk.flags[0] ?? "unknown"}`;
  } else {
    trScore = clamp(100 - opp.tokenRisk.poolRiskScore);
    trLabel = `${opp.tokenRisk.poolRiskScore}/100 risk${opp.tokenRisk.flags.length ? ` (${opp.tokenRisk.flags[0]})` : " — clean"}`;
  }

  // ── Gas (0–100) ────────────────────────────────────────────────────────────
  const beDays    = gasBreakEvenDays(opp.chainId, DEFAULT_POS_USD, opp.displayAPY);
  const gasScore  = beDays === Infinity ? 0
                  : beDays <= 0        ? 100
                  : clamp(100 - beDays / 7 * 100);
  const gasLabel  = beDays === Infinity ? "never breaks even at this APY"
                  : beDays > 99         ? ">${beDays.toFixed(0)}d break-even"
                  : `${beDays.toFixed(1)}d to break even`;

  // ── Correlation (placeholder — updated by enrichWithPortfolio) ─────────────
  const corrScore = 50;
  const corrLabel = "pending portfolio context";

  // ── Regime (placeholder — updated by enrichWithPortfolio) ─────────────────
  const regScore = 75;
  const regLabel = "neutral (pending)";

  const weights       = WEIGHTS_BY_REGIME["neutral"];
  const composite     = computeComposite(yieldScore, ilScore, lqScore, volScore, trScore, gasScore, corrScore, regScore, hookRiskScore, weights);
  const allocationPct = computeAllocation(opp, composite);

  return {
    yield:       yieldScore,
    il:          ilScore,
    liquidity:   lqScore,
    volatility:  volScore,
    tokenRisk:   trScore,
    gas:         gasScore,
    correlation: corrScore,
    regime:      regScore,
    hookRisk:    hookRiskScore,
    composite,
    weightSet:   "neutral",
    allocationPct,
    labels: {
      yield:       yieldLabel,
      il:          ilLabel,
      liquidity:   lqLabel,
      volatility:  volLabel,
      tokenRisk:   trLabel,
      gas:         gasLabel,
      correlation: corrLabel,
      regime:      regLabel,
      hookRisk:    hookRiskLabel,
    },
  };
}

// ─── Portfolio-aware enrichment ───────────────────────────────────────────────

/**
 * Recompute correlation + regime scores using actual portfolio state.
 * Returns a new scorecard; does not mutate.
 */
export function enrichWithPortfolio(
  sc:        DecisionScorecard,
  opp:       RankedOpportunity,
  positions: MockPosition[],
  regime:    MacroRegime,
): DecisionScorecard {
  const open = positions.filter(p => p.status === "open");

  // ── Correlation ────────────────────────────────────────────────────────────
  // Measures how much new diversification this pool adds.
  // 100 = completely new exposure; 0 = perfect duplicate of existing positions.
  const [t0, t1]     = rbPairTokens(opp.pair);
  const heldTokens   = new Set(open.flatMap(p => rbPairTokens(p.pair) as string[]));
  const heldChains   = new Set(open.map(p => p.chainName));
  const t0Known      = heldTokens.has(t0);
  const t1Known      = heldTokens.has(t1);
  const chainDup     = heldChains.has(opp.chainName);

  // Base score from token novelty
  let corrScore = t0Known && t1Known ? 20
               : t0Known || t1Known  ? 60
               : 100;
  // Chain penalty: already have a position on this chain
  if (chainDup)  corrScore = Math.max(0, corrScore - 20);
  // Bonus if portfolio is empty (first position always diversifies)
  if (open.length === 0) corrScore = 80;
  // Bonus for adding stable when portfolio is all volatile, or vice versa
  const portfolioIsAllVolatile  = open.length > 0 && open.every(p => rbIsVolatile(p.pair));
  const portfolioIsAllStable    = open.length > 0 && open.every(p => !rbIsVolatile(p.pair));
  const oppIsVolatile           = rbIsVolatile(opp.pair);
  if (portfolioIsAllVolatile && !oppIsVolatile) corrScore = Math.min(100, corrScore + 20);
  if (portfolioIsAllStable   &&  oppIsVolatile) corrScore = Math.min(100, corrScore + 15);

  const corrLabel = open.length === 0
    ? "first position — full diversification"
    : `t0=${t0Known ? "held" : "new"} t1=${t1Known ? "held" : "new"} chain=${chainDup ? "dup" : "new"}`;

  // ── Regime ─────────────────────────────────────────────────────────────────
  const isStable    = !rbIsVolatile(opp.pair);
  const highQuality = opp.rar7d > 2 && opp.expectedIL < 10;
  const regScore: number =
    regime === "risk-off" ? (isStable ? 90 : highQuality ? 50 : 20)
  : regime === "risk-on"  ? (isStable ? 45 : opp.rar7d > 2 ? 90 : 70)
  : /* neutral */            (isStable ? 70 : 78);

  const regLabel = `${regime}  ${isStable ? "stable" : "volatile"}${highQuality ? " high-quality" : ""}`;

  const weights       = weightsForRegime(regime);
  const composite     = computeComposite(sc.yield, sc.il, sc.liquidity, sc.volatility, sc.tokenRisk, sc.gas, corrScore, regScore, sc.hookRisk ?? 100, weights);
  const allocationPct = computeAllocation(opp, composite);

  return {
    ...sc,
    correlation: corrScore,
    regime:      regScore,
    composite,
    weightSet:   regime,
    allocationPct,
    labels: {
      ...sc.labels,
      correlation: corrLabel,
      regime:      regLabel,
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clamp(n: number): number {
  return Math.round(Math.max(0, Math.min(100, n)));
}

function computeComposite(
  yld: number, il: number, lq: number, vol: number,
  tr: number, gas: number, corr: number, reg: number, hookRisk: number,
  w: WeightSet,
): number {
  return Math.round(
    yld      * w.yield       +
    il       * w.il          +
    lq       * w.liquidity   +
    vol      * w.volatility  +
    tr       * w.tokenRisk   +
    gas      * w.gas         +
    corr     * w.correlation +
    reg      * w.regime      +
    hookRisk * w.hookRisk
  );
}

/**
 * Kelly-inspired allocation.
 * Base = Kelly quarter-fraction (RAR-driven) or equal-weight fallback.
 * Scaled by composite/100 so lower-scoring pools get smaller allocations.
 */
function computeAllocation(opp: RankedOpportunity, composite: number): number {
  const base = opp.rar7d > 1
    ? Math.min((opp.rar7d - 1) / opp.rar7d * 25, 30)
    : 30 / TARGET_POSITIONS;
  return +Math.min(30, base * composite / 100).toFixed(1);
}
