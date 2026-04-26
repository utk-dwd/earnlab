import { randomUUID } from "crypto";
import { AXLClient } from "../integrations/axl/AXLClient";
import { ZeroGStorage } from "./ZeroGStorage";
import { X402Client } from "./X402Client";
import type {
  StrategyAvailable, TrackRecordResponse, SubscriptionConfirmed,
  DecisionMade, PerfRequest, Decision,
} from "./messages";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface PendingQuery {
  executorKey: string;
  strategyId: string;
  sentAt: number;
}

export class SeekerAgent {
  private axl: AXLClient;
  private storage = new ZeroGStorage();
  private x402 = new X402Client();

  private riskProfile: "low" | "moderate" = "moderate";
  private subscriptions = new Map<string, string>(); // strategyId → jobId
  private pendingQueries = new Map<string, PendingQuery>(); // requestId → query
  private observedDecisions: DecisionMade[] = [];

  constructor(private readonly port = 9006) {
    this.axl = new AXLClient(port);
  }

  async start(): Promise<void> {
    console.log("[Seeker] Starting...");
    await this.axl.waitForNode();
    await this.axl.init();
    console.log(`[Seeker] AXL key: ${this.axl.publicKey}`);
    console.log(`[Seeker] Risk profile: ${this.riskProfile} — listening for strategies...`);

    this.axl.startPolling(this.handleMessage.bind(this), 400);
  }

  // ── Message dispatch ───────────────────────────────────────────────────────
  private async handleMessage(raw: any, body: any): Promise<void> {
    switch (body?.type) {
      case "STRATEGY_AVAILABLE":
        await this.onStrategyAvailable(raw.from, body as StrategyAvailable);
        break;
      case "TRACK_RECORD_RESPONSE":
        await this.onTrackRecordResponse(raw.from, body as TrackRecordResponse);
        break;
      case "SUBSCRIPTION_CONFIRMED":
        await this.onSubscriptionConfirmed(body as SubscriptionConfirmed);
        break;
      case "DECISION_MADE":
        this.observedDecisions.push(body as DecisionMade);
        console.log(
          `[Seeker] ↙ Observed decision: ${body.action} ` +
          `(APY ${(body.expectedReturn * 100).toFixed(1)}%, proof: ${body.proofCid.slice(0, 16)}...)`
        );
        break;
      case "PERF_REQUEST":
        await this.onPerfRequest(raw.from, body as PerfRequest);
        break;
      case "STRATEGY_RATING":
        console.log(`[Seeker] ← Critic ratings: ${body.ratings.map((r: any) => `${r.role} ${r.score.toFixed(1)}/10`).join(", ")}`);
        break;
    }
  }

  // ── Strategy discovery ─────────────────────────────────────────────────────
  private async onStrategyAvailable(from: string, msg: StrategyAvailable): Promise<void> {
    // Filter by risk profile
    if (this.riskProfile === "low" && msg.riskLevel === "high") {
      console.log(`[Seeker] Skipping high-risk strategy from ${from.slice(0, 16)}...`);
      return;
    }
    if (this.subscriptions.has(msg.strategyId)) return; // already subscribed

    console.log(
      `[Seeker] ← STRATEGY_AVAILABLE: ${msg.strategyId} ` +
      `(${msg.riskLevel}, ${msg.trackRecordLength} decisions, avg APY ${(msg.avgExpectedReturn * 100).toFixed(1)}%)`
    );

    const requestId = randomUUID();
    this.pendingQueries.set(requestId, {
      executorKey: from,
      strategyId: msg.strategyId,
      sentAt: Date.now(),
    });

    await this.axl.send(from, {
      type: "STRATEGY_QUERY",
      fromKey: this.axl.publicKey,
      strategyId: msg.strategyId,
      requestId,
    });
    console.log(`[Seeker] → STRATEGY_QUERY (requestId: ${requestId.slice(0, 8)}...)`);
  }

  // ── x402 payment flow ──────────────────────────────────────────────────────
  private async onTrackRecordResponse(from: string, msg: TrackRecordResponse): Promise<void> {
    const query = this.pendingQueries.get(msg.requestId);
    if (!query) return;

    if (msg.requiresPayment) {
      console.log(`[Seeker] ← 402: ${msg.paymentAmount} ETH required → ${msg.paymentRecipient?.slice(0, 12)}...`);

      const proof = await this.x402.pay(msg.paymentAmount!, msg.paymentRecipient!);
      console.log(`[Seeker] → PAYMENT proof: ${proof.slice(0, 28)}...`);

      await this.axl.send(from, {
        type: "PAYMENT",
        fromKey: this.axl.publicKey,
        requestId: msg.requestId,
        strategyId: query.strategyId,
        amount: msg.paymentAmount,
        proof,
      });
    }
  }

  // ── Subscription + proof verification ─────────────────────────────────────
  private async onSubscriptionConfirmed(msg: SubscriptionConfirmed): Promise<void> {
    const query = this.pendingQueries.get(msg.requestId);
    if (!query) return;

    console.log(`[Seeker] ← SUBSCRIPTION_CONFIRMED (KeeperHub job: ${msg.jobId})`);

    // Verify each decision's proof CID against its data (cross-process, no shared state needed)
    if (msg.decisions?.length) {
      let verified = 0;
      for (const d of msg.decisions) {
        const { proofCid, ...dataToVerify } = d as any;
        const ok = await this.storage.verify(proofCid, dataToVerify);
        if (ok) verified++;
      }
      console.log(`[Seeker] Proof verification: ${verified}/${msg.decisions.length} ✓`);
    }

    this.subscriptions.set(msg.strategyId, msg.jobId);
    this.pendingQueries.delete(msg.requestId);
    console.log(`[Seeker] ✓ Active subscriptions: ${this.subscriptions.size}`);
  }

  // ── Critic cooperation ─────────────────────────────────────────────────────
  private async onPerfRequest(from: string, msg: PerfRequest): Promise<void> {
    const observed = this.observedDecisions;
    const avgReturn = observed.length
      ? observed.reduce((s, d) => s + d.expectedReturn, 0) / observed.length
      : 0;

    await this.axl.send(from, {
      type: "PERF_RESPONSE",
      fromKey: this.axl.publicKey,
      requestId: msg.requestId,
      agentRole: "seeker",
      subscriptions: this.subscriptions.size,
      observedDecisions: observed.length,
      avgReturn,
    });
    console.log(`[Seeker] → PERF_RESPONSE to critic`);
  }
}
