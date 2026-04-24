import * as dotenv from "dotenv";
import { EarnlabAgent } from "./core/Agent";
import { AgentConfig, RiskProfile, StrategyType } from "./types";
dotenv.config({ path: "../../.env" });
async function main() {
  const config: AgentConfig = {
    agentId: Number(process.env.AGENT_ID ?? 0), inftTokenId: Number(process.env.INFT_TOKEN_ID ?? 0),
    ownerAddress: process.env.OWNER_ADDRESS ?? "",
    strategyType: (process.env.STRATEGY_TYPE as StrategyType) ?? StrategyType.YieldFarming,
    riskProfile: (process.env.RISK_PROFILE as RiskProfile) ?? RiskProfile.Moderate,
    maxSlippageBps: Number(process.env.MAX_SLIPPAGE_BPS ?? 50),
    rebalanceThresholdBps: Number(process.env.REBALANCE_THRESHOLD_BPS ?? 100),
    targetChains: [1],
  };
  const agent = new EarnlabAgent(config);
  await agent.initialize(process.env.AGENT_MEMORY_CID);
  const intervalMs = Number(process.env.POLL_INTERVAL_MS ?? 60_000);
  console.log(`Agent ${config.agentId} running every ${intervalMs / 1000}s`);
  const runCycle = async () => { const result = await agent.run(); console.log(JSON.stringify(result, null, 2)); };
  await runCycle();
  setInterval(runCycle, intervalMs);
}
main().catch(console.error);
