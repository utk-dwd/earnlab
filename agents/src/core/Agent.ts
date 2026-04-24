import { AgentConfig, ExecutionResult } from "../types";
import { AgentMemory } from "./AgentMemory";
import { UniswapClient } from "../integrations/uniswap/UniswapClient";
import { KeeperHubClient } from "../integrations/keeperHub/KeeperHubClient";
import { ZeroGCompute } from "../integrations/zeroG/ZeroGCompute";
import { ZeroGStorage } from "../integrations/zeroG/ZeroGStorage";
import { YieldDiscovery } from "../strategies/YieldDiscovery";

export class EarnlabAgent {
  private config: AgentConfig; private memory: AgentMemory; private uniswap: UniswapClient;
  private keeper: KeeperHubClient; private compute: ZeroGCompute; private yieldDiscovery: YieldDiscovery;
  constructor(config: AgentConfig) {
    this.config = config;
    const storage = new ZeroGStorage();
    this.memory = new AgentMemory(config.agentId, storage);
    this.uniswap = new UniswapClient(); this.keeper = new KeeperHubClient();
    this.compute = new ZeroGCompute(); this.yieldDiscovery = new YieldDiscovery(this.uniswap);
  }
  async initialize(storageCid?: string): Promise<void> { if (storageCid) await this.memory.load(storageCid); }
  async run(): Promise<ExecutionResult> {
    const startTime = Date.now();
    try {
      const opportunities = await this.yieldDiscovery.scanOpportunities(this.config.riskProfile);
      const ranked = await this.compute.rankOpportunities(opportunities, this.config);
      const best = ranked[0];
      const txHash = await this.keeper.triggerRebalance({ agentId: this.config.agentId, targetPool: best.poolAddress, tokenA: best.tokenA, tokenB: best.tokenB, slippageBps: this.config.maxSlippageBps });
      this.memory.update({ lastExecution: startTime, totalExecutions: this.memory.get().totalExecutions + 1, strategyHistory: [...this.memory.get().strategyHistory.slice(-99), { executionId: txHash, agentId: this.config.agentId, strategy: this.config.strategyType, txHash, success: true, timestamp: startTime }] });
      const newCid = await this.memory.persist();
      console.log(`[Agent ${this.config.agentId}] Memory persisted: ${newCid}`);
      return { executionId: txHash, agentId: this.config.agentId, strategy: this.config.strategyType, txHash, success: true, timestamp: startTime };
    } catch (error: any) {
      return { executionId: `err-${startTime}`, agentId: this.config.agentId, strategy: this.config.strategyType, success: false, error: error.message, timestamp: startTime };
    }
  }
}
