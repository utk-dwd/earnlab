/**
 * AgentMetadataBuilder — constructs the encrypted agent state bundle that is
 * stored on 0G Storage and referenced by the INFT `storageUri`.
 *
 * The bundle captures everything needed to reproduce or audit the strategy:
 *   - Strategy config and risk parameters
 *   - Current scorecard regime weights
 *   - Portfolio performance snapshot
 *   - LLM model config
 *   - Hook-analysis preferences and blacklists
 *   - A summary of recent 0G memory decisions
 *
 * In a full ERC-7857 implementation this bundle would be TEE-encrypted and
 * re-encrypted on transfer.  For the testnet demo the JSON is stored in
 * plaintext on 0G Storage — encryption is marked as a Phase 6 upgrade.
 */

import type { PortfolioSummary } from "../PortfolioManager";
import { getModel } from "../llm/LLMConfig";

// ─── Strategy archetypes ──────────────────────────────────────────────────────

export type AgentStrategyType =
  | "conservative-stable"
  | "eth-usdc-harvest"
  | "hook-aware-aggressive"
  | "testnet-research";

export const STRATEGY_PRESETS: Record<AgentStrategyType, {
  label:       string;
  riskProfile: "low" | "moderate" | "high";
  description: string;
  weights: {
    yield:     number;
    il:        number;
    liquidity: number;
    tokenRisk: number;
    hookRisk:  number;
  };
  permissions: {
    canExecute:       boolean;
    requiresHITL:     boolean;
    maxAllocationPct: number;
  };
}> = {
  "conservative-stable": {
    label:       "Conservative Stablecoin LP Agent",
    riskProfile: "low",
    description: "Only stablecoin pools. IL-first scoring. Tight risk budget.",
    weights: { yield: 0.09, il: 0.28, liquidity: 0.14, tokenRisk: 0.14, hookRisk: 0.08 },
    permissions: { canExecute: false, requiresHITL: true,  maxAllocationPct: 10 },
  },
  "eth-usdc-harvest": {
    label:       "ETH/USDC Volatility Harvest Agent",
    riskProfile: "moderate",
    description: "ETH-denominated pairs with high fee capture. Balanced scoring.",
    weights: { yield: 0.22, il: 0.18, liquidity: 0.13, tokenRisk: 0.09, hookRisk: 0.12 },
    permissions: { canExecute: false, requiresHITL: true,  maxAllocationPct: 25 },
  },
  "hook-aware-aggressive": {
    label:       "Hook-Aware High-Risk Agent",
    riskProfile: "high",
    description: "Targets v4 hooked pools with dynamic fees and auto-compound. High yield focus.",
    weights: { yield: 0.32, il: 0.09, liquidity: 0.13, tokenRisk: 0.07, hookRisk: 0.10 },
    permissions: { canExecute: false, requiresHITL: true,  maxAllocationPct: 30 },
  },
  "testnet-research": {
    label:       "Testnet Research Agent",
    riskProfile: "low",
    description: "Paper-trades testnet pools for strategy development and backtesting.",
    weights: { yield: 0.22, il: 0.18, liquidity: 0.13, tokenRisk: 0.09, hookRisk: 0.12 },
    permissions: { canExecute: true,  requiresHITL: false, maxAllocationPct: 50 },
  },
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentPerformanceStats {
  totalTrades:    number;
  openPositions:  number;
  totalPnlUsd:    number;
  totalFeesUsd:   number;
  avgAPY:         number;
  regime:         string;
}

export interface AgentINFTMetadata {
  schemaVersion:    "1.0";
  name:             string;
  strategyType:     AgentStrategyType;
  riskProfile:      "low" | "moderate" | "high";
  description:      string;
  modelConfig:      string;
  scorecardWeights: Record<string, number>;
  performance:      AgentPerformanceStats;
  permissions: {
    canExecute:       boolean;
    requiresHITL:     boolean;
    maxAllocationPct: number;
  };
  hookPreferences: {
    maxRiskScore:   number;  // reject pools where hookRisk > this
    preferAutoComp: boolean; // prefer auto-compound hooks
  };
  snapshotAt:   number;  // unix ms
  note:         string;
}

// ─── Builder ──────────────────────────────────────────────────────────────────

export function buildAgentMetadata(
  strategyType:  AgentStrategyType,
  summary:       PortfolioSummary,
): AgentINFTMetadata {
  const preset = STRATEGY_PRESETS[strategyType];
  const openPositions = summary.openPositions;

  const performance: AgentPerformanceStats = {
    totalTrades:   summary.tradeCount,
    openPositions,
    totalPnlUsd:   +(summary.unrealizedPnlUsd + summary.realizedPnlUsd).toFixed(2),
    totalFeesUsd:  +summary.totalEarnedFeesUsd.toFixed(2),
    avgAPY:        openPositions > 0
      ? +(summary.totalEarnedFeesUsd / (summary.investedUsd || 1) * 365 * 100).toFixed(1)
      : 0,
    regime: summary.regime,
  };

  return {
    schemaVersion:    "1.0",
    name:             preset.label,
    strategyType,
    riskProfile:      preset.riskProfile,
    description:      preset.description,
    modelConfig:      getModel(),
    scorecardWeights: preset.weights,
    performance,
    permissions:      preset.permissions,
    hookPreferences: {
      maxRiskScore:   strategyType === "conservative-stable" ? 25
                    : strategyType === "hook-aware-aggressive" ? 84
                    : 50,
      preferAutoComp: strategyType === "hook-aware-aggressive",
    },
    snapshotAt: Date.now(),
    note:       "Stored on 0G Storage. Full ERC-7857 TEE encryption planned for Phase 6.",
  };
}
