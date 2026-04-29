// Frontend API types. Shared opportunity/enrichment contracts are sourced from
// the agent so `RankedOpportunity` cannot silently drift from the backend.
import type {
  OptimizationResult,
  RankedOpportunity,
} from "../../../agents/src/api/types";

export type {
  AdverseSelectionResult,
  DecisionScorecard,
  EnrichmentError,
  EnrichmentStage,
  OptimizationResult,
  PoolRiskResult,
  PortfolioAllocation,
  RankedOpportunity,
  StablecoinRiskResult,
  StableTokenRisk,
  StressScenario,
  StressTestResult,
  TokenRiskResult,
} from "../../../agents/src/api/types";

export interface Position {
  id:               number;
  chainId:          number;
  chainName:        string;
  poolId:           string;
  token0Symbol:     string;
  token1Symbol:     string;
  feeTier:          number;
  tickLower:        number;
  tickUpper:        number;
  liquidity:        string;
  entryValueUsd:    number;
  entryTimestamp:   number;
  fees0Usd:         number;
  fees1Usd:         number;
  currentValueUsd:  number;
  unrealizedPnlUsd: number;
  realizedAPY:      number;
  status:           "open" | "closed";
  closedTimestamp?: number;
  closedValueUsd?:  number;
}

export interface Execution {
  id:           number;
  timestamp:    number;
  chainId:      number;
  chainName:    string;
  poolId:       string;
  token0Symbol: string;
  token1Symbol: string;
  feeTier:      number;
  action:       "add_liquidity" | "remove_liquidity" | "swap" | "collect_fees";
  amountIn:     string;
  amountOut?:   string;
  txHash?:      string;
  blockNumber?: number;
  gasCostUsd?:  number;
  apyAtEntry?:  number;
  pnlUsd?:      number;
  slippageBps?: number;
  status:       "pending" | "confirmed" | "failed";
}

export interface AgentStats {
  totalExecutions: number;
  totalPositions:  number;
  openPositions:   number;
  totalPnlUsd:     number;
  totalFeesUsd:    number;
}

export interface MockPosition {
  id:              string;
  poolId:          string;
  chainId:         number;
  chainName:       string;
  pair:            string;
  feeTierLabel:    string;
  entryTimestamp:  number;
  entryValueUsd:   number;
  allocationPct:   number;
  entryAPY:        number;
  entryRAR7d:      number;
  currentValueUsd: number;
  earnedFeesUsd:   number;
  pnlUsd:          number;
  pnlPct:          number;
  hoursHeld:       number;
  status:          "open" | "closed";
  closedTimestamp?: number;
  closedValueUsd?:  number;
  closeReason?:     string;
  tickLower:       number;
  tickUpper:       number;
  halfRangePct:    number;
  timeInRangePct:  number;
  exitAlerts:      string[];
  rarTrend:        number[];
  pairMove24hTrend: number[];
}

export interface PortfolioTrade {
  id:           string;
  timestamp:    number;
  action:       "open" | "close";
  poolId:       string;
  pair:         string;
  chainName:    string;
  feeTierLabel: string;
  valueUsd:     number;
  apy:          number;
  rar7d:        number;
  feePaidUsd:   number;
  reason:       string;
}

export interface CritiqueResult {
  veto:       boolean;
  confidence: number;
  reasoning:  string;
}

export interface AgentDecision {
  action:         "enter" | "exit" | "rebalance" | "hold" | "wait";
  pool?:          string;
  allocationPct?: number;
  confidence:     number;
  reasoning:      string;
  exitCondition?: string;
  critique?:      CritiqueResult;
}

export interface DecisionCycle {
  decisions:  AgentDecision[];
  reasoning:  string;
  timestamp:  number;
  rawTokens:  number;
}

export type MacroRegime = "risk-off" | "neutral" | "risk-on";

export interface RiskBudgetDimension {
  id:       string;
  label:    string;
  usedPct:  number;
  limitPct: number;
  ok:       boolean;
  topItem?: string;
}

export interface RiskBudgetState {
  dimensions:    RiskBudgetDimension[];
  cashBufferPct: number;
  cashOk:        boolean;
  canOpenNew:    boolean;
  violations:    string[];
}

export interface PortfolioSummary {
  totalCapitalUsd:        number;
  cashUsd:                number;
  investedUsd:            number;
  totalValueUsd:          number;
  unrealizedPnlUsd:       number;
  unrealizedPnlPct:       number;
  realizedPnlUsd:         number;
  totalEarnedFeesUsd:     number;
  totalFeesPaidUsd:       number;
  openPositions:          number;
  tradeCount:             number;
  lastRebalanceTimestamp: number | null;
  llmEnabled:             boolean;
  lastDecision:           AgentDecision | null;
  lastDecisionAt:         number | null;
  tokenExposure:          Record<string, number>;
  regime:                 MacroRegime;
  riskBudget:             RiskBudgetState;
  portfolioOptimization:  OptimizationResult | null;
}

export interface YieldsResponse          { count: number; data: RankedOpportunity[] }
export interface PositionsResponse       { data: Position[] }
export interface ExecutionsResponse      { count: number; data: Execution[] }
export interface PortfolioPositionsResponse { data: MockPosition[] }
export interface PortfolioTradesResponse    { count: number; data: PortfolioTrade[] }
export interface PortfolioDecisionsResponse { data: DecisionCycle[] }

export interface Reflection {
  id:        number;
  timestamp: number;
  content:   string;
  summary:   string;
  archived:  boolean;
}

export interface ReflectionsResponse {
  enabled:  boolean;
  recent:   Reflection[];
  archived: Reflection[];
}

// SSE event types emitted by /reflections/stream
export type ReflectionSSEEvent =
  | { type: "history";  recent: Reflection[]; archived: Reflection[]; enabled: boolean }
  | { type: "start";    timestamp: number }
  | { type: "chunk";    timestamp: number; text: string }
  | { type: "complete"; timestamp: number; content: string; summary: string; id: number }
  | { type: "error";    timestamp: number; error: string };
