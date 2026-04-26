import { YieldOpportunity, RiskProfile } from "./index";

export type MessageType =
  | "SCAN_REQUEST"
  | "SCAN_RESULT"
  | "EXECUTE_COMMAND"
  | "EXECUTE_RESULT"
  | "HEARTBEAT"
  | "AGENT_READY";

export interface BaseMessage {
  type:      MessageType;
  taskId:    string;
  timestamp: number;
  fromAgent: string;   // "orchestrator" | "agent1" | "agent2"
}

// ── Orchestrator → Task Agents ────────────────────────────────────────────

/** Orchestrator asks a task agent to scan for yield opportunities */
export interface ScanRequest extends BaseMessage {
  type:        "SCAN_REQUEST";
  riskProfile: RiskProfile;
  protocols:   string[];         // e.g. ["uniswap-v3", "aave"]
  minTvlUsd:   number;
  maxResults:  number;
}

/** Orchestrator tells a task agent to execute a rebalance */
export interface ExecuteCommand extends BaseMessage {
  type:        "EXECUTE_COMMAND";
  opportunity: YieldOpportunity;
  slippageBps: number;
}

// ── Task Agents → Orchestrator ────────────────────────────────────────────

/** Task agent returns discovered yield opportunities */
export interface ScanResult extends BaseMessage {
  type:          "SCAN_RESULT";
  opportunities: YieldOpportunity[];
  protocol:      string;
  scanDurationMs: number;
}

/** Task agent confirms execution */
export interface ExecuteResult extends BaseMessage {
  type:    "EXECUTE_RESULT";
  txHash?: string;
  success: boolean;
  error?:  string;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

export interface Heartbeat extends BaseMessage {
  type:   "HEARTBEAT";
  status: "alive" | "busy" | "error";
}

export interface AgentReady extends BaseMessage {
  type:      "AGENT_READY";
  agentId:   string;
  publicKey: string;
  protocols: string[];
}

export type AXLPayload =
  | ScanRequest
  | ScanResult
  | ExecuteCommand
  | ExecuteResult
  | Heartbeat
  | AgentReady;
