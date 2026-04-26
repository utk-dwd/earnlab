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
  lastUpdated:   number;
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

export interface YieldsResponse   { count: number; data: RankedOpportunity[] }
export interface PositionsResponse { data: Position[] }
export interface ExecutionsResponse { count: number; data: Execution[] }
