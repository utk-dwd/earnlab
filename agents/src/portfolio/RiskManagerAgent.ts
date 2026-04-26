import { randomUUID } from "crypto";
import { AXLClient } from "../integrations/axl/AXLClient";
import type {
  YieldOpportunityMsg, RiskChallenge, PerfResponse, RiskAssessment, PerfRequest,
} from "./messages";

const RATING_INTERVAL_MS = 90_000;
const PERF_WINDOW_MS = 12_000;

// Risk thresholds
const APY_SUSPICIOUS = 2.0;  // >200% APY is highly suspicious
const APY_HIGH       = 0.5;  // >50% APY is elevated risk
const TVL_LOW        = 1_000_000;   // <$1M TVL is risky
const TVL_VERY_LOW   = 200_000;     // <$200K TVL is very risky

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface PendingRound {
  responses: PerfResponse[];
  deadline: number;
}

export class RiskManagerAgent {
  private axl: AXLClient;
  private pendingRounds = new Map<string, PendingRound>();
  private challengeHistory: RiskChallenge[] = [];

  constructor(private readonly port = 9007) {
    this.axl = new AXLClient(port);
  }

  async start(): Promise<void> {
    console.log("[RiskManager] Starting...");
    await this.axl.waitForNode();
    await this.axl.init();
    console.log(`[RiskManager] AXL key: ${this.axl.publicKey}`);
    console.log("[RiskManager] Goal: maximise risk-adjusted return — challenge every opportunity");

    this.axl.startPolling(this.handleMessage.bind(this), 400);
    this.ratingLoop();
  }

  // ── Risk assessment ────────────────────────────────────────────────────────
  private assessRisk(opp: YieldOpportunityMsg): RiskChallenge {
    let riskScore = 15; // baseline
    const reasons: string[] = [];

    // APY-based risk
    if (opp.apy > APY_SUSPICIOUS) {
      riskScore += 40;
      reasons.push(`APY ${(opp.apy * 100).toFixed(0)}% is implausibly high (>200%)`);
    } else if (opp.apy > APY_HIGH) {
      riskScore += 20;
      reasons.push(`APY ${(opp.apy * 100).toFixed(0)}% is elevated (>50%)`);
    } else if (opp.apy > 0.20) {
      riskScore += 8;
    }

    // TVL-based risk (low TVL = illiquid = higher risk)
    if (opp.tvl < TVL_VERY_LOW) {
      riskScore += 30;
      reasons.push(`TVL $${(opp.tvl / 1e3).toFixed(0)}K is dangerously low`);
    } else if (opp.tvl < TVL_LOW) {
      riskScore += 15;
      reasons.push(`TVL $${(opp.tvl / 1e6).toFixed(2)}M is below $1M threshold`);
    }

    // Protocol risk bonus for known protocols
    const knownProtocols = ["uniswap-v3", "curve", "aave-v3", "compound", "balancer"];
    if (!knownProtocols.includes(opp.protocol)) {
      riskScore += 10;
      reasons.push(`Unknown protocol: ${opp.protocol}`);
    }

    riskScore = Math.min(100, riskScore);

    // Sharpe estimate: return / (risk/100) — higher risk deflates the score
    const sharpeEstimate = opp.apy / Math.max(0.1, riskScore / 100);

    // Max safe allocation decreases linearly with risk
    // riskScore=0 → 30%, riskScore=100 → 5%
    const maxAllocation = Math.max(0.05, MAX_POSITION * (1 - (riskScore / 100) * 0.83));
    const approved = riskScore < 65;

    const reasoning = reasons.length
      ? reasons.join("; ")
      : `Clean profile (score=${riskScore}, TVL $${(opp.tvl / 1e6).toFixed(1)}M)`;

    return {
      type: "RISK_CHALLENGE",
      riskManagerKey: this.axl.publicKey,
      opportunityId: opp.opportunityId,
      riskScore,
      sharpeEstimate,
      approved,
      maxAllocation,
      reasoning,
    };
  }

  // ── Rating cycle (Convergecast-style over stable private mesh) ─────────────
  private async ratingLoop(): Promise<void> {
    await sleep(40_000); // let other agents produce data first
    while (true) {
      try { await this.runRatingCycle(); } catch (e) { console.error("[RiskManager] Cycle error:", e); }
      await sleep(RATING_INTERVAL_MS);
    }
  }

  private async runRatingCycle(): Promise<void> {
    const topo = await this.axl.topology();
    const peers = topo.peers.filter(p => p.up);
    if (!peers.length) { console.log("[RiskManager] No peers yet"); return; }

    const requestId = randomUUID();
    const epoch = Date.now();
    this.pendingRounds.set(requestId, { responses: [], deadline: epoch + PERF_WINDOW_MS });

    console.log(`[RiskManager] ↗ PERF_REQUEST → ${peers.length} peers (${PERF_WINDOW_MS / 1000}s window)`);

    await Promise.allSettled(
      peers.map(p =>
        this.axl.send(p.public_key, {
          type: "PERF_REQUEST",
          riskManagerKey: this.axl.publicKey,
          requestId,
          epoch,
        } as PerfRequest)
      )
    );

    await sleep(PERF_WINDOW_MS);

    const round = this.pendingRounds.get(requestId);
    this.pendingRounds.delete(requestId);
    if (!round?.responses.length) { console.log("[RiskManager] No responses this cycle"); return; }

    const assessments = round.responses.map(r => ({
      agentKey: r.fromKey,
      role: r.agentRole,
      score: this.computeScore(r),
      details: this.buildDetails(r),
    }));

    const assessment: RiskAssessment = {
      type: "RISK_ASSESSMENT",
      riskManagerKey: this.axl.publicKey,
      epoch,
      assessments,
    };

    await Promise.allSettled(peers.map(p => this.axl.send(p.public_key, assessment)));

    console.log(`[RiskManager] ✓ Risk assessments published (${assessments.length} agents):`);
    for (const a of assessments) {
      console.log(`  ${a.role.padEnd(18)} ${a.agentKey.slice(0, 16)}...  score: ${a.score.toFixed(2)}/10`);
      for (const [k, v] of Object.entries(a.details)) {
        if (v !== 0) console.log(`    ${k}: ${typeof v === "number" && v < 10 ? v.toFixed(3) : v}`);
      }
    }

    // Self-summary: show challenge history
    const approved = this.challengeHistory.filter(c => c.approved).length;
    const total = this.challengeHistory.length;
    console.log(`[RiskManager] Challenge history: ${approved}/${total} approved (${total ? ((approved / total) * 100).toFixed(0) : 0}% approval rate)`);
  }

  private computeScore(r: PerfResponse): number {
    if (r.agentRole === "portfolio-manager") {
      let s = 5;
      s += Math.min(2, (r.positionCount ?? 0) / 3);           // diversification
      s += (r.maxPosition ?? 1) <= 0.31 ? 2 : -2;             // respecting 30% cap
      s += Math.min(1, (r.approvalRate ?? 0) * 2);            // sensible approval rate
      return +Math.min(10, Math.max(0, s)).toFixed(2);
    } else { // yield-hunter
      let s = 4;
      s += Math.min(3, (r.opportunitiesFound ?? 0) / 5);      // activity
      s += Math.min(2, (r.bestApy ?? 0) * 5);                 // finding high yield
      s += (r.avgApy ?? 0) > 0.05 ? 1 : 0;                   // consistent yield discovery
      return +Math.min(10, Math.max(0, s)).toFixed(2);
    }
  }

  private buildDetails(r: PerfResponse): Record<string, number> {
    if (r.agentRole === "portfolio-manager") {
      return {
        positions:    r.positionCount   ?? 0,
        maxPosition:  r.maxPosition     ?? 0,
        approvalRate: r.approvalRate    ?? 0,
      };
    }
    return {
      found:   r.opportunitiesFound ?? 0,
      avgApy:  r.avgApy ?? 0,
      bestApy: r.bestApy ?? 0,
    };
  }

  // ── Message dispatch ───────────────────────────────────────────────────────
  private async handleMessage(raw: any, body: any): Promise<void> {
    switch (body?.type) {
      case "YIELD_OPPORTUNITY": {
        const opp = body as YieldOpportunityMsg;
        const challenge = this.assessRisk(opp);
        this.challengeHistory.push(challenge);

        console.log(
          `[RiskManager] CHALLENGE ${opp.tokenA}/${opp.tokenB} on ${opp.protocol}: ` +
          `APY ${(opp.apy * 100).toFixed(1)}%  TVL $${(opp.tvl / 1e6).toFixed(1)}M  ` +
          `→ riskScore=${challenge.riskScore}  Sharpe≈${challenge.sharpeEstimate.toFixed(2)}  ` +
          `${challenge.approved ? "✓ APPROVED" : "✗ REJECTED"}` +
          (challenge.approved ? `  maxAlloc=${(challenge.maxAllocation * 100).toFixed(0)}%` : "") +
          (challenge.reasoning !== `Clean profile (score=${challenge.riskScore}, TVL $${(opp.tvl / 1e6).toFixed(1)}M)` ? `\n  ↳ ${challenge.reasoning}` : "")
        );

        // Broadcast challenge to all peers (PortfolioManager picks it up)
        const topo = await this.axl.topology();
        await Promise.allSettled(
          topo.peers.filter(p => p.up).map(p => this.axl.send(p.public_key, challenge))
        );
        break;
      }

      case "PERF_RESPONSE": {
        const resp = body as PerfResponse;
        const round = this.pendingRounds.get(resp.requestId);
        if (round && Date.now() < round.deadline) round.responses.push(resp);
        break;
      }

      case "ALLOCATION_DECISION":
        console.log(
          `[RiskManager] ← PortfolioManager ${body.approved ? "✓" : "✗"} ${body.opportunityId.slice(0, 8)}...: ` +
          `${body.reasoning}`
        );
        break;

      case "PORTFOLIO_SNAPSHOT":
        if (body.maxPosition > MAX_POSITION + 0.001) {
          console.warn(`[RiskManager] ⚠ Portfolio max position ${(body.maxPosition * 100).toFixed(1)}% EXCEEDS 30% cap!`);
        }
        break;
    }
  }
}

const MAX_POSITION = 0.30; // mirror of PortfolioManagerAgent constant — RiskManager is aware
