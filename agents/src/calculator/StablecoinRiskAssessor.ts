/**
 * StablecoinRiskAssessor — six-dimension risk model for stablecoin positions.
 *
 * A stable pool with attractive APY is only safe if peg health and structural
 * risk are acceptable.  This assessor tracks:
 *
 *   pegDeviation      — current |price − $1| in % (from DefiLlama live price)
 *   poolImbalance     — |token0/token1 price ratio − 1| × 100 for stable/stable pools;
 *                       a large imbalance means the pool absorbed a depeg event
 *   issuerRisk        — static tier: protocol + collateral model risk (0–30)
 *   bridgeRisk        — static: native vs bridged vs unknown-bridge variant (0–35)
 *   chainRisk         — static: chain maturity / security model (0–25)
 *   depegVolatility   — stdDev(hourly price − $1) over 7 d, in % points
 *                       captures historical peg instability, not just current state
 *
 * Per-token scores are summed into a composite 0–100 score.
 * Hard block (blockEntry=true): any stablecoin currently depegged > 5%.
 *
 * Only pools with at least one stablecoin produce a result; null is returned
 * for pure non-stable pairs (WETH/ARB, etc.).
 */

import axios from "axios";

// ─── Constants ────────────────────────────────────────────────────────────────

const CACHE_TTL_MS     = 10 * 60_000;  // 10 min — matches VolatilityCalculator
const FETCH_TIMEOUT_MS = 8_000;
const PEG_BLOCK_PCT    = 5;            // depeg > 5% → hard block entry
const PEG_WARN_PCT     = 1;            // > 1% → advisory flag

// ─── Chain slugs (DefiLlama Coins API) ───────────────────────────────────────

const CHAIN_SLUG: Record<number, string> = {
  1:        "ethereum",
  130:      "unichain",
  10:       "optimism",
  8453:     "base",
  42161:    "arbitrum",
  137:      "polygon",
  81457:    "blast",
  43114:    "avax",
  56:       "bsc",
  42220:    "celo",
  7777777:  "zora",
  480:      "worldchain",
  57073:    "ink",
  1868:     "soneium",
  11155111: "ethereum",
  84532:    "base",
  421614:   "arbitrum",
  1301:     "unichain",
};

// ─── Stablecoin registry ──────────────────────────────────────────────────────

export const STABLE_SYMBOLS: Set<string> = new Set([
  "USDC","USDT","DAI","FRAX","LUSD","BUSD","TUSD","USDB","CUSD",
  "USDBC","USDBR","USDE","FDUSD","PYUSD","GUSD","SUSD","DOLA","MIM",
  "CRVUSD","GHO","USDS","SDAI","WUSDC","USDC.E","USDT.E",
  "AXLUSDC","AXLUSDT","CELUSDC","CELUSDT",
]);

// ─── Issuer risk tiers (0 = safest) ──────────────────────────────────────────
// Reflects: collateral model, regulatory exposure, audit maturity, market cap.

const ISSUER_RISK: Record<string, number> = {
  // Centralised — off-chain reserves, highly battle-tested
  USDC: 5,   USDT: 8,   PYUSD: 18,  FDUSD: 20, BUSD: 25,
  // CDP / over-collateralised
  DAI:  10,  LUSD:  12, SDAI: 10,   USDS: 12,
  // Algorithmic / fractional
  FRAX: 18,  CRVUSD: 18, GHO: 20,  DOLA: 22,
  // Yield-bearing / synthetic
  USDB: 25,  USDE: 30,
  // Other known
  MIM:  28,  SUSD: 15,  GUSD: 15,  TUSD: 20,
};
const ISSUER_RISK_DEFAULT = 25; // unknown stablecoin

// ─── Bridge risk ─────────────────────────────────────────────────────────────
// Native USDC via Circle CCTP has no bridge risk.  ".e" = Stargate bridge.
// Axelar / Celer bridges are generally safer than old Multichain.

function bridgeRisk(symbol: string): number {
  const s = symbol.toUpperCase();
  if (s.endsWith(".E"))              return 20; // Stargate bridged (old-style)
  if (s.startsWith("AXL"))          return 15; // Axelar bridge
  if (s.startsWith("CEL"))          return 15; // Celer bridge
  if (s.startsWith("ANY") || s.startsWith("MUL")) return 35; // Multichain (hacked 2023)
  if (s.includes("BRIDGED"))        return 20; // generic bridged wrapper
  return 0; // assumed native / CCTP
}

// ─── Chain risk ──────────────────────────────────────────────────────────────
// Lower = more mature, more secure, more liquidity.

const CHAIN_RISK: Record<number, number> = {
  1:        0,   // Ethereum — most mature
  42161:    5,   // Arbitrum One — proven OP stack
  10:       5,   // Optimism
  8453:     8,   // Base — newer but Coinbase-backed OP stack
  130:      10,  // Unichain — new OP chain
  137:      10,  // Polygon PoS — different security model
  43114:    10,  // Avalanche — separate L1
  56:       15,  // BNB Chain — more centralised validators
  81457:    18,  // Blast — native yield mechanism adds complexity
  42220:    18,  // Celo — separate L1, less liquidity
  7777777:  15,  // Zora — OP stack, newer
  480:      20,  // Worldchain — newer OP chain
  57073:    22,  // Ink — very new
  1868:     22,  // Soneium — very new
  // testnets — treat as same risk as mainnet
  11155111: 0,
  84532:    8,
  421614:   5,
  1301:     10,
};
const CHAIN_RISK_DEFAULT = 20;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface StableTokenRisk {
  symbol:          string;
  pegDeviation:    number;  // |current_price − 1| in % (e.g. 0.3 = 0.3%)
  issuerRisk:      number;  // 0–30, static tier
  bridgeRisk:      number;  // 0–35, by symbol pattern
  depegVolatility: number;  // stdDev(hourly price − 1) over 7 d, in %
  tokenScore:      number;  // combined 0–100
}

export interface StablecoinRiskResult {
  isStablePool:    boolean;  // both tokens are stablecoins
  hasStable:       boolean;  // at least one stablecoin

  // Per-token (null if token is not a stablecoin)
  token0Risk:      StableTokenRisk | null;
  token1Risk:      StableTokenRisk | null;

  // Dimensions
  pegDeviation:    number;  // max of token0/token1 peg deviations (%)
  poolImbalance:   number;  // |token0/token1 price ratio − 1| × 100 (stable/stable only)
  issuerRisk:      number;  // max of token issuer scores
  bridgeRisk:      number;  // max bridge risk score
  chainRisk:       number;  // chain maturity score
  depegVolatility: number;  // max of token0/token1 peg volatility over 7 d

  compositeScore:  number;  // 0–100 weighted
  blockEntry:      boolean; // any stable depegged > 5%
  flags:           string[];
  checkedAt:       number;
}

// ─── Price history cache ──────────────────────────────────────────────────────

interface PriceCache {
  prices:    number[];  // hourly USD prices for last 7 d
  fetchedAt: number;
}
const priceCache = new Map<string, PriceCache>();

// ─── DefiLlama 7-day peg price fetch ─────────────────────────────────────────

async function fetchPegPrices(chainId: number, address: string): Promise<number[]> {
  const slug    = CHAIN_SLUG[chainId] ?? "ethereum";
  const coinKey = `${slug}:${address.toLowerCase()}`;
  const cached  = priceCache.get(coinKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.prices;

  try {
    const now   = Math.floor(Date.now() / 1000);
    const start = now - 168 * 3600; // 7 days back
    const resp  = await axios.get(`https://coins.llama.fi/chart/${coinKey}`, {
      params:  { start, span: 170, period: "1h" },
      timeout: FETCH_TIMEOUT_MS,
    });
    const raw: { price: number }[] = resp.data?.coins?.[coinKey]?.prices ?? [];
    const prices = raw.map(p => p.price);
    priceCache.set(coinKey, { prices, fetchedAt: Date.now() });
    return prices;
  } catch {
    return [];
  }
}

// ─── Math helpers ─────────────────────────────────────────────────────────────

function pegStdDev(prices: number[]): number {
  if (prices.length < 6) return 0; // not enough data
  const deviations = prices.map(p => p - 1.0);
  const mean       = deviations.reduce((a, b) => a + b, 0) / deviations.length;
  const variance   = deviations.reduce((a, b) => a + (b - mean) ** 2, 0) / (deviations.length - 1);
  return Math.sqrt(variance) * 100; // convert to %
}

// ─── Scoring helpers ──────────────────────────────────────────────────────────

function scorePegDeviation(deviationPct: number): number {
  if (deviationPct < 0.10) return 0;
  if (deviationPct < 0.50) return 8;
  if (deviationPct < 1.00) return 18;
  if (deviationPct < 2.00) return 35;
  if (deviationPct < PEG_BLOCK_PCT) return 55;
  return 65; // ≥ 5% is a hard block — score is moot
}

function scoreDepegVol(stddevPct: number): number {
  if (stddevPct === 0)    return 0; // no data — omit penalty
  if (stddevPct < 0.05)  return 0;
  if (stddevPct < 0.10)  return 5;
  if (stddevPct < 0.30)  return 10;
  if (stddevPct < 0.60)  return 18;
  if (stddevPct < 1.00)  return 25;
  return 30;
}

function scorePoolImbalance(imbalancePct: number): number {
  if (imbalancePct < 0.10) return 0;
  if (imbalancePct < 0.50) return 5;
  if (imbalancePct < 1.00) return 10;
  if (imbalancePct < 3.00) return 18;
  return 25;
}

// ─── Assessor ─────────────────────────────────────────────────────────────────

export class StablecoinRiskAssessor {

  async assessPool(
    token0Address: string,
    token0Symbol:  string,
    token1Address: string,
    token1Symbol:  string,
    chainId:       number,
    token0Price:   number,
    token1Price:   number,
  ): Promise<StablecoinRiskResult | null> {
    const sym0 = token0Symbol.toUpperCase().trim();
    const sym1 = token1Symbol.toUpperCase().trim();
    const is0  = STABLE_SYMBOLS.has(sym0);
    const is1  = STABLE_SYMBOLS.has(sym1);

    if (!is0 && !is1) return null; // no stablecoins in this pool

    const [t0, t1] = await Promise.all([
      is0 ? this.assessToken(sym0, token0Address, chainId, token0Price) : null,
      is1 ? this.assessToken(sym1, token1Address, chainId, token1Price) : null,
    ]);

    const flags: string[] = [];
    let blockEntry = false;

    // Peg deviation — hard block if either stable is > 5% off peg
    const maxPegDev = Math.max(t0?.pegDeviation ?? 0, t1?.pegDeviation ?? 0);
    if (maxPegDev >= PEG_BLOCK_PCT) {
      flags.push(`DEPEG: ${maxPegDev.toFixed(2)}% off $1 — hard block`);
      blockEntry = true;
    } else if (maxPegDev >= PEG_WARN_PCT) {
      flags.push(`peg warning: ${maxPegDev.toFixed(2)}% deviation`);
    }

    // Pool imbalance (only meaningful for stable/stable pairs)
    let poolImbalance = 0;
    if (is0 && is1 && token0Price > 0 && token1Price > 0) {
      poolImbalance = Math.abs(token0Price / token1Price - 1.0) * 100;
      if (poolImbalance >= 1) {
        flags.push(`pool imbalance: ${poolImbalance.toFixed(2)}% price ratio skew`);
      }
    }

    // Issuer / bridge flags from individual tokens
    if (t0) flags.push(...t0.flags);
    if (t1) flags.push(...t1.flags);

    // Chain flags
    const cr = CHAIN_RISK[chainId] ?? CHAIN_RISK_DEFAULT;
    if (cr >= 15) flags.push(`chain risk: score ${cr} (newer / less-tested chain)`);

    // Composite: weighted combination of all dimensions
    const issuerMax  = Math.max(t0?.issuerRisk    ?? 0, t1?.issuerRisk    ?? 0);
    const bridgeMax  = Math.max(t0?.bridgeRisk    ?? 0, t1?.bridgeRisk    ?? 0);
    const volMax     = Math.max(t0?.depegVolatility ?? 0, t1?.depegVolatility ?? 0);
    const pegScore   = scorePegDeviation(maxPegDev);
    const volScore   = scoreDepegVol(volMax);
    const imbScore   = scorePoolImbalance(poolImbalance);

    const raw = (
      pegScore  * 0.35 +
      issuerMax * 0.20 +
      volScore  * 0.15 +
      bridgeMax * 0.15 +
      cr        * 0.10 +
      imbScore  * 0.05
    );
    const compositeScore = Math.min(Math.round(raw), 100);

    return {
      isStablePool:    is0 && is1,
      hasStable:       true,
      token0Risk:      t0,
      token1Risk:      t1,
      pegDeviation:    +maxPegDev.toFixed(3),
      poolImbalance:   +poolImbalance.toFixed(3),
      issuerRisk:      issuerMax,
      bridgeRisk:      bridgeMax,
      chainRisk:       cr,
      depegVolatility: +volMax.toFixed(4),
      compositeScore,
      blockEntry,
      flags,
      checkedAt:       Date.now(),
    };
  }

  private async assessToken(
    symbol:  string,
    address: string,
    chainId: number,
    price:   number,
  ): Promise<StableTokenRisk & { flags: string[] }> {
    const flags: string[] = [];

    const pegDeviation    = price > 0 ? Math.abs(price - 1.0) * 100 : 0;
    const issuerScore     = ISSUER_RISK[symbol] ?? ISSUER_RISK_DEFAULT;
    const bridgeScore     = bridgeRisk(symbol);

    // Historical peg volatility from DefiLlama
    let depegVol = 0;
    if (address && address !== "0x0000000000000000000000000000000000000000") {
      const prices = await fetchPegPrices(chainId, address);
      depegVol     = pegStdDev(prices);
    }

    const tokenScore = Math.min(
      scorePegDeviation(pegDeviation) +
      issuerScore +
      bridgeScore +
      scoreDepegVol(depegVol),
      100,
    );

    if (bridgeScore > 0) flags.push(`${symbol}: bridged token (risk +${bridgeScore})`);
    if (issuerScore >= 20) flags.push(`${symbol}: higher issuer risk (${issuerScore})`);
    if (depegVol >= 0.3) flags.push(`${symbol}: peg volatility ${depegVol.toFixed(2)}% stdDev 7d`);

    return { symbol, pegDeviation, issuerRisk: issuerScore, bridgeRisk: bridgeScore, depegVolatility: depegVol, tokenScore, flags };
  }
}
