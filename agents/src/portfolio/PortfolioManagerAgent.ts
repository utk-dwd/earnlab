import { AXLClient } from "../integrations/axl/AXLClient";
import type {
  YieldOpportunityMsg, RiskChallenge, AllocationDecision,
  PortfolioSnapshot, PerfRequest,
} from "./messages";

const MAX_POSITION = 0.30;          // 30% cap — hard rule
const RISK_WINDOW_MS = 10_000;      // wait up to 10s for a RiskManager challenge
const SNAPSHOT_INTERVAL_MS = 90_000;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Position {
  id: string;           // poolAddress
  protocol: string;
  tokenA: string;
  tokenB: string;
  allocation: number;   // fraction of portfolio
  apy: number;
  since: number;
}

interface PendingOpportunity {
  msg: YieldOpportunityMsg;
  challenge?: RiskChallenge;
  receivedAt: number;
}

export class PortfolioManagerAgent {
  private axl: AXLClient;

  // Portfolio state — no position may exceed MAX_POSITION (30%)
  private positions = new Map<string, Position>([
    ["0xpool-eth-usdc-30", { id: "0xpool-eth-usdc-30", protocol: "uniswap-v3", tokenA: "ETH", tokenB: "USDC", allocation: 0.20, apy: 0.08, since: Date.now() }],
    ["0xpool-eth-dai-30",  { id: "0xpool-eth-dai-30",  protocol: "uniswap-v3", tokenA: "ETH", tokenB: "DAI",  allocation: 0.15, apy: 0.07, since: Date.now() }],
    ["0xpool-usdc-dai-5",  { id: "0xpool-usdc-dai-5",  protocol: "uniswap-v3", tokenA: "USDC", tokenB: "DAI", allocation: 0.20, apy: 0.04, since: Date.now() }],
    ["cash-usdc",          { id: "cash-usdc",          protocol: "cash",       tokenA: "USDC", tokenB: "",    allocation: 0.25, apy: 0.05, since: Date.now() }],
    ["cash-dai",           { id: "cash-dai",           protocol: "cash",       tokenA: "DAI",  tokenB: "",    allocation: 0.20, apy: 0.04, since: Date.now() }],
  ]);

  private pending = new Map<string, PendingOpportunity>();
  private approvalCount = 0;
  private totalDecisions = 0;

  constructor(private readonly port = 9005) {
    this.axl = new AXLClient(port);
  }

  async start(): Promise<void> {
    console.log("[PortfolioManager] Starting...");
    await this.axl.waitForNode();
    await this.axl.init();
    console.log(`[PortfolioManager] AXL key: ${this.axl.publicKey}`);
    console.log(`[PortfolioManager] Rule: no single position > ${MAX_POSITION * 100}% of portfolio`);
    this.logPortfolio();

    this.axl.startPolling(this.handleMessage.bind(this), 400);
    this.snapshotLoop();
  }

  // ── Snapshot broadcast ─────────────────────────────────────────────────────
  private async snapshotLoop(): Promise<void> {
    await sleep(10_000);
    while (true) {
      await this.broadcastSnapshot();
      await sleep(SNAPSHOT_INTERVAL_MS);
    }
  }

  private async broadcastSnapshot(): Promise<void> {
    const positions = [...this.positions.values()]
      .sort((a, b) => b.allocation - a.allocation)
      .map(p => ({ id: p.id, allocation: p.allocation }));
    const utilisation = positions.reduce((s, p) => s + p.allocation, 0);

    const snap: PortfolioSnapshot = {
      type: "PORTFOLIO_SNAPSHOT",
      portfolioManagerKey: this.axl.publicKey,
      positions,
      maxPosition: MAX_POSITION,
      utilisation,
      timestamp: Date.now(),
    };
    await this.broadcastAll(snap);
    console.log(`[PortfolioManager] ↗ Portfolio snapshot: ${positions.length} positions, ${(utilisation * 100).toFixed(1)}% utilised`);
  }

  // ── Message dispatch ───────────────────────────────────────────────────────
  private async handleMessage(_raw: any, body: any): Promise<void> {
    switch (body?.type) {
      case "YIELD_OPPORTUNITY":
        await this.onYieldOpportunity(body as YieldOpportunityMsg);
        break;
      case "RISK_CHALLENGE":
        this.onRiskChallenge(body as RiskChallenge);
        break;
      case "PERF_REQUEST":
        await this.onPerfRequest(body as PerfRequest);
        break;
      case "RISK_ASSESSMENT":
        console.log(`[PortfolioManager] ← RiskManager assessment received`);
        break;
    }
  }

  // ── Opportunity handling ───────────────────────────────────────────────────
  private async onYieldOpportunity(msg: YieldOpportunityMsg): Promise<void> {
    if (this.pending.has(msg.opportunityId)) return; // dedup

    console.log(
      `[PortfolioManager] ← YIELD_OPPORTUNITY: ${msg.tokenA}/${msg.tokenB} ` +
      `on ${msg.protocol} — APY ${(msg.apy * 100).toFixed(1)}%, TVL $${(msg.tvl / 1e6).toFixed(1)}M`
    );

    this.pending.set(msg.opportunityId, { msg, receivedAt: Date.now() });

    // Wait for RiskManager challenge window before deciding
    await sleep(RISK_WINDOW_MS);
    await this.decide(msg.opportunityId);
  }

  private onRiskChallenge(challenge: RiskChallenge): void {
    const entry = this.pending.get(challenge.opportunityId);
    if (entry) {
      entry.challenge = challenge;
      console.log(
        `[PortfolioManager] ← RISK_CHALLENGE: ${challenge.approved ? "approved" : "REJECTED"} ` +
        `(score=${challenge.riskScore}, Sharpe≈${challenge.sharpeEstimate.toFixed(2)}, ` +
        `maxAlloc=${(challenge.maxAllocation * 100).toFixed(0)}%)`
      );
    }
  }

  private async decide(opportunityId: string): Promise<void> {
    const entry = this.pending.get(opportunityId);
    if (!entry) return;
    this.pending.delete(opportunityId);

    const { msg, challenge } = entry;
    this.totalDecisions++;

    const riskApproved = challenge ? challenge.approved : true; // no challenge = assume ok
    const riskMaxAlloc = challenge ? challenge.maxAllocation : MAX_POSITION;

    // If RiskManager rejected, we decline
    if (!riskApproved) {
      await this.emitDecision({
        approved: false,
        msg,
        actualAllocation: 0,
        requestedAllocation: MAX_POSITION,
        cappedBy30pct: false,
        riskApproved: false,
        reasoning: `RiskManager rejected (score=${challenge?.riskScore}, ${challenge?.reasoning})`,
      });
      return;
    }

    // Apply 30% diversification cap — the hard rule
    const alreadyInProtocol = this.getProtocolAllocation(msg.protocol);
    const available = Math.max(0, MAX_POSITION - alreadyInProtocol);
    const requested = Math.min(riskMaxAlloc, MAX_POSITION);
    const actual = Math.min(requested, available);
    const cappedBy30pct = actual < requested;

    if (actual < 0.01) {
      await this.emitDecision({
        approved: false,
        msg,
        actualAllocation: 0,
        requestedAllocation: requested,
        cappedBy30pct: true,
        riskApproved: true,
        reasoning: `Already at 30% cap in ${msg.protocol} (${(alreadyInProtocol * 100).toFixed(1)}% allocated)`,
      });
      return;
    }

    // Execute — reduce lowest-yield position to make room if needed
    await this.rebalanceIn(msg, actual);
    this.approvalCount++;

    await this.emitDecision({
      approved: true,
      msg,
      actualAllocation: actual,
      requestedAllocation: requested,
      cappedBy30pct,
      riskApproved: true,
      reasoning: cappedBy30pct
        ? `Allocated ${(actual * 100).toFixed(1)}% (30% cap applied, protocol already at ${(alreadyInProtocol * 100).toFixed(1)}%)`
        : `Allocated ${(actual * 100).toFixed(1)}% of portfolio`,
    });
  }

  // ── Portfolio rebalancing ──────────────────────────────────────────────────
  private async rebalanceIn(opp: YieldOpportunityMsg, targetAlloc: number): Promise<void> {
    // Find the lowest-yield position to trim (excluding the new one)
    const sorted = [...this.positions.values()].sort((a, b) => a.apy - b.apy);
    let remaining = targetAlloc;

    for (const pos of sorted) {
      if (remaining <= 0) break;
      const trim = Math.min(pos.allocation, remaining);
      pos.allocation -= trim;
      remaining -= trim;
      if (pos.allocation < 0.005) this.positions.delete(pos.id);
    }

    // Add / top-up the new position
    const existing = this.positions.get(opp.poolAddress);
    if (existing) {
      existing.allocation = Math.min(MAX_POSITION, existing.allocation + targetAlloc);
      existing.apy = opp.apy;
    } else {
      this.positions.set(opp.poolAddress, {
        id: opp.poolAddress,
        protocol: opp.protocol,
        tokenA: opp.tokenA,
        tokenB: opp.tokenB,
        allocation: targetAlloc,
        apy: opp.apy,
        since: Date.now(),
      });
    }

    this.logPortfolio();
  }

  private getProtocolAllocation(protocol: string): number {
    return [...this.positions.values()]
      .filter(p => p.protocol === protocol)
      .reduce((s, p) => s + p.allocation, 0);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  private async emitDecision(params: {
    approved: boolean; msg: YieldOpportunityMsg;
    actualAllocation: number; requestedAllocation: number;
    cappedBy30pct: boolean; riskApproved: boolean; reasoning: string;
  }): Promise<void> {
    const decision: AllocationDecision = {
      type: "ALLOCATION_DECISION",
      portfolioManagerKey: this.axl.publicKey,
      opportunityId: params.msg.opportunityId,
      approved: params.approved,
      requestedAllocation: params.requestedAllocation,
      actualAllocation: params.actualAllocation,
      cappedBy30pct: params.cappedBy30pct,
      riskApproved: params.riskApproved,
      reasoning: params.reasoning,
    };

    await this.broadcastAll(decision);
    console.log(
      `[PortfolioManager] ${params.approved ? "✓" : "✗"} ${params.msg.tokenA}/${params.msg.tokenB} ` +
      `on ${params.msg.protocol}: ${params.reasoning}`
    );
  }

  private logPortfolio(): void {
    const positions = [...this.positions.values()].sort((a, b) => b.allocation - a.allocation);
    const total = positions.reduce((s, p) => s + p.allocation, 0);
    console.log(`[PortfolioManager] Portfolio (${(total * 100).toFixed(1)}% allocated):`);
    for (const p of positions) {
      const bar = "█".repeat(Math.round(p.allocation * 30));
      console.log(
        `  ${(p.allocation * 100).toFixed(1).padStart(4)}%  ${bar.padEnd(9)}  ` +
        `${p.tokenA}/${p.tokenB} (${p.protocol}) @ ${(p.apy * 100).toFixed(1)}% APY`
      );
    }
  }

  private async onPerfRequest(msg: PerfRequest): Promise<void> {
    const positions = [...this.positions.values()];
    const avgAlloc = positions.length
      ? positions.reduce((s, p) => s + p.allocation, 0) / positions.length
      : 0;
    const maxPos = positions.length ? Math.max(...positions.map(p => p.allocation)) : 0;

    await this.axl.send(msg.riskManagerKey, {
      type: "PERF_RESPONSE",
      fromKey: this.axl.publicKey,
      requestId: msg.requestId,
      agentRole: "portfolio-manager",
      positionCount: positions.length,
      avgAllocation: avgAlloc,
      maxPosition: maxPos,
      approvalRate: this.totalDecisions ? this.approvalCount / this.totalDecisions : 0,
    });
    console.log(`[PortfolioManager] → PERF_RESPONSE to RiskManager`);
  }

  private async broadcastAll(msg: object): Promise<void> {
    const topo = await this.axl.topology();
    await Promise.allSettled(
      topo.peers.filter(p => p.up).map(p => this.axl.send(p.public_key, msg))
    );
  }
}
