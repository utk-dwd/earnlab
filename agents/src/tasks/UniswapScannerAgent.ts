import { YieldScannerAgent } from "./YieldScannerAgent";
import { UniswapClient }     from "../integrations/uniswap/UniswapClient";
import { YieldOpportunity, RiskProfile } from "../types";

const RISK_TVL: Record<string, number> = {
  conservative: 10_000_000,
  moderate:     1_000_000,
  aggressive:   100_000,
};

export class UniswapScannerAgent extends YieldScannerAgent {
  private uniswap: UniswapClient;

  constructor(orchestratorPublicKey: string) {
    super("agent1-uniswap", 9003, ["uniswap-v3"], orchestratorPublicKey);
    this.uniswap = new UniswapClient();
  }

  async scan(riskProfile: string, minTvlUsd: number, maxResults: number): Promise<YieldOpportunity[]> {
    const minTvl = BigInt(RISK_TVL[riskProfile] ?? minTvlUsd);
    const pools  = await this.uniswap.getTopPools(100);
    return pools
      .filter(p => p.tvl >= minTvl)
      .sort((a, b) => b.apy - a.apy)
      .slice(0, maxResults);
  }
}
