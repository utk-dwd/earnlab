/**
 * APYCalculator — real yield math for Uniswap v4 concentrated liquidity.
 *
 * All formulas derived from:
 *   - Uniswap v3/v4 whitepaper (fee model unchanged)
 *   - IL formula: https://uniswap.org/blog/a-short-history-of-uniswap
 */

// ─── Types ───────────────────────────────────────────────────────────────────
export interface APYInputs {
  /** Total 24h swap volume through the pool in USD */
  volume24hUsd: number;
  /** Total value locked in the pool in USD */
  tvlUsd: number;
  /** Fee tier as raw integer, e.g. 3000 = 0.3% */
  feeTier: number;
}

export interface PositionAPYInputs extends APYInputs {
  /** Current sqrtPriceX96 from StateView */
  sqrtPriceX96Current: bigint;
  /** sqrtPriceX96 at position entry */
  sqrtPriceX96Entry: bigint;
  /** Lower tick of the position */
  tickLower: number;
  /** Upper tick of the position */
  tickUpper: number;
  /** Current tick from StateView.getSlot0 */
  tickCurrent: number;
  /** How many seconds this position has existed */
  positionAgeSecs: number;
  /** Actual fees collected in token0 (scaled by decimals0) */
  feesCollected0: number;
  /** Actual fees collected in token1 (scaled by decimals1) */
  feesCollected1: number;
  /** USD value of fees0 */
  fees0Usd: number;
  /** USD value of fees1 */
  fees1Usd: number;
  /** USD value of the position when it was opened */
  entryValueUsd: number;
}

export interface APYResult {
  /** Raw fee APY from pool volume, assuming full range */
  feeAPY: number;
  /** Impermanent loss as a % (negative means loss) */
  impermanentLoss: number;
  /** Net APY = feeAPY + IL */
  netAPY: number;
}

export interface PositionAPYResult extends APYResult {
  /** Fraction of time the current price was inside [tickLower, tickUpper] (0–1) */
  timeInRange: number;
  /** Fee APY adjusted for time-in-range efficiency */
  adjustedFeeAPY: number;
  /** Realized APY from actual fees collected (annualized) */
  realizedAPY: number;
  /** Unrealized PnL in USD (position value change + uncollected fees) */
  unrealizedPnlUsd: number;
}

// ─── Pool-level APY (no position data needed) ────────────────────────────────
/**
 * Calculate the annualised fee yield for a pool.
 *
 *   dailyFeeIncome = volume24h × (feeTier / 1_000_000)
 *   feeAPY         = (dailyFeeIncome / tvl) × 365 × 100
 */
export function calcPoolFeeAPY({ volume24hUsd, tvlUsd, feeTier }: APYInputs): number {
  if (tvlUsd <= 0) return 0;
  const feeRate = feeTier / 1_000_000; // e.g. 3000 → 0.003
  const dailyFees = volume24hUsd * feeRate;
  return (dailyFees / tvlUsd) * 365 * 100;
}

// ─── Impermanent Loss ────────────────────────────────────────────────────────
/**
 * Classic IL formula for a 50/50 pool.
 * Assumes prices at entry vs now; does NOT account for concentrated range.
 *
 *   IL = 2√k / (1 + k) − 1    where k = currentPrice / entryPrice
 *
 * Returns a fraction (e.g. -0.057 = -5.7% IL).
 */
export function calcImpermanentLoss(entryPrice: number, currentPrice: number): number {
  if (entryPrice <= 0 || currentPrice <= 0) return 0;
  const k = currentPrice / entryPrice;
  return (2 * Math.sqrt(k)) / (1 + k) - 1;
}

/**
 * IL for concentrated liquidity is amplified when the position is narrow.
 * This is an approximation — exact IL requires integrating fee income vs value change.
 */
export function calcConcentratedIL(
  entryPrice: number,
  currentPrice: number,
  priceLower: number,
  priceUpper: number
): number {
  if (currentPrice < priceLower || currentPrice > priceUpper) {
    // Price out of range: position is 100% one token, use capped IL
    const cappedPrice = currentPrice < priceLower ? priceLower : priceUpper;
    return calcImpermanentLoss(entryPrice, cappedPrice);
  }
  // In range: amplify standard IL by range concentration factor
  const rangeWidth = Math.log(priceUpper / priceLower);
  const amplification = Math.max(1, 2 / rangeWidth); // wider range → less amplification
  const baseIL = calcImpermanentLoss(entryPrice, currentPrice);
  return baseIL * amplification;
}

// ─── sqrtPriceX96 → human price ─────────────────────────────────────────────
export function sqrtPriceX96ToHumanPrice(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number
): number {
  const Q96 = 2 ** 96;
  const sqrtRatio = Number(sqrtPriceX96) / Q96;
  return sqrtRatio * sqrtRatio * Math.pow(10, decimals0 - decimals1);
}

// tick → price
export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  return Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1);
}

// ─── Position-level APY ──────────────────────────────────────────────────────
export function calcPositionAPY(inputs: PositionAPYInputs, decimals0 = 18, decimals1 = 6): PositionAPYResult {
  const {
    volume24hUsd,
    tvlUsd,
    feeTier,
    sqrtPriceX96Current,
    sqrtPriceX96Entry,
    tickLower,
    tickUpper,
    tickCurrent,
    positionAgeSecs,
    fees0Usd,
    fees1Usd,
    entryValueUsd,
  } = inputs;

  const feeAPY = calcPoolFeeAPY({ volume24hUsd, tvlUsd, feeTier });

  // Time-in-range: we track this in ExecutionHistory; approximate here
  const inRange = tickCurrent >= tickLower && tickCurrent <= tickUpper;
  // We don't have historical tick data here so we assume optimistically 80% if currently in range
  const timeInRange = inRange ? 0.8 : 0.1;
  const adjustedFeeAPY = feeAPY * timeInRange;

  // IL using price range
  const entryPrice  = sqrtPriceX96ToHumanPrice(sqrtPriceX96Entry,  decimals0, decimals1);
  const currentPrice = sqrtPriceX96ToHumanPrice(sqrtPriceX96Current, decimals0, decimals1);
  const priceLower  = tickToPrice(tickLower, decimals0, decimals1);
  const priceUpper  = tickToPrice(tickUpper, decimals0, decimals1);

  const ilFraction = calcConcentratedIL(entryPrice, currentPrice, priceLower, priceUpper);
  const impermanentLoss = ilFraction * 100; // convert to %

  const netAPY = adjustedFeeAPY + impermanentLoss;

  // Realized APY from actual fees collected
  const totalFeesUsd  = fees0Usd + fees1Usd;
  const ageYears      = positionAgeSecs / (365 * 86400);
  const realizedAPY   = ageYears > 0 && entryValueUsd > 0
    ? (totalFeesUsd / entryValueUsd / ageYears) * 100
    : 0;

  // Unrealized PnL = fees not yet claimed (approximate)
  const unrealizedPnlUsd = totalFeesUsd + entryValueUsd * (ilFraction);

  return {
    feeAPY,
    impermanentLoss,
    netAPY,
    timeInRange,
    adjustedFeeAPY,
    realizedAPY,
    unrealizedPnlUsd,
  };
}

// ─── APY comparison display ──────────────────────────────────────────────────
export function formatAPY(apy: number): string {
  if (!isFinite(apy) || apy === 0) return "0.00%";
  if (apy >= 1000) return ">1000%";
  return `${apy.toFixed(2)}%`;
}

export function apyRisk(apy: number): "low" | "medium" | "high" | "extreme" {
  if (apy < 10)  return "low";
  if (apy < 50)  return "medium";
  if (apy < 200) return "high";
  return "extreme";
}
