// Mirrors the OpenAPI schema — keeps frontend and agent in sync

export interface RankedOpportunity {
  rank:          number;
  chainId:       number;
  chainName:     string;
  network:       "mainnet" | "testnet";
  poolId:        string;
  pair:          string;
  feeTier:       number;
  feeTierLabel:  string;
  liveAPY:       number;
  referenceAPY:  number;
  displayAPY:    number;
  apySource:     "live" | "reference";
  risk:          "low" | "medium" | "high" | "extreme";
  tvlUsd:        number;
  volume24hUsd:  number;
  token0Price:   number;
  token1Price:   number;
  rar24h:        number;
  rar7d:         number;
  vol24h:        number;
  vol7d:         number;
  rarQuality:           "excellent" | "good" | "fair" | "poor" | "n/a";
  token0PriceChange24h: number;
  token0PriceChange7d:  number;
  token1PriceChange24h: number;
  token1PriceChange7d:  number;
  pairPriceChange24h:   number;
  pairPriceChange7d:    number;
  lastUpdated:          number;
}

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

export interface AgentDecision {
  action:         "enter" | "exit" | "rebalance" | "hold" | "wait";
  pool?:          string;
  allocationPct?: number;
  confidence:     number;
  reasoning:      string;
  exitCondition?: string;
}

export interface DecisionCycle {
  decisions:  AgentDecision[];
  reasoning:  string;
  timestamp:  number;
  rawTokens:  number;
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
