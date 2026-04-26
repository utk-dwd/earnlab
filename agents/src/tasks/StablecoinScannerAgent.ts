import { YieldScannerAgent } from "./YieldScannerAgent";
import { UniswapClient }     from "../integrations/uniswap/UniswapClient";
import { YieldOpportunity }  from "../types";

const STABLECOINS = new Set(["USDC", "USDT", "DAI", "FRAX", "LUSD", "USDE"]);

export class StablecoinScannerAgent extends YieldScannerAgent {
  private uniswap: UniswapClient;

  constructor(orchestratorPublicKey: string) {
    super("agent2-stablecoin", 9004, ["uniswap-v3-stable", "curve"], orchestratorPublicKey);
    this.uniswap = new UniswapClient();
  }

  async scan(_riskProfile: string, _minTvlUsd: number, maxResults: number): Promise<YieldOpportunity[]> {
    const pools = await this.uniswap.getTopPools(100);
    return pools
      .filter(p => STABLECOINS.has(p.tokenA) && STABLECOINS.has(p.tokenB))
      .sort((a, b) => b.apy - a.apy)
      .slice(0, maxResults);
  }
}
