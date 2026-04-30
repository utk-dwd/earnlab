/**
 * AgentAccessControl — gates portfolio execution by INFT ownership.
 *
 * When an agent INFT is configured (INFT_CONTRACT_ADDRESS is set) and a
 * wallet attempts to trigger agent actions, this module checks:
 *
 *   1. Does the calling wallet own or hold authorization for an INFT?
 *   2. Does that INFT's `permissions.canExecute` allow autonomous operation?
 *   3. Does `permissions.requiresHITL` force human-in-the-loop mode?
 *   4. Is the requested allocation within `permissions.maxAllocationPct`?
 *
 * In "demo mode" (no contract address set), all checks pass so the agent
 * operates normally without on-chain gating.
 */

import { inftClient, type OnChainAgentState } from "./INFTContractClient";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AccessCheckResult {
  allowed:        boolean;
  reason:         string;
  requiresHITL:   boolean;
  maxAllocationPct: number;
  agentState?:    OnChainAgentState;
}

// ─── Cache (avoid on-chain call every tick) ───────────────────────────────────

interface CacheEntry { result: AccessCheckResult; ts: number }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;  // 1 minute

// ─── AgentAccessControl ───────────────────────────────────────────────────────

export class AgentAccessControl {
  private contractConfigured = !!process.env.INFT_CONTRACT_ADDRESS;

  /**
   * Check whether `wallet` may execute a portfolio action of `allocationPct` size.
   *
   * If `tokenId` is provided the check is scoped to that specific agent.
   * Otherwise the first owned agent that passes is used.
   */
  async check(
    wallet:        string,
    allocationPct: number,
    tokenId?:      number,
  ): Promise<AccessCheckResult> {
    if (!this.contractConfigured) {
      return {
        allowed:          true,
        reason:           "Demo mode — INFT gating not configured",
        requiresHITL:     false,
        maxAllocationPct: 100,
      };
    }

    const cacheKey = `${wallet}:${tokenId ?? "any"}`;
    const cached   = cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return evaluateAllocation(cached.result, allocationPct);
    }

    try {
      let agentState: OnChainAgentState | null = null;

      if (tokenId !== undefined) {
        const authorized = await inftClient.isAuthorized(tokenId, wallet);
        if (!authorized) {
          return fail(`Wallet ${wallet.slice(0, 8)}… is not authorized for token ${tokenId}`);
        }
        agentState = await inftClient.getAgentState(tokenId);
      } else {
        const owned = await inftClient.getTokensByOwner(wallet);
        if (owned.length === 0) {
          return fail(`Wallet ${wallet.slice(0, 8)}… owns no EarnYld agent INFTs`);
        }
        // Use the first agent that permits execution
        agentState = owned.find(s => s.permissions.canExecute) ?? owned[0];
      }

      if (!agentState) {
        return fail("Agent INFT state not found on chain");
      }

      const result: AccessCheckResult = {
        allowed:          agentState.permissions.canExecute,
        reason:           agentState.permissions.canExecute
          ? `Authorized via INFT #${agentState.tokenId} (${agentState.name})`
          : `INFT #${agentState.tokenId} has canExecute=false — human approval required`,
        requiresHITL:     agentState.permissions.requiresHITL,
        maxAllocationPct: agentState.permissions.maxAllocationPct,
        agentState,
      };

      cache.set(cacheKey, { result, ts: Date.now() });
      return evaluateAllocation(result, allocationPct);
    } catch (err: any) {
      console.warn(`[AgentAccessControl] Check failed: ${err.message}`);
      return {
        allowed:          true,   // fail-open for resilience
        reason:           `Access control check failed (${err.message}) — fail-open`,
        requiresHITL:     true,   // but force HITL as safety measure
        maxAllocationPct: 10,
      };
    }
  }

  invalidateCache(wallet: string): void {
    for (const key of cache.keys()) {
      if (key.startsWith(wallet)) cache.delete(key);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fail(reason: string): AccessCheckResult {
  return { allowed: false, reason, requiresHITL: true, maxAllocationPct: 0 };
}

function evaluateAllocation(base: AccessCheckResult, allocationPct: number): AccessCheckResult {
  if (!base.allowed) return base;
  if (allocationPct > base.maxAllocationPct) {
    return {
      ...base,
      allowed: false,
      reason:  `Requested allocation ${allocationPct}% exceeds INFT limit of ${base.maxAllocationPct}%`,
    };
  }
  return base;
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const agentAccessControl = new AgentAccessControl();
