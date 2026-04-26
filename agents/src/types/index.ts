export interface YieldOpportunity {
  protocol: string; poolAddress: string; tokenA: string; tokenB: string;
  feeTier: number; apy: number; tvl: number; timestamp: number;
}
export interface AgentConfig {
  agentId: number; inftTokenId: number; ownerAddress: string;
  strategyType: StrategyType; riskProfile: RiskProfile;
  maxSlippageBps: number; rebalanceThresholdBps: number; targetChains: number[];
}
export enum StrategyType {
  YieldFarming = "yield_farming", DeltaNeutral = "delta_neutral",
  StablecoinLooping = "stablecoin_looping", VolatilityArbitrage = "volatility_arbitrage",
}
export enum RiskProfile { Conservative = "conservative", Moderate = "moderate", Aggressive = "aggressive" }
export interface ExecutionResult {
  executionId: string; agentId: number; strategy: StrategyType;
  txHash?: string; success: boolean; error?: string; timestamp: number;
}
export interface AgentMemoryState {
  agentId: number; lastExecution: number; totalExecutions: number;
  cumulativePnl: number; strategyHistory: ExecutionResult[]; storageCid?: string;
}
