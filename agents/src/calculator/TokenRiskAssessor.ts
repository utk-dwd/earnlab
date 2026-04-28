/**
 * TokenRiskAssessor — checks token and protocol safety before entering a pool.
 *
 * Data source: GoPlus Security API (free, no API key required).
 * Supported chains: 1, 56, 137, 42161, 10, 8453, 43114.
 * Unsupported chains: TIER1 whitelist + stablecoin depeg check only.
 *
 * Hard-block triggers (blockEntry = true):
 *   - honeypot / fake token — funds irrecoverable
 *   - owner_change_balance  — owner can drain the contract
 *   - stablecoin depegged > 5% from $1
 *
 * Advisory scoring (+points, no block):
 *   - unverified source code      +20
 *   - upgradeable proxy           +15
 *   - hidden owner                +25
 *   - selfdestruct present        +30
 *   - blacklist / pause function  +20
 *   - ownership reclaim possible  +25
 *   - transfers pausable          +15
 *   - high buy/sell tax (>10%)    +15 each
 *   - top holder > 30% supply     +15
 *   - fewer than 100 holders      +10
 *
 * TIER1 safe-list (well-known tokens): riskScore = 5, skip API.
 * Cache TTL: 24 h in-memory.
 */

const GOPLUS_BASE  = "https://api.gopluslabs.io/api/v1/token_security";
const FETCH_TIMEOUT_MS = 6_000;
const CACHE_TTL_MS     = 24 * 3_600_000;

// Chains where GoPlus has token-level security data
const GOPLUS_CHAINS = new Set([1, 56, 137, 42161, 10, 8453, 43114]);

// Zero address used as native ETH placeholder on some chains
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

// Symbols that are inherently trusted — skip API call, assign riskScore=5
const TIER1: Set<string> = new Set([
  "WETH","ETH","USDC","USDT","DAI","WBTC","WSTETH","CBETH","RETH","EZETH","WEETH",
  "STETH","FRAX","LUSD","GHO","SDAI","WUSDC","CRVUSD","PYUSD","TUSD","USDBC",
  "USDC.E","BRIDGEDUSD","OP","ARB","MATIC","POL","AVAX","BNB",
]);

// Stablecoin symbols — checked for depeg regardless of TIER1 status
const STABLECOINS: Set<string> = new Set([
  "USDC","USDT","DAI","FRAX","LUSD","GHO","SDAI","USDS","CRVUSD","PYUSD",
  "TUSD","USDBC","USDC.E","WUSDC","BRIDGEDUSD",
]);

// ─── Public types ─────────────────────────────────────────────────────────────

export interface TokenRiskResult {
  symbol:     string;
  riskScore:  number;   // 0–100 (lower = safer)
  blockEntry: boolean;
  flags:      string[];
  tier1:      boolean;  // true → skipped API via whitelist
  checkedAt:  number;
}

export interface PoolRiskResult {
  token0:        TokenRiskResult;
  token1:        TokenRiskResult;
  poolRiskScore: number;   // max(token0.riskScore, token1.riskScore)
  blockEntry:    boolean;  // either token blocks
  flags:         string[]; // combined, de-duped
  checkedAt:     number;
}

interface CacheEntry {
  result:    TokenRiskResult;
  expiresAt: number;
}

// ─── Assessor ─────────────────────────────────────────────────────────────────

export class TokenRiskAssessor {
  private readonly cache = new Map<string, CacheEntry>();

  async assessPool(
    token0Address: string,
    token0Symbol:  string,
    token1Address: string,
    token1Symbol:  string,
    chainId:       number,
    token0Price:   number,
    token1Price:   number,
  ): Promise<PoolRiskResult> {
    const [t0, t1] = await Promise.all([
      this.assessToken(token0Address, token0Symbol, chainId, token0Price),
      this.assessToken(token1Address, token1Symbol, chainId, token1Price),
    ]);

    const allFlags = [...new Set([...t0.flags, ...t1.flags])];
    return {
      token0:        t0,
      token1:        t1,
      poolRiskScore: Math.max(t0.riskScore, t1.riskScore),
      blockEntry:    t0.blockEntry || t1.blockEntry,
      flags:         allFlags,
      checkedAt:     Date.now(),
    };
  }

  private async assessToken(
    address: string,
    symbol:  string,
    chainId: number,
    price:   number,
  ): Promise<TokenRiskResult> {
    const sym = symbol.toUpperCase().replace(/\s+/g, "").trim();

    // Stablecoin depeg check (applies even to TIER1 stablecoins)
    const isStable     = STABLECOINS.has(sym);
    const depegPct     = isStable && price > 0 ? price - 1.0 : 0;
    const isDepegged   = Math.abs(depegPct) > 0.05;

    if (TIER1.has(sym)) {
      const flags: string[] = [];
      let blockEntry = false;
      if (isDepegged) {
        flags.push(`${sym} depegged ${(depegPct * 100 >= 0 ? "+" : "")}${(depegPct * 100).toFixed(1)}% from $1 (price=$${price.toFixed(4)})`);
        blockEntry = true;
      }
      return {
        symbol: sym, riskScore: blockEntry ? 80 : 5,
        blockEntry, flags, tier1: true, checkedAt: Date.now(),
      };
    }

    // Cache lookup
    const cacheKey = `${chainId}:${address.toLowerCase()}`;
    const cached   = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    // GoPlus API fetch for supported chains
    let gpData: Record<string, any> | null = null;
    if (GOPLUS_CHAINS.has(chainId) && address && address !== ZERO_ADDR) {
      gpData = await this.fetchGoPlus(chainId, address);
    }

    const result = this.buildResult(sym, gpData, isDepegged, depegPct, price);
    this.cache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  }

  private async fetchGoPlus(chainId: number, address: string): Promise<Record<string, any> | null> {
    try {
      const url = `${GOPLUS_BASE}/${chainId}?contract_addresses=${address.toLowerCase()}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return null;
      const json: any = await res.json();
      return json?.result?.[address.toLowerCase()] ?? null;
    } catch {
      return null;
    }
  }

  private buildResult(
    symbol:    string,
    gp:        Record<string, any> | null,
    depegged:  boolean,
    depegPct:  number,
    price:     number,
  ): TokenRiskResult {
    const flags: string[] = [];
    let score      = 0;
    let blockEntry = false;

    if (depegged) {
      flags.push(`${symbol} depegged ${(depegPct * 100 >= 0 ? "+" : "")}${(depegPct * 100).toFixed(1)}% from $1 (price=$${price.toFixed(4)})`);
      blockEntry = true;
      score += 100;
    }

    if (!gp) {
      // No API data — minor penalty for unknown token, not a hard block
      flags.push("no security data available");
      score += 10;
      return {
        symbol, riskScore: Math.min(score, 100),
        blockEntry, flags, tier1: false, checkedAt: Date.now(),
      };
    }

    // ── Hard blocks ────────────────────────────────────────────────────────
    if (gp.is_honeypot === "1") {
      flags.push("HONEYPOT: cannot sell tokens");
      blockEntry = true;
      score += 100;
    }
    if (gp.fake_token === "1") {
      flags.push("FAKE TOKEN: confirmed impersonation");
      blockEntry = true;
      score += 100;
    }
    if (gp.owner_change_balance === "1") {
      flags.push("CRITICAL: owner can change holder balances");
      blockEntry = true;
      score += 100;
    }

    // ── Advisory flags ─────────────────────────────────────────────────────
    if (gp.is_open_source !== "1") {
      flags.push("unverified source code");
      score += 20;
    }
    if (gp.is_proxy === "1") {
      flags.push("upgradeable proxy");
      score += 15;
    }
    if (gp.hidden_owner === "1") {
      flags.push("hidden owner");
      score += 25;
    }
    if (gp.can_take_back_ownership === "1") {
      flags.push("ownership can be reclaimed");
      score += 25;
    }
    if (gp.selfdestruct === "1") {
      flags.push("has selfdestruct");
      score += 30;
    }
    if (gp.is_blacklisted === "1") {
      flags.push("blacklist / freeze function");
      score += 20;
    }
    if (gp.transfer_pausable === "1") {
      flags.push("transfers can be paused");
      score += 15;
    }
    if (Number(gp.buy_tax ?? 0) > 0.1) {
      flags.push(`high buy tax (${(Number(gp.buy_tax) * 100).toFixed(1)}%)`);
      score += 15;
    }
    if (Number(gp.sell_tax ?? 0) > 0.1) {
      flags.push(`high sell tax (${(Number(gp.sell_tax) * 100).toFixed(1)}%)`);
      score += 15;
    }

    // ── Holder concentration ───────────────────────────────────────────────
    const holderCount = Number(gp.holder_count ?? 0);
    if (holderCount > 0 && holderCount < 100) {
      flags.push(`very few holders (${holderCount})`);
      score += 10;
    }
    const topHolder = (gp.holders ?? [])[0];
    if (topHolder) {
      const topPct = Number(topHolder.percent ?? 0);
      if (topPct > 0.3) {
        flags.push(`top holder owns ${(topPct * 100).toFixed(1)}% of supply`);
        score += 15;
      }
    }

    return {
      symbol, riskScore: Math.min(score, 100),
      blockEntry, flags, tier1: false, checkedAt: Date.now(),
    };
  }

  clearExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.cache) {
      if (v.expiresAt <= now) this.cache.delete(k);
    }
  }
}
