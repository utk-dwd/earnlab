import { randomUUID } from "crypto";
import { AXLClient } from "../integrations/axl/AXLClient";
import { ZeroGCompute } from "./ZeroGCompute";
import { ZeroGStorage } from "./ZeroGStorage";
import { KeeperHubClient } from "./KeeperHubClient";
import { X402Client } from "./X402Client";
import type {
  Decision, DecisionMade, StrategyQuery, Payment, PerfRequest,
} from "./messages";

const PAYMENT_AMOUNT = "0.001"; // ETH required for track record access
const WALLET_ADDRESS = "0xExecutorMockWallet";

const MOCK_PRICES = () => ({
  ETH: 2000 + (Math.random() * 300 - 150),
  USDC: 1.0,
  DAI: 1.0 + (Math.random() * 0.003 - 0.0015),
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class ExecutorAgent {
  private axl: AXLClient;
  private compute = new ZeroGCompute();
  private storage = new ZeroGStorage();
  private keeperhub = new KeeperHubClient();
  private x402 = new X402Client();

  private portfolio = { ETH: 0.5, USDC: 0.3, DAI: 0.2 };
  private trackRecord: Decision[] = [];
  private pendingPayments = new Map<string, string>(); // requestId → seekerKey
  private verifiedPayments = new Set<string>();        // requestIds already paid

  constructor(private readonly port = 9005) {
    this.axl = new AXLClient(port);
  }

  async start(): Promise<void> {
    console.log("[Executor] Starting...");
    await this.axl.waitForNode();
    await this.axl.init();
    console.log(`[Executor] AXL key: ${this.axl.publicKey}`);

    this.axl.startPolling(this.handleMessage.bind(this), 400);

    // Run decision and broadcast loops concurrently
    this.decisionLoop();
    this.broadcastLoop();
  }

  // ── Decision loop ──────────────────────────────────────────────────────────
  private async decisionLoop(): Promise<void> {
    await sleep(8_000); // brief startup wait
    while (true) {
      try { await this.makeDecision(); } catch (e) { console.error("[Executor] Decision error:", e); }
      await sleep(30_000);
    }
  }

  private async makeDecision(): Promise<void> {
    const prices = MOCK_PRICES();
    const teeResult = await this.compute.runInference(this.portfolio, prices);

    const decisionData = {
      id: randomUUID(),
      timestamp: Date.now(),
      action: teeResult.action,
      fromAllocation: { ...this.portfolio },
      toAllocation: teeResult.allocation,
      expectedReturn: teeResult.expectedReturn,
      attestation: teeResult.attestation,
    };

    // Store on 0G Storage — CID is the proof
    const proofCid = await this.storage.store(decisionData);
    const decision: Decision = { ...decisionData, proofCid };

    this.trackRecord.push(decision);
    this.portfolio = { ...teeResult.allocation } as any;

    console.log(
      `[Executor] Decision #${this.trackRecord.length}: ${decision.action} ` +
      `(APY est. ${(decision.expectedReturn * 100).toFixed(1)}%, proof: ${proofCid.slice(0, 18)}...)`
    );

    // Broadcast to all mesh peers
    const broadcast: DecisionMade = {
      type: "DECISION_MADE",
      timestamp: decision.timestamp,
      action: decision.action,
      allocation: decision.toAllocation,
      expectedReturn: decision.expectedReturn,
      proofCid,
      attestation: decision.attestation,
    };
    await this.broadcastAll(broadcast);
  }

  // ── Broadcast loop ─────────────────────────────────────────────────────────
  private async broadcastLoop(): Promise<void> {
    await sleep(20_000); // wait for first decisions
    while (true) {
      if (this.trackRecord.length >= 2) {
        const avgReturn = this.trackRecord.reduce((s, d) => s + d.expectedReturn, 0) / this.trackRecord.length;
        await this.broadcastAll({
          type: "STRATEGY_AVAILABLE",
          executorKey: this.axl.publicKey,
          strategyId: `earngen-v1-${this.axl.publicKey.slice(0, 8)}`,
          trackRecordLength: this.trackRecord.length,
          avgExpectedReturn: avgReturn,
          riskLevel: "moderate",
        });
        console.log(`[Executor] ↗ STRATEGY_AVAILABLE broadcast (${this.trackRecord.length} decisions, avg APY ${(avgReturn * 100).toFixed(1)}%)`);
      }
      await sleep(60_000);
    }
  }

  // ── Message handlers ───────────────────────────────────────────────────────
  private async handleMessage(_raw: any, body: any): Promise<void> {
    switch (body?.type) {
      case "STRATEGY_QUERY":  await this.onStrategyQuery(body as StrategyQuery); break;
      case "PAYMENT":         await this.onPayment(body as Payment);             break;
      case "PERF_REQUEST":    await this.onPerfRequest(body as PerfRequest);     break;
      case "STRATEGY_RATING":
        console.log(`[Executor] ← Critic rating: ${JSON.stringify(
          body.ratings?.find((r: any) => r.agentKey === this.axl.publicKey)
        )}`);
        break;
    }
  }

  private async onStrategyQuery(msg: StrategyQuery): Promise<void> {
    const { requestId, fromKey } = msg;

    if (!this.verifiedPayments.has(requestId)) {
      // x402: payment required
      this.pendingPayments.set(requestId, fromKey);
      await this.axl.send(fromKey, {
        type: "TRACK_RECORD_RESPONSE",
        requestId,
        requiresPayment: true,
        paymentAmount: PAYMENT_AMOUNT,
        paymentRecipient: WALLET_ADDRESS,
      });
      console.log(`[Executor] → 402 to ${fromKey.slice(0, 16)}... (${PAYMENT_AMOUNT} ETH required)`);
      return;
    }

    await this.sendTrackRecord(fromKey, requestId, msg.strategyId);
  }

  private async onPayment(msg: Payment): Promise<void> {
    const { fromKey, requestId, strategyId, amount, proof } = msg;

    if (!this.x402.verify(proof, amount, WALLET_ADDRESS)) {
      console.error(`[Executor] ✗ Invalid payment from ${fromKey.slice(0, 16)}...`);
      return;
    }

    this.verifiedPayments.add(requestId);
    this.pendingPayments.delete(requestId);
    await this.sendTrackRecord(fromKey, requestId, strategyId);
  }

  private async sendTrackRecord(toKey: string, requestId: string, strategyId: string): Promise<void> {
    const jobId = await this.keeperhub.registerSubscriber(strategyId, toKey);
    await this.axl.send(toKey, {
      type: "SUBSCRIPTION_CONFIRMED",
      requestId,
      strategyId,
      jobId,
      decisions: this.trackRecord,
    });
    console.log(`[Executor] ✓ Track record sent (${this.trackRecord.length} decisions, job ${jobId})`);
  }

  private async onPerfRequest(msg: PerfRequest): Promise<void> {
    const wins = this.trackRecord.filter(d => d.expectedReturn > 0.09).length;
    await this.axl.send(msg.criticKey, {
      type: "PERF_RESPONSE",
      fromKey: this.axl.publicKey,
      requestId: msg.requestId,
      agentRole: "executor",
      decisions: this.trackRecord.length,
      avgReturn: this.trackRecord.length
        ? this.trackRecord.reduce((s, d) => s + d.expectedReturn, 0) / this.trackRecord.length
        : 0,
      winRate: this.trackRecord.length ? wins / this.trackRecord.length : 0,
    });
    console.log(`[Executor] → PERF_RESPONSE to critic`);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  private async broadcastAll(msg: object): Promise<void> {
    const topo = await this.axl.topology();
    await Promise.allSettled(
      topo.peers.filter(p => p.up).map(p => this.axl.send(p.public_key, msg))
    );
  }
}
