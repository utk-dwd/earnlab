import { ethers } from "ethers";
import { YieldOpportunity } from "../../types";
const UNISWAP_V3_SUBGRAPH = "https://gateway.thegraph.com/api/public/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV";
const POOL_APY_QUERY = `query TopPools($skip: Int) { pools(first: 50, skip: $skip, orderBy: volumeUSD, orderDirection: desc) { id token0 { symbol } token1 { symbol } feeTier totalValueLockedUSD volumeUSD } }`;
export class UniswapClient {
  private provider: ethers.JsonRpcProvider;
  constructor(rpcUrl?: string) { this.provider = new ethers.JsonRpcProvider(rpcUrl ?? process.env.RPC_URL); }
  async getTopPools(limit = 50): Promise<YieldOpportunity[]> {
    const resp = await fetch(UNISWAP_V3_SUBGRAPH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: POOL_APY_QUERY, variables: { skip: 0 } }) });
    const { data } = await resp.json() as any;
    return data.pools.slice(0, limit).map((pool: any) => ({
      protocol: "uniswap-v3", poolAddress: pool.id, tokenA: pool.token0.symbol, tokenB: pool.token1.symbol,
      feeTier: Number(pool.feeTier), apy: this.estimateApy(pool), tvl: BigInt(Math.floor(Number(pool.totalValueLockedUSD))), timestamp: Date.now(),
    }));
  }
  private estimateApy(pool: any): number {
    const dailyFees = (Number(pool.volumeUSD) * pool.feeTier) / 1_000_000;
    const tvl = Number(pool.totalValueLockedUSD);
    return tvl === 0 ? 0 : (dailyFees * 365) / tvl;
  }
}
