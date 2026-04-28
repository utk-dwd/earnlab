/**
 * ScenarioStressTester — simulates eight adversarial scenarios before LP entry
 * and ranks opportunities by expected downside, not only expected return.
 *
 * Each scenario computes a net return over a 30-day holding horizon as % of
 * position value, including fees, impermanent loss, and gas/slippage costs.
 *
 * Scenarios
 * ─────────
 *   price_down_5   / price_down_10 / price_down_20
 *     One-time price shock at t=0; position held for remainder of 30d.
 *     If the shock exceeds the practical LP half-range (2σ_7d_period), the
 *     position exits the tick range — fees = 0 for the full 30 days.
 *     IL = full-range formula × concentration leverage.
 *
 *   vol_double
 *     Annualised volatility doubles for the full 30-day period.
 *     TiR drops (Gaussian estimate), expected IL quadruples (∝ σ²).
 *
 *   volume_half
 *     Fee APY halves (volume is directly proportional to fees in AMMs).
 *
 *   apy_mean_revert
 *     Fee APY reverts to medianAPY7d (or persistence-adjusted if no history).
 *
 *   gas_spike
 *     Entry gas cost spikes 5×; hurts smaller positions more.
 *
 *   stable_depeg_50bps
 *     One stablecoin depegs 50 bps from $1 — small immediate IL but signals
 *     escalating risk for stable-pool LPs.  Applied as a price shock.
 *
 * Key formulas
 * ─────────────
 *   Full-range IL: IL(r) = 2√r/(1+r) − 1        (r = newPrice/oldPrice)
 *   Concentration leverage: max(1, CLEV_FLOOR / (vol7d × 2))
 *   Practical half-range: 2 × vol7d × √(7/365)  (2σ of 7-day price distribution)
 *   Gaussian TiR: 2Φ(halfRange / (vol × √(7/365))) − 1
 *   30d net return (ongoing) = feeAPY × TiR × 30/365 − IL_annual × 30/365
 *   30d net return (shock)   = feeAPY × TiR_post × 30/365 − oneTimeIL_pct − gasPct
 *
 * Ranking signals
 * ───────────────
 *   worstCase.netReturn30dPct  — single worst outcome
 *   expectedShortfall30dPct   — mean of the three worst outcomes
 *   downsideScore (0–100)     — 100 when worst-case ≥ −20%; useful for column sorting
 */

import { GAS_COST_USD } from "../config/chains";

// ─── Constants ────────────────────────────────────────────────────────────────

const HORIZON_DAYS    = 30;
const GAS_SPIKE_MULT  = 5;         // gas cost multiplier for the spike scenario
const GAS_COST_FALLBACK = 1.00;    // USD for unknown chains
const DEFAULT_POS_USD = 2_500;     // representative position for gas % calc
const CLEV_FLOOR      = 50;        // leverage = max(1, CLEV_FLOOR / tickHalfRange)
const SQRT_7_OVER_365 = Math.sqrt(7 / 365);   // ≈ 0.1383

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StressScenario {
  id:              string;
  name:            string;
  description:     string;
  /** Net P&L as % of position value over 30 days (negative = loss). */
  netReturn30dPct: number;
  /** Effective APY achieved under this scenario (can be negative). */
  effAPYUnder:     number;
  /** True if the scenario takes price outside the LP tick range. */
  breachesRange:   boolean;
  /** Fraction of 30 days price is estimated to be in range (0–1). */
  timeInRange:     number;
  /** Gross fee return over 30d as % of position value. */
  feeReturn30dPct: number;
  /** IL + ongoing loss over 30d as % of position value (positive = cost). */
  ilLoss30dPct:    number;
}

export interface StressTestResult {
  /** Current-conditions 30d net return as % of position value. */
  baseline30dPct:          number;
  /** Single worst scenario. */
  worstCase:               StressScenario;
  /** Average of the three worst scenarios (CVaR proxy). */
  expectedShortfall30dPct: number;
  /**
   * Downside score 0–100.
   * = min(100, max(0, −worstCase.netReturn30dPct × 5))
   * 0 = all scenarios profitable; 100 = worst case ≥ −20% loss.
   */
  downsideScore:    number;
  /** All eight scenario results, worst-first. */
  scenarios:        StressScenario[];
}

// ─── Math helpers ──────────────────────────────────────────────────────────────

/** Abramowitz & Stegun normal CDF approximation — error < 7.5 × 10⁻⁸. */
function normalCDF(x: number): number {
  const neg  = x < 0;
  const ax   = Math.abs(x);
  const t    = 1 / (1 + 0.2316419 * ax);
  const poly = t * (0.319381530
    + t * (-0.356563782
    + t * (1.781477937
    + t * (-1.821255978
    + t * 1.330274429))));
  const pdf  = Math.exp(-0.5 * ax * ax) / Math.sqrt(2 * Math.PI);
  const cdf  = 1 - pdf * poly;
  return neg ? 1 - cdf : cdf;
}

/**
 * Full-range Uniswap v2/v3 IL for a price ratio r = P_new / P_old.
 * Returns a negative fraction (e.g. −0.0062 for r=0.8).
 */
function fullRangeIL(r: number): number {
  if (r <= 0) return -1;
  return 2 * Math.sqrt(r) / (1 + r) - 1;
}

/**
 * Gaussian time-in-range estimate.
 * halfRangePct — practical LP half-range in % (2σ_7d_period scale).
 * vol7d        — annualised vol in %.
 */
function gaussianTiR(halfRangePct: number, vol7d: number): number {
  if (vol7d <= 0) return 0.95;
  if (halfRangePct <= 0) return 0;
  const z = halfRangePct / (vol7d * SQRT_7_OVER_365);
  return Math.max(0, Math.min(1, 2 * normalCDF(z) - 1));
}

// ─── Core function ────────────────────────────────────────────────────────────

export function runStressTest(params: {
  chainId:              number;
  vol7d:                number;
  displayAPY:           number;
  medianAPY7d:          number;
  apyPersistence:       number;
  /** Empirical TiR from CapitalEfficiencyCalculator (0–1, 0 = not yet computed). */
  timeInRangePct:       number;
  feeCaptureEfficiency: number;
  expectedIL:           number;
  netAPY:               number;
  effectiveNetAPY:      number;
  tvlUsd:               number;
  volume24hUsd:         number;
  isStablePool:         boolean;
}): StressTestResult {
  const {
    chainId, vol7d, displayAPY, medianAPY7d, apyPersistence,
    timeInRangePct, feeCaptureEfficiency, effectiveNetAPY,
    expectedIL, netAPY, isStablePool,
  } = params;

  // ── Derived baseline quantities ───────────────────────────────────────────
  // Practical half-range: 2σ of the 7-day price distribution (CapEff convention).
  // Used to determine if a one-time shock breaches the LP range.
  const practHalfRange   = vol7d > 0 ? 2 * vol7d * SQRT_7_OVER_365 : 5; // %
  // Concentration leverage: tighter ranges amplify IL per $ of LP capital.
  const tickHalfRange    = vol7d * 2;                                    // annualised 2σ
  const concLeverage     = Math.max(1, CLEV_FLOOR / Math.max(tickHalfRange, 1));
  // Baseline TiR (use empirical if available, else Gaussian estimate)
  const baseTiR          = timeInRangePct > 0 ? timeInRangePct : gaussianTiR(practHalfRange, vol7d);
  const baseFCE          = feeCaptureEfficiency > 0 ? feeCaptureEfficiency : 0.75;
  const baseCapUtil      = baseTiR * baseFCE;

  // Baseline 30d return (current conditions)
  const baseEffAPY       = effectiveNetAPY > 0 ? effectiveNetAPY : netAPY * baseCapUtil;
  const baseline30dPct   = +((baseEffAPY / 100 / 365 * HORIZON_DAYS) * 100).toFixed(3);

  // Gas cost at baseline (USD → % of default position)
  const gasCostUsd       = GAS_COST_USD[chainId] ?? GAS_COST_FALLBACK;
  const gasCostBasePct   = gasCostUsd / DEFAULT_POS_USD * 100;

  // ── Scenario builder helpers ──────────────────────────────────────────────

  /** Price shock scenario: one-time shock at t=0, position held for HORIZON_DAYS. */
  function priceShockScenario(
    id:             string,
    name:           string,
    desc:           string,
    shockPct:       number,   // negative = drop
    gasMult:        number,
  ): StressScenario {
    const absShock   = Math.abs(shockPct);
    const r          = 1 + shockPct / 100;

    // One-time IL from the price shock
    const baseILFrac = Math.abs(fullRangeIL(Math.max(r, 0.0001)));
    const ilFrac     = baseILFrac * concLeverage;
    const ilPct      = ilFrac * 100;

    // If shock > practical half-range, position is out of range — no more fees
    const breaches    = absShock > practHalfRange;
    const tirPostShock = breaches ? 0 : baseTiR * (1 - absShock / practHalfRange) * 0.5 + baseTiR * 0.5;
    // ↑ Linear interpolation: at boundary → 50% of baseline TiR; well inside → baseline TiR

    const feeReturn = displayAPY * tirPostShock * baseFCE / 100 / 365 * HORIZON_DAYS * 100;
    const gasPct    = gasCostUsd * gasMult / DEFAULT_POS_USD * 100;
    const net       = +(feeReturn - ilPct - gasPct).toFixed(3);

    return {
      id, name, description: desc,
      netReturn30dPct: net,
      effAPYUnder:     +(net / HORIZON_DAYS * 365).toFixed(1),
      breachesRange:   breaches,
      timeInRange:     +tirPostShock.toFixed(4),
      feeReturn30dPct: +feeReturn.toFixed(3),
      ilLoss30dPct:    +(ilPct + gasPct).toFixed(3),
    };
  }

  /** Ongoing-condition scenario: changed conditions persist for all HORIZON_DAYS. */
  function ongoingScenario(
    id:         string,
    name:       string,
    desc:       string,
    opts: {
      feeAPY?:   number;   // override fee APY
      vol7dNew?: number;   // override vol7d
      gasMult?:  number;   // gas multiplier
    },
  ): StressScenario {
    const feeAPY   = opts.feeAPY   ?? displayAPY;
    const volNew   = opts.vol7dNew ?? vol7d;
    const gasMult  = opts.gasMult  ?? 1;

    // New TiR under changed vol (Gaussian approximation with original range)
    const newTiR   = gaussianTiR(practHalfRange, volNew);
    // New expected IL: 0.5 × σ²  (∝ σ², so doubles when vol ×2 → IL ×4)
    const newILAnn = volNew > 0 ? 0.5 * (volNew / 100) ** 2 * 100 : 0;

    const feeReturn = feeAPY * newTiR * baseFCE / 100 / 365 * HORIZON_DAYS * 100;
    const ilCost    = newILAnn / 100 / 365 * HORIZON_DAYS * 100;
    const gasPct    = gasCostUsd * gasMult / DEFAULT_POS_USD * 100;
    const net       = +(feeReturn - ilCost - gasPct).toFixed(3);
    const breaches  = newTiR < 0.30; // effectively out-of-range most of the time

    return {
      id, name, description: desc,
      netReturn30dPct: net,
      effAPYUnder:     +(net / HORIZON_DAYS * 365).toFixed(1),
      breachesRange:   breaches,
      timeInRange:     +newTiR.toFixed(4),
      feeReturn30dPct: +feeReturn.toFixed(3),
      ilLoss30dPct:    +(ilCost + gasPct).toFixed(3),
    };
  }

  // ── APY mean-revert target ────────────────────────────────────────────────
  // Prefer the recorded 7d median; fall back to persistence-adjusted current APY.
  const meanRevertAPY = medianAPY7d > 0
    ? medianAPY7d
    : displayAPY * Math.min(apyPersistence > 0 ? apyPersistence : 1.0, 1.0);

  // ── Run all eight scenarios ───────────────────────────────────────────────
  const scenarios: StressScenario[] = [
    priceShockScenario(
      "price_down_5", "Token −5%",
      "One-time 5% price drop; position held for 30 days",
      -5, 1,
    ),
    priceShockScenario(
      "price_down_10", "Token −10%",
      "One-time 10% price drop",
      -10, 1,
    ),
    priceShockScenario(
      "price_down_20", "Token −20%",
      "One-time 20% price drop — severe market stress",
      -20, 1,
    ),
    ongoingScenario(
      "vol_double", "Vol ×2",
      "Annualised volatility doubles for the full period; IL ×4, TiR falls",
      { vol7dNew: Math.max(vol7d * 2, 1) },
    ),
    ongoingScenario(
      "volume_half", "Volume −50%",
      "Trading volume halves; fee APY drops proportionally",
      { feeAPY: displayAPY * 0.5 },
    ),
    ongoingScenario(
      "apy_mean_revert", "APY reverts",
      `Fee APY mean-reverts to ${meanRevertAPY.toFixed(1)}% (7d median / persistence-adjusted)`,
      { feeAPY: meanRevertAPY },
    ),
    ongoingScenario(
      "gas_spike", "Gas ×5",
      "Gas cost spikes 5× — break-even extends; hurts smaller positions most",
      { gasMult: GAS_SPIKE_MULT },
    ),
    priceShockScenario(
      "stable_depeg_50bps",
      isStablePool ? "Stable −50bps ⚠" : "Stable −50bps",
      isStablePool
        ? "One stablecoin depegs 50 bps — position exits range (very tight stable range)"
        : "50 bps price shift — minimal impact for non-stable pool",
      -0.5, 1,
    ),
  ];

  // Sort worst-first
  scenarios.sort((a, b) => a.netReturn30dPct - b.netReturn30dPct);

  const worstCase = scenarios[0];
  const expectedShortfall30dPct = +((
    scenarios[0].netReturn30dPct +
    scenarios[1].netReturn30dPct +
    scenarios[2].netReturn30dPct
  ) / 3).toFixed(3);

  // downsideScore: 100 when worst-case ≈ −20%; 0 when all scenarios positive
  const downsideScore = Math.min(100, Math.max(0, -worstCase.netReturn30dPct * 5));

  return {
    baseline30dPct,
    worstCase,
    expectedShortfall30dPct,
    downsideScore,
    scenarios,
  };
}
