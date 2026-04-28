/**
 * LiquidityQualityCalculator — composite score (0–100) that discounts pools
 * whose headline APY is backed by thin liquidity, one-day volume spikes, or
 * inconsistent fee generation.
 *
 * score = geomean(tvl, activity, stability, depth)^(1/4) × 100
 *
 * Each component is 0–1:
 *
 *   tvl        — absolute pool size vs fee-tier target (target varies: $2M for 0.01%, $100K for 1%)
 *   activity   — daily volume/TVL turnover (0–1, capped at 1× to prevent spike gaming)
 *   stability  — sqrt(min(live,ref)/max(live,ref)) — decays gracefully when APYs diverge
 *   depth      — TVL vs what the pair's volatility demands (more vol → need more TVL to stay deep)
 *
 * Geometric mean is used so a weak component (e.g. stability=0.1 on a spike)
 * pulls the whole score down hard, not just a slice of an additive sum.
 */

// ─── Tuning constants ─────────────────────────────────────────────────────────

// "Good" TVL for each fee tier — above this, tvlScore = 1.0
const TVL_TARGETS: Record<number, number> = {
  100:   2_000_000,   // 0.01% — stable pairs, needs deep capital
  500:     500_000,   // 0.05%
  3000:    200_000,   // 0.3%
  10000:   100_000,   // 1%
};
const TVL_TARGET_DEFAULT = 200_000;

// activity cap: daily vol/TVL above 1× is treated as 1× (volume spike protection)
const ACTIVITY_CAP = 1.0;

// depth: $10k of TVL required per 1% of annualised volatility
// vol7d = 100% → need $1M to reach depthScore=1.0; vol7d=5% → floor of $50k
const DEPTH_USD_PER_VOL_PCT = 10_000;
const DEPTH_TVL_FLOOR       = 50_000;
const DEPTH_DEFAULT_VOL     = 20;    // assumed volatility when vol7d=0 (not yet computed)

// ─── Public types ─────────────────────────────────────────────────────────────

export interface LQResult {
  score:          number;   // 0–100, the headline composite
  tvlScore:       number;   // 0–1
  activityScore:  number;   // 0–1
  stabilityScore: number;   // 0–1
  depthScore:     number;   // 0–1
}

// ─── Core function ────────────────────────────────────────────────────────────

export function computeLiquidityQuality(
  tvlUsd:       number,
  volume24hUsd: number,
  feeTier:      number,
  liveAPY:      number,
  referenceAPY: number,
  apySource:    "live" | "reference",
  vol7d:        number,
): LQResult {
  const tvlTarget = TVL_TARGETS[feeTier] ?? TVL_TARGET_DEFAULT;

  // 1. Size component — does the pool have enough capital to trust?
  const tvlScore = tvlUsd > 0
    ? Math.min(tvlUsd / tvlTarget, 1.0)
    : 0;

  // 2. Activity component — is the pool genuinely used?
  //    Capped at 1× to prevent a single-day volume spike from scoring 100%.
  const activityScore = tvlUsd > 0
    ? Math.min(volume24hUsd / tvlUsd, ACTIVITY_CAP)
    : 0;

  // 3. Stability component — is the APY signal consistent over time?
  //    Uses the ratio of liveAPY to referenceAPY. A large divergence in either
  //    direction signals either a volume spike (live >> ref) or a sudden collapse.
  //    sqrt() gives graceful decay: 4× divergence → score 0.5 rather than 0.25.
  let stabilityScore: number;
  if (liveAPY > 0 && referenceAPY > 0) {
    const lo = Math.min(liveAPY, referenceAPY);
    const hi = Math.max(liveAPY, referenceAPY);
    stabilityScore = Math.sqrt(lo / hi);
  } else {
    // Only one APY source — moderate penalty
    stabilityScore = apySource === "live" ? 0.6 : 0.4;
  }

  // 4. Depth component — is TVL adequate for this pair's volatility?
  //    Volatile pairs exit their concentrated range more often; they need
  //    proportionally more TVL to remain "deep" for the average trade.
  const vol      = vol7d > 0 ? vol7d : DEPTH_DEFAULT_VOL;
  const reqTvl   = Math.max(DEPTH_TVL_FLOOR, vol * DEPTH_USD_PER_VOL_PCT);
  const depthScore = tvlUsd > 0
    ? Math.min(tvlUsd / reqTvl, 1.0)
    : 0;

  // Geometric mean → 0–100
  const raw   = tvlScore * activityScore * stabilityScore * depthScore;
  const score = Math.round(Math.pow(raw, 0.25) * 100);

  return { score, tvlScore, activityScore, stabilityScore, depthScore };
}

/** sqrt(lq/100) — used as a ranking multiplier so weak-LQ pools are penalised
 *  but not completely excluded from ranking. */
export function lqRankFactor(liquidityQuality: number): number {
  return Math.sqrt(Math.max(0, liquidityQuality) / 100);
}

/**
 * Combined rank multiplier: LQ quality × APY persistence.
 *
 * Both are applied so a pool must be both liquid-quality AND show durable yield
 * to rank highly.  Examples:
 *   lq=80, persist=0.9  → 0.894 × 0.90 = 0.80   (solid pool, persistent APY)
 *   lq=70, persist=0.13 → 0.837 × 0.13 = 0.11   (decent pool, one-day spike)
 *   lq=20, persist=1.0  → 0.447 × 1.00 = 0.45   (thin pool, but APY is stable)
 */
export function rankFactor(liquidityQuality: number, apyPersistence: number): number {
  return lqRankFactor(liquidityQuality) * Math.max(0, Math.min(apyPersistence, 1.0));
}
