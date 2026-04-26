// ── Portfolio agent message types (all sent over AXL send/recv) ──────────────

/** YieldHunter broadcasts when it finds a high-yield opportunity */
export interface YieldOpportunityMsg {
  type: "YIELD_OPPORTUNITY";
  hunterKey: string;
  opportunityId: string;  // uuid
  protocol: string;       // "uniswap-v3" | "curve" | etc
  poolAddress: string;
  tokenA: string;
  tokenB: string;
  apy: number;            // decimal e.g. 0.12 = 12%
  tvl: number;            // USD
  timestamp: number;
}

/**
 * RiskManager challenges an opportunity.
 * Broadcast to all peers — PortfolioManager picks it up and uses it to decide.
 */
export interface RiskChallenge {
  type: "RISK_CHALLENGE";
  riskManagerKey: string;
  opportunityId: string;
  riskScore: number;      // 0-100 (higher = riskier)
  sharpeEstimate: number; // apy / riskScore normalised
  approved: boolean;
  maxAllocation: number;  // max % RiskManager recommends (0–0.30)
  reasoning: string;
}

/**
 * PortfolioManager's final decision on an opportunity.
 * Broadcast to all so everyone knows what was done.
 */
export interface AllocationDecision {
  type: "ALLOCATION_DECISION";
  portfolioManagerKey: string;
  opportunityId: string;
  approved: boolean;
  requestedAllocation: number;  // what YieldHunter wanted
  actualAllocation: number;     // what PM allocated (may be capped at 30%)
  cappedBy30pct: boolean;       // true if the 30% rule fired
  riskApproved: boolean;        // whether RiskManager gave the green light
  reasoning: string;
}

/** PortfolioManager periodically broadcasts its current positions */
export interface PortfolioSnapshot {
  type: "PORTFOLIO_SNAPSHOT";
  portfolioManagerKey: string;
  positions: Array<{ id: string; allocation: number }>; // sorted desc
  maxPosition: number;  // always 0.30
  utilisation: number;  // total allocated (ideally close to 1.0)
  timestamp: number;
}

/** Critic-style performance request (for RiskManager's rating cycle) */
export interface PerfRequest {
  type: "PERF_REQUEST";
  riskManagerKey: string;
  requestId: string;
  epoch: number;
}

export interface PerfResponse {
  type: "PERF_RESPONSE";
  fromKey: string;
  requestId: string;
  agentRole: "portfolio-manager" | "yield-hunter";
  // PortfolioManager fields
  positionCount?: number;
  avgAllocation?: number;
  maxPosition?: number;
  approvalRate?: number;     // fraction of opportunities approved
  // YieldHunter fields
  opportunitiesFound?: number;
  avgApy?: number;
  bestApy?: number;
}

export interface RiskAssessment {
  type: "RISK_ASSESSMENT";
  riskManagerKey: string;
  epoch: number;
  assessments: Array<{
    agentKey: string;
    role: string;
    score: number;    // 0–10 risk-adjusted score
    details: Record<string, number>;
  }>;
}

export type PortfolioMessage =
  | YieldOpportunityMsg | RiskChallenge | AllocationDecision
  | PortfolioSnapshot | PerfRequest | PerfResponse | RiskAssessment;
