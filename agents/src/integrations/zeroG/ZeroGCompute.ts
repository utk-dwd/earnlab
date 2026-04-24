import axios from "axios";
import { AgentConfig, YieldOpportunity } from "../../types";
const ZG_COMPUTE = process.env.ZG_COMPUTE_ENDPOINT ?? "https://compute.0g.ai";
export class ZeroGCompute {
  private endpoint: string;
  constructor(endpoint?: string) { this.endpoint = endpoint ?? ZG_COMPUTE; }
  async rankOpportunities(opportunities: YieldOpportunity[], config: AgentConfig): Promise<YieldOpportunity[]> {
    const resp = await axios.post(`${this.endpoint}/v1/jobs`, { task: "rank_yield_opportunities", payload: { opportunities, riskProfile: config.riskProfile, strategyType: config.strategyType } });
    return this.pollJobResult(resp.data.jobId);
  }
  private async pollJobResult(jobId: string): Promise<YieldOpportunity[]> {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const resp = await axios.get(`${this.endpoint}/v1/jobs/${jobId}`);
      if (resp.data.status === "completed") return resp.data.result as YieldOpportunity[];
      if (resp.data.status === "failed") throw new Error(`0G Compute job failed: ${resp.data.error}`);
    }
    throw new Error("0G Compute job timed out");
  }
}
