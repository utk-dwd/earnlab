/**
 * HookAnalyzer — classifies Uniswap v4 hook contracts by fee type, incentive
 * model, rebalance behaviour, and smart-contract risk score.
 *
 * Risk score accumulation (0–100):
 *   beforeRemoveLiquidity callback  +30  (can trap capital)
 *   beforeAddLiquidity callback     +15  (can restrict entry)
 *   beforeSwap callback             +10  (dynamic fees, unpredictable)
 *   6+ total callbacks              +15  (high attack surface)
 *   Source not verified             +25  (Sourcify check)
 *   TVL > $500K AND unverified      +10  (unverified high-value hook)
 *   Pool age < 7 days               +15  (insufficient track record)
 *
 * isBlocked when riskScore >= 85.
 */

import { decodeHookFlags } from "../scanner/UniswapV4Scanner";
import type { HookAnalysisResult, HookFeeType, HookIncentiveType, HookRebalanceType } from "../api/types";

export type { HookAnalysisResult, HookFeeType, HookIncentiveType, HookRebalanceType };

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

const sourceCache = new Map<string, { verified: boolean; ts: number }>();

async function checkSourceVerified(hookAddress: string, chainId: number): Promise<boolean> {
  const key    = `${hookAddress.toLowerCase()}_${chainId}`;
  const cached = sourceCache.get(key);
  if (cached && Date.now() - cached.ts < 86_400_000) return cached.verified;
  try {
    const res  = await fetch(
      `https://sourcify.dev/server/check-by-addresses?addresses=${hookAddress}&chainIds=${chainId}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    const data     = await res.json() as Array<{ status?: string }>;
    const verified = data[0]?.status === "perfect" || data[0]?.status === "partial";
    sourceCache.set(key, { verified, ts: Date.now() });
    return verified;
  } catch {
    sourceCache.set(key, { verified: false, ts: Date.now() });
    return false;
  }
}

function classifyFeeType(callbacks: string[]): HookFeeType {
  return callbacks.includes("beforeSwap") ? "dynamic-unknown" : "static";
}

function classifyIncentiveType(callbacks: string[]): HookIncentiveType {
  if (callbacks.includes("afterSwap") || callbacks.includes("afterAddLiquidity"))
    return "hook-native-rewards";
  return "real-fees";
}

function classifyRebalanceType(callbacks: string[]): HookRebalanceType {
  if (callbacks.includes("beforeAddLiquidity") && callbacks.includes("afterAddLiquidity"))
    return "range-rebalance";
  if (callbacks.includes("afterAddLiquidity"))
    return "auto-compound";
  return "none";
}

function computeRiskScore(
  callbacks:      string[],
  sourceVerified: boolean,
  tvlUsd:         number,
  poolAgeDays:    number,
): number {
  let score = 0;
  if (callbacks.includes("beforeRemoveLiquidity")) score += 30;
  if (callbacks.includes("beforeAddLiquidity"))    score += 15;
  if (callbacks.includes("beforeSwap"))            score += 10;
  if (callbacks.length >= 6)                       score += 15;
  if (!sourceVerified)                             score += 25;
  if (tvlUsd > 500_000 && !sourceVerified)         score += 10;
  if (poolAgeDays < 7)                             score += 15;
  return Math.min(100, score);
}

function toRiskLevel(score: number): "low" | "medium" | "high" | "critical" {
  if (score < 25) return "low";
  if (score < 50) return "medium";
  if (score < 85) return "high";
  return "critical";
}

function netAPYMultiplierFor(level: "low" | "medium" | "high" | "critical"): number {
  switch (level) {
    case "low":      return 1.10;
    case "medium":   return 0.95;
    case "high":     return 0.85;
    case "critical": return 0.70;
  }
}

function incentiveHaircutFor(type: HookIncentiveType): number {
  switch (type) {
    case "real-fees":           return 1.00;
    case "hook-native-rewards": return 0.60;
    case "points-airdrop":      return 0.10;
  }
}

const DEFAULT_RESULT: HookAnalysisResult = {
  hookAddress:      ZERO_ADDR,
  callbacks:        [],
  feeType:          "static",
  incentiveType:    "real-fees",
  rebalanceType:    "none",
  riskScore:        0,
  riskLevel:        "low",
  isBlocked:        false,
  sourceVerified:   true,
  netAPYMultiplier: 1.0,
  incentiveHaircut: 1.0,
};

export async function analyzeHook(
  hookAddress: string,
  chainId:     number,
  tvlUsd:      number,
  poolAgeDays: number,
): Promise<HookAnalysisResult> {
  const addr = hookAddress || ZERO_ADDR;
  if (!hookAddress || hookAddress === ZERO_ADDR) {
    return { ...DEFAULT_RESULT, hookAddress: addr };
  }

  const callbacks     = decodeHookFlags(hookAddress);
  const sourceVerified = await checkSourceVerified(hookAddress, chainId);
  const feeType       = classifyFeeType(callbacks);
  const incentiveType = classifyIncentiveType(callbacks);
  const rebalanceType = classifyRebalanceType(callbacks);
  const riskScore     = computeRiskScore(callbacks, sourceVerified, tvlUsd, poolAgeDays);
  const level         = toRiskLevel(riskScore);

  return {
    hookAddress,
    callbacks,
    feeType,
    incentiveType,
    rebalanceType,
    riskScore,
    riskLevel:        level,
    isBlocked:        riskScore >= 85,
    sourceVerified,
    netAPYMultiplier: netAPYMultiplierFor(level),
    incentiveHaircut: incentiveHaircutFor(incentiveType),
  };
}
