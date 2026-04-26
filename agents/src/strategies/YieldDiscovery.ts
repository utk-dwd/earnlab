import { RiskProfile, YieldOpportunity } from "../types";
import { UniswapClient } from "../integrations/uniswap/UniswapClient";
const RISK_FILTERS: Record<RiskProfile, { minTvl: bigint; maxFeeTier: number }> = {
  [RiskProfile.Conservative]: { minTvl: BigInt(10_000_000), maxFeeTier: 500 },
  [RiskProfile.Moderate]:     { minTvl: BigInt(1_000_000),  maxFeeTier: 3000 },
  [RiskProfile.Aggressive]:   { minTvl: BigInt(100_000),    maxFeeTier: 10000 },
};
export class YieldDiscovery {
  constructor(private uniswap: UniswapClient) {}
  async scanOpportunities(riskProfile: RiskProfile): Promise<YieldOpportunity[]> {
    const pools = await this.uniswap.getTopPools(100);
    const filter = RISK_FILTERS[riskProfile];
    return pools.filter((p) => p.tvl >= filter.minTvl && p.feeTier <= filter.maxFeeTier).sort((a, b) => b.apy - a.apy);
  }
}
