import { YieldOpportunity } from "../../types";

const DEFILLAMA_YIELDS = "https://yields.llama.fi/pools";

/**
 * UniswapClient — fetches Uniswap V3 pool data from DefiLlama yields API.
 * Free, no API key, no rate limits for light usage.
 */
export class UniswapClient {
  async getTopPools(limit = 50): Promise<YieldOpportunity[]> {
    const resp = await fetch(DEFILLAMA_YIELDS);
    if (!resp.ok) throw new Error(`DefiLlama HTTP ${resp.status}`);
    const json = await resp.json() as any;

    const pools: any[] = json.data ?? [];

    // Filter Uniswap V3 on Ethereum mainnet
    const uniswapPools = pools
      .filter((p: any) =>
        p.project === "uniswap-v3" &&
        p.chain === "Ethereum" &&
        p.tvlUsd > 100_000   // skip dust pools
      )
      .sort((a: any, b: any) => (b.apy ?? 0) - (a.apy ?? 0))
      .slice(0, limit);

    return uniswapPools.map((pool: any) => {
      const [tokenA = "?", tokenB = "?"] = (pool.symbol ?? "?-?").split("-");
      return {
        protocol:    "uniswap-v3",
        poolAddress: pool.pool,
        tokenA,
        tokenB,
        feeTier:     pool.feeTier ?? 3000,
        apy:         pool.apy ?? 0,
        tvl:         Math.floor(pool.tvlUsd ?? 0),
        timestamp:   Date.now(),
      } satisfies YieldOpportunity;
    });
  }
}
