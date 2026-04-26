/**
 * VolatilityCalculator — annualised volatility of log returns for DeFi tokens.
 *
 * Formula (Sharpe-ratio denominator):
 *   σ_annualised = stdDev( ln(Pₜ / Pₜ₋₁) ) × √8760
 *
 *   where:
 *     • Pₜ  = hourly close price from DefiLlama Coins API
 *     • 8760 = hours per year  (converts hourly σ to annualised σ)
 *     • Result expressed as a decimal, e.g. 0.85 = 85% annualised vol
 *
 * Risk-Adjusted Return (RAR):
 *   RAR = APY% / (σ_annualised × 100)
 *
 *   i.e. APY divided by annualised vol expressed as a percentage.
 *   Dimensionless. Higher = better return per unit of risk.
 *   Equivalent to Sharpe ratio with risk-free rate = 0.
 *
 * For a pair, we use the MAX volatility of the two tokens
 * (worst-case for the LP provider).
 * Stablecoins are assigned a floor vol of 0.5% (near-zero by design).
 */

import axios from "axios";

// ─── Constants ────────────────────────────────────────────────────────────────
const HOURS_PER_YEAR = 8760;          // 365 × 24
const STABLECOIN_VOL = 0.5;           // % annualised vol floor for stablecoins
const CACHE_TTL_MS   = 10 * 60_000;  // 10-minute cache
const STABLECOINS    = new Set([
  "USDC","USDT","DAI","FRAX","LUSD","BUSD","TUSD","USDB","CUSD","CEUR",
  "USDBC","USDBR","USDE","FDUSD","PYUSD","GUSD","SUSD","DOLA","MIM",
]);

// Uniswap v4 uses address(0) for the native token — map to DefiLlama coingecko key
const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";
const NATIVE_COIN_KEY: Record<number, string> = {
  1:        "coingecko:ethereum",
  130:      "coingecko:ethereum",
  10:       "coingecko:ethereum",
  8453:     "coingecko:ethereum",
  42161:    "coingecko:ethereum",
  81457:    "coingecko:ethereum",
  7777777:  "coingecko:ethereum",
  57073:    "coingecko:ethereum",
  1868:     "coingecko:ethereum",
  480:      "coingecko:ethereum",
  137:      "coingecko:matic-network",
  43114:    "coingecko:avalanche-2",
  56:       "coingecko:binancecoin",
  42220:    "coingecko:celo",
  // testnets — use mainnet prices
  11155111: "coingecko:ethereum",
  84532:    "coingecko:ethereum",
  421614:   "coingecko:ethereum",
  1301:     "coingecko:ethereum",
};

// DefiLlama chain slug per chainId
const CHAIN_SLUG: Record<number, string> = {
  1:       "ethereum",
  130:     "unichain",
  10:      "optimism",
  8453:    "base",
  42161:   "arbitrum",
  137:     "polygon",
  81457:   "blast",
  43114:   "avax",
  56:      "bsc",
  42220:   "celo",
  7777777: "zora",
  // testnets: fall back to mainnet prices by symbol
  11155111: "ethereum",
  84532:    "base",
  421614:   "arbitrum",
  1301:     "unichain",
};

// ─── Types ────────────────────────────────────────────────────────────────────
export interface VolatilityResult {
  /** Annualised volatility (%) from last 24 h of hourly data */
  vol24h: number;
  /** Annualised volatility (%) from last 7 d of hourly data */
  vol7d:  number;
  /** Number of data points used */
  n24h:   number;
  n7d:    number;
  /** (P_now - P_then) / P_then over last 24 h */
  priceChange24h: number;
  /** (P_now - P_then) / P_then over last 7 d */
  priceChange7d:  number;
}

export interface RARResult {
  rar24h:  number;   // APY / vol24h
  rar7d:   number;   // APY / vol7d
  vol24h:  number;   // % annualised
  vol7d:   number;   // % annualised
  quality: "excellent" | "good" | "fair" | "poor" | "n/a";
  token0PriceChange24h: number;
  token0PriceChange7d:  number;
  token1PriceChange24h: number;
  token1PriceChange7d:  number;
  /** (token0/token1 exchange rate now − then) / then */
  pairPriceChange24h:   number;
  pairPriceChange7d:    number;
}

// ─── Price cache ──────────────────────────────────────────────────────────────
const volatilityCache = new Map<string, VolatilityResult & { ts: number }>();

// ─── Core math ────────────────────────────────────────────────────────────────
function annualisedVol(prices: { price: number }[]): { vol: number; n: number } {
  if (prices.length < 3) return { vol: 0, n: prices.length };

  const logReturns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const p0 = prices[i - 1].price;
    const p1 = prices[i].price;
    if (p0 > 0 && p1 > 0) logReturns.push(Math.log(p1 / p0));
  }

  if (logReturns.length < 2) return { vol: 0, n: logReturns.length };

  // Population std dev of log returns
  const mean     = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (logReturns.length - 1);
  const stdDev   = Math.sqrt(variance);

  // Annualise: σ_hourly × √(hours_per_year)
  const vol = stdDev * Math.sqrt(HOURS_PER_YEAR) * 100; // convert to %
  return { vol, n: logReturns.length };
}

// ─── DefiLlama price fetch ────────────────────────────────────────────────────
async function fetchHourlyPrices(
  chainId: number,
  tokenAddress: string,
  hours: number
): Promise<{ price: number }[]> {
  const slug  = CHAIN_SLUG[chainId] ?? "ethereum";
  const now   = Math.floor(Date.now() / 1000);
  const start = now - hours * 3600;

  try {
    const coinKey = tokenAddress.toLowerCase() === NATIVE_ADDRESS
      ? (NATIVE_COIN_KEY[chainId] ?? "coingecko:ethereum")
      : `${slug}:${tokenAddress}`;
    const resp = await axios.get("https://coins.llama.fi/chart/" + coinKey, {
      params:  { start, span: hours + 2, period: "1h" },
      timeout: 8_000,
    });
    return resp.data?.coins?.[coinKey]?.prices ?? [];
  } catch {
    return [];
  }
}

// ─── Per-token volatility (cached) ───────────────────────────────────────────
export async function getTokenVolatility(
  chainId:      number,
  tokenAddress: string,
  symbol:       string,
): Promise<VolatilityResult> {
  // Stablecoins: near-zero vol floor, negligible price change
  if (STABLECOINS.has(symbol.toUpperCase())) {
    return { vol24h: STABLECOIN_VOL, vol7d: STABLECOIN_VOL, n24h: 0, n7d: 0, priceChange24h: 0, priceChange7d: 0 };
  }

  const cacheKey = `${chainId}:${tokenAddress.toLowerCase()}`;
  const cached   = volatilityCache.get(cacheKey);
  // Invalidate entries that predate the priceChange fields
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS && Number.isFinite(cached.priceChange24h)) {
    return cached;
  }

  // Fetch 7d of hourly prices (superset covers both windows)
  const prices7d = await fetchHourlyPrices(chainId, tokenAddress, 168);
  const prices24h = prices7d.slice(-25); // last 24 data intervals

  const r24 = annualisedVol(prices24h);
  const r7d = annualisedVol(prices7d);

  const priceChange24h = prices24h.length >= 2 && prices24h[0].price > 0
    ? (prices24h[prices24h.length - 1].price - prices24h[0].price) / prices24h[0].price
    : 0;
  const priceChange7d = prices7d.length >= 2 && prices7d[0].price > 0
    ? (prices7d[prices7d.length - 1].price - prices7d[0].price) / prices7d[0].price
    : 0;

  const result: VolatilityResult = {
    vol24h: r24.vol,
    vol7d:  r7d.vol,
    n24h:   r24.n,
    n7d:    r7d.n,
    priceChange24h,
    priceChange7d,
  };

  volatilityCache.set(cacheKey, { ...result, ts: Date.now() });
  return result;
}

// ─── Pair RAR (uses max vol of the two tokens — worst-case for LP) ─────────────
export async function computePairRAR(params: {
  apy:          number;
  chainId:      number;
  token0Address: string;
  token1Address: string;
  token0Symbol:  string;
  token1Symbol:  string;
}): Promise<RARResult> {
  const { apy, chainId, token0Address, token1Address, token0Symbol, token1Symbol } = params;

  if (!apy || apy <= 0) {
    return { rar24h: 0, rar7d: 0, vol24h: 0, vol7d: 0, quality: "n/a",
      token0PriceChange24h: 0, token0PriceChange7d: 0,
      token1PriceChange24h: 0, token1PriceChange7d: 0,
      pairPriceChange24h: 0, pairPriceChange7d: 0 };
  }

  const [v0, v1] = await Promise.all([
    getTokenVolatility(chainId, token0Address, token0Symbol),
    getTokenVolatility(chainId, token1Address, token1Symbol),
  ]);

  // Use the MAX (more volatile token drives LP risk)
  const vol24h = Math.max(v0.vol24h, v1.vol24h);
  const vol7d  = Math.max(v0.vol7d,  v1.vol7d);

  const rar24h = vol24h > 0 ? +(apy / vol24h).toFixed(3) : 0;
  const rar7d  = vol7d  > 0 ? +(apy / vol7d).toFixed(3)  : 0;

  // Quality based on the more stable (7d) estimate
  const quality = rarQuality(rar7d);

  // Pair exchange-rate change: (token0/token1 now) / (token0/token1 then) - 1
  // = (1 + token0Change) / (1 + token1Change) - 1
  const denom24h = 1 + (v1.priceChange24h ?? 0);
  const denom7d  = 1 + (v1.priceChange7d  ?? 0);
  const pairPriceChange24h = Number.isFinite(v0.priceChange24h) && denom24h !== 0
    ? (1 + (v0.priceChange24h ?? 0)) / denom24h - 1 : 0;
  const pairPriceChange7d  = Number.isFinite(v0.priceChange7d) && denom7d !== 0
    ? (1 + (v0.priceChange7d  ?? 0)) / denom7d  - 1 : 0;

  return {
    rar24h, rar7d,
    vol24h: +vol24h.toFixed(2), vol7d: +vol7d.toFixed(2),
    quality,
    token0PriceChange24h: v0.priceChange24h,
    token0PriceChange7d:  v0.priceChange7d,
    token1PriceChange24h: v1.priceChange24h,
    token1PriceChange7d:  v1.priceChange7d,
    pairPriceChange24h,
    pairPriceChange7d,
  };
}

export function rarQuality(rar: number): RARResult["quality"] {
  if (rar <= 0)  return "n/a";
  if (rar >= 2)  return "excellent";
  if (rar >= 1)  return "good";
  if (rar >= 0.5) return "fair";
  return "poor";
}

// ─── Tooltip copy (used in frontend) ─────────────────────────────────────────
export const RAR_TOOLTIP_24H = `Risk-Adjusted Return (24 h)
= APY ÷ σ₂₄ₕ

σ₂₄ₕ = stdDev[ ln(Pₜ/Pₜ₋₁) ] × √8760
  • 24 hourly log-returns of the pool's most volatile token
  • ×√8760 annualises to 1 year of hourly data
  • Uses max volatility of the two tokens (worst-case LP exposure)

Equivalent to Sharpe ratio (risk-free rate = 0).
Higher = better return per unit of price risk.`;

export const RAR_TOOLTIP_7D = `Risk-Adjusted Return (7 d)
= APY ÷ σ₇ₐ

σ₇ₐ = stdDev[ ln(Pₜ/Pₜ₋₁) ] × √8760
  • 168 hourly log-returns (7 days × 24 h)
  • More stable estimate than 24 h — less noise from single-day spikes
  • Uses max volatility of the two tokens (worst-case LP exposure)

Equivalent to Sharpe ratio (risk-free rate = 0).
Higher = better return per unit of price risk.`;
