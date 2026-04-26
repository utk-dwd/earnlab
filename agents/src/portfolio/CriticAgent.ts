import { randomUUID } from "crypto";
import { AXLClient } from "../integrations/axl/AXLClient";
import type { PerfResponse } from "./messages";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface PendingRound {
  responses: PerfResponse[];
  deadline: number;
}

export class CriticAgent {
  private axl: AXLClient;
  private pendingRounds = new Map<string, PendingRound>();

  constructor(private readonly port = 9007) {
    this.axl = new AXLClient(port);
  }

  async start(): Promise<void> {
    console.log("[Critic] Starting...");
    await this.axl.waitForNode();
    await this.axl.init();
    console.log(`[Critic] AXL key: ${this.axl.publicKey}`);
    console.log("[Critic] Observing network, rating cycle every 90s...");

    this.axl.startPolling(this.handleMessage.bind(this), 400);
    this.ratingLoop();
  }

  // ── Rating loop ────────────────────────────────────────────────────────────
  private async ratingLoop(): Promise<void> {
    await sleep(35_000); // let agents produce data first
    while (true) {
      try { await this.runRatingCycle(); } catch (e) { console.error("[Critic] Cycle error:", e); }
      await sleep(90_000);
    }
  }

  private async runRatingCycle(): Promise<void> {
    const topo = await this.axl.topology();
    const peers = topo.peers.filter(p => p.up);

    if (!peers.length) {
      console.log("[Critic] No peers in mesh yet");
      return;
    }

    const requestId = randomUUID();
    const epoch = Date.now();
    const deadline = epoch + 12_000; // 12s collection window

    console.log(`[Critic] ↗ PERF_REQUEST → ${peers.length} peers (epoch ${epoch}, window 12s)`);

    this.pendingRounds.set(requestId, { responses: [], deadline });

    // Fan out PERF_REQUEST to all peers (private mesh — topology is stable)
    await Promise.allSettled(
      peers.map(p =>
        this.axl.send(p.public_key, {
          type: "PERF_REQUEST",
          criticKey: this.axl.publicKey,
          requestId,
          epoch,
        })
      )
    );

    // Wait for collection window
    await sleep(12_000);

    const round = this.pendingRounds.get(requestId);
    this.pendingRounds.delete(requestId);

    if (!round?.responses.length) {
      console.log("[Critic] No PERF_RESPONSE received this cycle");
      return;
    }

    // Compute ratings
    const ratings = round.responses.map(r => ({
      agentKey: r.fromKey,
      role: r.agentRole,
      score: this.computeScore(r),
      details: {
        decisions:         r.decisions         ?? 0,
        avgReturn:         +(r.avgReturn        ?? 0).toFixed(4),
        winRate:           +(r.winRate          ?? 0).toFixed(4),
        subscriptions:     r.subscriptions      ?? 0,
        observedDecisions: r.observedDecisions  ?? 0,
      },
    }));

    // Broadcast ratings back to all peers
    await Promise.allSettled(
      peers.map(p =>
        this.axl.send(p.public_key, {
          type: "STRATEGY_RATING",
          criticKey: this.axl.publicKey,
          epoch,
          ratings,
        })
      )
    );

    console.log(`[Critic] ✓ Published ratings for ${ratings.length} agents:`);
    for (const r of ratings) {
      console.log(
        `  ${r.role.padEnd(8)} ${r.agentKey.slice(0, 16)}...  score: ${r.score.toFixed(2)}/10` +
        (r.details.decisions  ? `  decisions: ${r.details.decisions}`  : "") +
        (r.details.avgReturn  ? `  avgAPY: ${(r.details.avgReturn * 100).toFixed(1)}%` : "") +
        (r.details.subscriptions ? `  subs: ${r.details.subscriptions}` : "")
      );
    }
  }

  // Score 0–10: weighted combination of return, win rate, activity
  private computeScore(r: PerfResponse): number {
    let score = 4; // baseline
    if (r.agentRole === "executor") {
      score += Math.min(3, (r.avgReturn ?? 0) * 25);   // up to +3 for high returns
      score += (r.winRate ?? 0) * 2;                    // up to +2 for win rate
      score += Math.min(1, (r.decisions ?? 0) / 5);    // up to +1 for track record
    } else if (r.agentRole === "seeker") {
      score += Math.min(3, (r.subscriptions ?? 0));     // up to +3 for subscriptions
      score += Math.min(2, (r.observedDecisions ?? 0) / 3); // up to +2 for activity
      score += Math.min(1, (r.avgReturn ?? 0) * 10);   // up to +1 for returns seen
    }
    return +Math.min(10, Math.max(0, score)).toFixed(2);
  }

  // ── Message dispatch ───────────────────────────────────────────────────────
  private async handleMessage(_raw: any, body: any): Promise<void> {
    switch (body?.type) {
      case "PERF_RESPONSE": {
        const resp = body as PerfResponse;
        const round = this.pendingRounds.get(resp.requestId);
        if (round && Date.now() < round.deadline) {
          round.responses.push(resp);
          console.log(`[Critic] ← PERF_RESPONSE from ${resp.agentRole} (${resp.fromKey.slice(0, 16)}...)`);
        }
        break;
      }
      case "STRATEGY_AVAILABLE":
        console.log(`[Critic] ↙ Strategy observed: ${body.strategyId} (${body.riskLevel}, ${body.trackRecordLength} decisions)`);
        break;
      case "DECISION_MADE":
        console.log(`[Critic] ↙ Decision: ${body.action} (APY est. ${(body.expectedReturn * 100).toFixed(1)}%)`);
        break;
      case "SUBSCRIPTION_CONFIRMED":
        console.log(`[Critic] ↙ Subscription: ${body.strategyId} → job ${body.jobId}`);
        break;
    }
  }
}
