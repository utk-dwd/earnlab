/**
 * CapitalEfficiencyCalculator — effective yield accounting for concentrated LP reality.
 *
 * In a Uniswap v4 concentrated position, capital earns fees ONLY when the current
 * price falls within the LP's tick range.  A 150% APY pool where the price is
 * out-of-range 50% of the time earns less than a 60% APY pool with 95% TiR.
 *
 *   timeInRangePct       fraction of 7-day hourly prices within ±2σ_7d of today's price
 *                        empirical — drawn from the same DefiLlama data used for vol
 *
 *   feeCaptureEfficiency  how consistently fees are generated when in range
 *                        = sqrt(min(liveAPY, referenceAPY) / max(liveAPY, referenceAPY))
 *                        1.0 = perfectly consistent; 0.3 = one-day volume spike
 *
 *   capitalUtilization   = timeInRangePct × feeCaptureEfficiency   (0–1)
 *
 *   effectiveNetAPY      = netAPY × capitalUtilization
 *                        the APY you realistically expect to earn on deployed capital
 *
 * The ±2σ_7d range is calibrated to the 7-day holding horizon (not annualised vol):
 *   halfRange = 2 × (vol7d / 100) × √(7/365)
 *
 * This is tighter than the `vol7d × 2` range used for tick computation in
 * PortfolioManager (which is intentionally wide for safety), and more realistic
 * for fee-optimising LP strategies.
 *
 * Price data is served from VolatilityCalculator's raw price cache — no
 * additional network calls when enrichRAR has already run for the same pool.
 */

import { fetchHourlyPrices } from "./VolatilityCalculator";
import { STABLE_SYMBOLS }    from "./StablecoinRiskAssessor";

// ─── Constants ────────────────────────────────────────────────────────────────

const SQRT_7_OVER_365 = Math.sqrt(7 / 365); // ≈ 0.13834
const MIN_HALF_RANGE  = 0.001;               // floor: 0.1% (prevents divide-by-zero on flat stables)
const MIN_PRICE_PTS   = 12;                  // require at least 12 h of data for empirical TiR
const DEFAULT_TIR     = 0.82;               // fallback when price history unavailable

// ─── Public types ─────────────────────────────────────────────────────────────

export interface CapitalEfficiencyResult {
  /** 0–1. Fraction of 7d hourly prices within ±halfRangePct of current price. */
  timeInRangePct:       number;
  /** 0–1. How consistently fees are generated: sqrt(min(live,ref)/max(live,ref)). */
  feeCaptureEfficiency: number;
  /** 0–1. timeInRangePct × feeCaptureEfficiency. */
  capitalUtilization:   number;
  /** netAPY × capitalUtilization — realistically expected yield on deployed capital. */
  effectiveNetAPY:      number;
  /** ±% range used to compute TiR (= 2σ of 7-day price distribution). */
  halfRangePct:         number;
}

// ─── Core function ────────────────────────────────────────────────────────────

export async function computeCapitalEfficiency(params: {
  chainId:       number;
  token0Address: string;
  token0Symbol:  string;
  token1Address: string;
  token1Symbol:  string;
  /** Annualised volatility (%) — from VolatilityCalculator. */
  vol7d:         number;
  liveAPY:       number;
  referenceAPY:  number;
  tvlUsd:        number;
  volume24hUsd:  number;
  netAPY:        number;
}): Promise<CapitalEfficiencyResult> {
  const {
    chainId, token0Address, token0Symbol, token1Address, token1Symbol,
    vol7d, liveAPY, referenceAPY, netAPY,
  } = params;

  // ── 1. Half-range: ±2σ of the 7-day price distribution ───────────────────
  // σ_7d = annualised_vol × √(7/365).  Using period vol (not annualised)
  // produces a realistic LP range width for a ~7-day holding horizon.
  const sigma7d      = (vol7d / 100) * SQRT_7_OVER_365;
  const halfRange    = Math.max(sigma7d * 2, MIN_HALF_RANGE);
  const halfRangePct = +(halfRange * 100).toFixed(3);

  // ── 2. timeInRangePct: empirical from 7d price history ───────────────────
  // Select the dominant (more volatile) token.  For mixed stable/non-stable
  // pairs, the non-stable token drives range exits; for same-type pairs use t0.
  const t0Stable = STABLE_SYMBOLS.has(token0Symbol.toUpperCase().trim());
  const t1Stable = STABLE_SYMBOLS.has(token1Symbol.toUpperCase().trim());
  const domAddr  = (t0Stable && !t1Stable) ? token1Address : token0Address;

  let timeInRangePct: number;
  if (vol7d === 0) {
    // No volatility data → stablecoin pair or brand-new pool; assume high TiR.
    timeInRangePct = 0.95;
  } else {
    // fetchHourlyPrices is cached by VolatilityCalculator; this call is free
    // when enrichRAR has already fetched the same token's prices this cycle.
    const prices = await fetchHourlyPrices(chainId, domAddr, 168);
    if (prices.length >= MIN_PRICE_PTS) {
      const P    = prices[prices.length - 1].price;
      const lo   = P * (1 - halfRange);
      const hi   = P * (1 + halfRange);
      timeInRangePct = prices.filter(p => p.price >= lo && p.price <= hi).length / prices.length;
    } else {
      timeInRangePct = DEFAULT_TIR;
    }
  }

  // ── 3. feeCaptureEfficiency: APY consistency ──────────────────────────────
  // When both live (on-chain recent) and reference (DefiLlama historical) APYs
  // are available, their ratio reveals whether fee generation is spike-driven or
  // sustained.  A 10× divergence means most yield came from a single high-volume
  // day that won't repeat — sqrt softens the penalty gracefully.
  let feeCaptureEfficiency: number;
  if (liveAPY > 0 && referenceAPY > 0) {
    feeCaptureEfficiency = Math.sqrt(
      Math.min(liveAPY, referenceAPY) / Math.max(liveAPY, referenceAPY)
    );
  } else if (liveAPY > 0) {
    // Only on-chain APY available — moderate confidence
    feeCaptureEfficiency = 0.65;
  } else {
    // Only reference APY — lower confidence (may be stale)
    feeCaptureEfficiency = 0.50;
  }

  // ── 4. Composite ─────────────────────────────────────────────────────────
  const capitalUtilization = +(timeInRangePct * feeCaptureEfficiency).toFixed(4);
  const effectiveNetAPY    = +(netAPY * capitalUtilization).toFixed(2);

  return {
    timeInRangePct:       +timeInRangePct.toFixed(4),
    feeCaptureEfficiency: +feeCaptureEfficiency.toFixed(4),
    capitalUtilization,
    effectiveNetAPY,
    halfRangePct,
  };
}
