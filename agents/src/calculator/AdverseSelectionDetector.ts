/**
 * AdverseSelectionDetector — identifies whether LP fees are earned from informed
 * directional traders rather than balanced two-way volume.
 *
 * Adverse selection in AMM pools: informed traders swap against LPs when the
 * true price has already moved, collecting profit from the stale quote.  LPs
 * receive fees but lose more to IL.  Signs:
 *
 *   feeEarnedVsPriceMove       fee APY spiked while price moved sharply in one
 *                               direction — fees paid by traders who knew the price
 *
 *   volumeDuringLargeMoves     high turnover coinciding with elevated recent vol
 *                               (proxy, as hourly pool volume is not available)
 *
 *   postTradePriceDrift        hourly log-return series is momentum-trending rather
 *                               than mean-reverting — two components:
 *                               · trendiness = |Σrₜ| / Σ|rₜ| (0=random, 1=monotone)
 *                               · lag-1 autocorrelation of returns (positive = momentum)
 *
 *   volatilityAfterVolumeSpikes  vol in the second half of the 24h window vs the
 *                                first half; >1 means vol is building, not dissipating
 *
 * Composite score (0–100, higher = worse for LPs):
 *   0.30 × feeVsPriceMove
 * + 0.25 × volumeDuringLargeMoves
 * + 0.25 × postTradePriceDrift × 100
 * + 0.20 × volAccelerationScore
 *
 * All four raw signals use the same 168-hour price cache populated by
 * VolatilityCalculator, so this call is free when enrichRAR has already run.
 */

import { fetchHourlyPrices } from "./VolatilityCalculator";
import { STABLE_SYMBOLS }    from "./StablecoinRiskAssessor";

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_HOURLY_POINTS     = 12;   // minimum 24h data points for signals 3 & 4
const FEE_SPIKE_DIVISOR     = 10;   // (feeSpikeRatio-1) × priceMoveSize / 10 → 0–1
const VOL_ACCEL_DIVISOR     = 1.5;  // (lateVol/earlyVol − 1) / 1.5 → 1.0 at 2.5× vol increase

// Composite weights — must sum to 1.0
const W_FEE_MOVE  = 0.30;
const W_VOL_MOVES = 0.25;
const W_DRIFT     = 0.25;
const W_VOL_ACCEL = 0.20;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface AdverseSelectionResult {
  /** Overall adverse selection score 0–100. Higher = more likely toxic LP flow. */
  score:    number;
  /** Categorical label for the score. */
  quality:  "low" | "moderate" | "elevated" | "high";
  /**
   * Fee APY spike aligned with sharp directional price move (0–100).
   * = clamp(max(0, liveAPY/refAPY − 1) × |Δ24h%| / 10, 0, 100).
   * High → fees are spiking exactly when price is moving one way.
   */
  feeVsPriceMove:              number;
  /**
   * Volume concentration during elevated volatility (0–100).
   * Proxy: daily vol/TVL turnover × max(0, vol24h/vol7d − 1).
   * High → large volumes arrived during abnormally volatile periods.
   */
  volumeDuringLargeMoves:      number;
  /**
   * Price momentum over last 24h (0–1, higher = more directional).
   * Blend of trendiness (|net_return| / Σ|returns|) and
   * lag-1 autocorrelation of hourly log-returns.
   * Positive autocorrelation = price keeps moving in same direction = informed flow.
   */
  postTradePriceDrift:         number;
  /**
   * Volatility in the second 12h vs the first 12h of the 24h window.
   * > 1 = volatility is building; > 1.5 = strong acceleration.
   * Informed trades tend to precede ongoing price discovery.
   */
  volatilityAfterVolumeSpikes: number;
  /** Human-readable flags for elevated sub-signals. */
  flags: string[];
}

// ─── Helper math ──────────────────────────────────────────────────────────────

function logReturns(prices: { price: number }[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const p0 = prices[i - 1].price;
    const p1 = prices[i].price;
    if (p0 > 0 && p1 > 0) r.push(Math.log(p1 / p0));
  }
  return r;
}

// Root-mean-square vol — more robust than std dev for short windows
function rmsVol(returns: number[]): number {
  if (returns.length < 2) return 0;
  return Math.sqrt(returns.reduce((s, r) => s + r * r, 0) / returns.length);
}

// ─── Core function ────────────────────────────────────────────────────────────

export async function detectAdverseSelection(params: {
  chainId:            number;
  token0Address:      string;
  token0Symbol:       string;
  token1Address:      string;
  token1Symbol:       string;
  liveAPY:            number;
  referenceAPY:       number;
  vol24h:             number;
  vol7d:              number;
  tvlUsd:             number;
  volume24hUsd:       number;
  /** Pair price change (token0/token1 rate) over last 24h — decimal, e.g. 0.05 = +5%. */
  pairPriceChange24h: number;
}): Promise<AdverseSelectionResult> {
  const {
    chainId, token0Address, token0Symbol, token1Address, token1Symbol,
    liveAPY, referenceAPY, vol24h, vol7d,
    tvlUsd, volume24hUsd, pairPriceChange24h,
  } = params;

  // ── Dominant token (most volatile — drives LP risk) ───────────────────────
  const t0Stable = STABLE_SYMBOLS.has(token0Symbol.toUpperCase().trim());
  const t1Stable = STABLE_SYMBOLS.has(token1Symbol.toUpperCase().trim());
  const domAddr  = (t0Stable && !t1Stable) ? token1Address : token0Address;

  // Fetch 7d hourly prices (hits the shared cache when enrichRAR already ran)
  const prices7d  = await fetchHourlyPrices(chainId, domAddr, 168);
  // 24h window: last 25 points (24 intervals)
  const prices24h = prices7d.slice(-25);

  // ── Signal 1: feeEarnedVsPriceMove ───────────────────────────────────────
  // A fee APY spike that coincides with a sharp directional price move suggests
  // informed traders took the other side of the LP position.
  const feeSpikeRatio = (liveAPY > 1 && referenceAPY > 1)
    ? liveAPY / referenceAPY
    : 1.0;
  const priceMoveSize = Math.abs(pairPriceChange24h) * 100; // e.g. 5.2 for 5.2%
  const s1Raw = Math.max(0, feeSpikeRatio - 1.0) * priceMoveSize / FEE_SPIKE_DIVISOR;
  const feeVsPriceMove = +(Math.min(s1Raw, 1.0) * 100).toFixed(1);

  // ── Signal 2: volumeDuringLargeMoves ─────────────────────────────────────
  // Without hourly volume, proxy with: high daily turnover (vol/TVL) concurrent
  // with vol24h > vol7d baseline.  When both are elevated simultaneously,
  // the volume is likely concentrated in volatile, adversely selected hours.
  const turnover  = Math.min(volume24hUsd / Math.max(tvlUsd, 1), 2.0); // cap at 2×
  const volRatio  = (vol24h > 0 && vol7d > 0) ? vol24h / vol7d : 1.0;
  // Only score when vol24h materially exceeds the 7d baseline
  const s2Raw = (turnover / 2) * Math.max(volRatio - 1.0, 0);
  const volumeDuringLargeMoves = +(Math.min(s2Raw, 1.0) * 100).toFixed(1);

  // ── Signal 3: postTradePriceDrift ─────────────────────────────────────────
  // Two components:
  //   trendiness    — how "straight" the price path is (random walk ≈ 0.5, trend ≈ 1)
  //   lag1Autocorr  — positive = momentum (price keeps going same direction)
  let postTradePriceDrift = 0;
  if (prices24h.length >= MIN_HOURLY_POINTS) {
    const r = logReturns(prices24h);
    if (r.length >= 4) {
      // Trendiness
      const netMove        = r.reduce((a, b) => a + b, 0);
      const totalVariation = r.reduce((a, b) => a + Math.abs(b), 0);
      const trendiness     = totalVariation > 0 ? Math.abs(netMove) / totalVariation : 0;

      // Lag-1 autocorrelation of returns
      const mean     = netMove / r.length;
      const demeaned = r.map(v => v - mean);
      const cov1     = demeaned.slice(1).reduce((s, v, i) => s + v * demeaned[i], 0) / (r.length - 1);
      const variance = demeaned.reduce((s, v) => s + v * v, 0) / r.length;
      const lag1     = variance > 0 ? cov1 / variance : 0;  // clamped implicitly to ~(-1, 1)

      // Blend: positive autocorr raises score; trendiness amplifies it
      const autocorrSignal = Math.max(0, Math.min(lag1, 1));
      postTradePriceDrift  = +((0.5 * trendiness + 0.5 * autocorrSignal)).toFixed(4);
    }
  }
  const s3 = postTradePriceDrift; // 0–1

  // ── Signal 4: volatilityAfterVolumeSpikes ────────────────────────────────
  // Split the 24h window in half and compare RMS vol in each half.
  // If the second half is more volatile, vol is building — typical of informed flow
  // that triggers ongoing price discovery.
  let volatilityAfterVolumeSpikes = 1.0;
  let s4 = 0;
  if (prices24h.length >= MIN_HOURLY_POINTS * 2) {
    const mid   = Math.floor(prices24h.length / 2);
    const early = logReturns(prices24h.slice(0, mid + 1));
    const late  = logReturns(prices24h.slice(mid));
    const earlyVol = rmsVol(early);
    const lateVol  = rmsVol(late);
    if (earlyVol > 0) {
      volatilityAfterVolumeSpikes = +(lateVol / earlyVol).toFixed(3);
    }
    s4 = Math.min(Math.max(volatilityAfterVolumeSpikes - 1.0, 0) / VOL_ACCEL_DIVISOR, 1.0);
  }
  const volAccScore = +(s4 * 100).toFixed(1);

  // ── Composite ─────────────────────────────────────────────────────────────
  const score = +(
    W_FEE_MOVE  * feeVsPriceMove  +
    W_VOL_MOVES * volumeDuringLargeMoves +
    W_DRIFT     * s3 * 100 +
    W_VOL_ACCEL * volAccScore
  ).toFixed(1);

  const quality: AdverseSelectionResult["quality"] =
    score >= 70 ? "high" :
    score >= 45 ? "elevated" :
    score >= 25 ? "moderate" : "low";

  const flags: string[] = [];
  if (feeVsPriceMove >= 40)
    flags.push(`Fee spike during price move (${feeVsPriceMove.toFixed(0)}/100): fees arrived with directional flow`);
  if (volumeDuringLargeMoves >= 40)
    flags.push(`Volume during volatile moves (${volumeDuringLargeMoves.toFixed(0)}/100): elevated turnover + vol spike`);
  if (postTradePriceDrift >= 0.55)
    flags.push(`Directional momentum (drift=${(postTradePriceDrift * 100).toFixed(0)}%): price trending, not mean-reverting`);
  if (volatilityAfterVolumeSpikes >= 1.5)
    flags.push(`Vol acceleration (${volatilityAfterVolumeSpikes.toFixed(2)}×): late-session vol > early-session`);

  return {
    score,
    quality,
    feeVsPriceMove,
    volumeDuringLargeMoves,
    postTradePriceDrift,
    volatilityAfterVolumeSpikes,
    flags,
  };
}
