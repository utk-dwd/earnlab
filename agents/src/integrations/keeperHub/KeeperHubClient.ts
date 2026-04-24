import axios from "axios";
const KEEPERHUB_API = "https://api.keeperhub.io/v1";
export interface RebalanceParams { agentId: number; targetPool: string; tokenA: string; tokenB: string; slippageBps: number; amountIn?: string; }
export class KeeperHubClient {
  private apiKey: string;
  constructor(apiKey?: string) { this.apiKey = apiKey ?? process.env.KEEPERHUB_API_KEY ?? ""; }
  async triggerRebalance(params: RebalanceParams): Promise<string> {
    const resp = await axios.post(`${KEEPERHUB_API}/tasks`, { type: "defi_rebalance", params, gasStrategy: "auto" }, { headers: { Authorization: `Bearer ${this.apiKey}` } });
    return resp.data.txHash as string;
  }
  async registerUpkeep(contractAddress: string, checkData: string): Promise<string> {
    const resp = await axios.post(`${KEEPERHUB_API}/upkeeps`, { contractAddress, checkData }, { headers: { Authorization: `Bearer ${this.apiKey}` } });
    return resp.data.upkeepId as string;
  }
}
