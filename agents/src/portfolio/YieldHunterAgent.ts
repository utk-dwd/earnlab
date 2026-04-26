import { randomUUID } from "crypto";
import { AXLClient } from "../integrations/axl/AXLClient";
import type { YieldOpportunityMsg, PerfRequest } from "./messages";

const DEFILLAMA_URL = "https://yields.llama.fi/pools";
const SCAN_INTERVAL_MS = 60_000;
const TOP_N = 8; // broadcast top 8 opportunities per scan
const MIN_TVL_USD = 500_000; // ignore dust pools

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Pool {
  pool: string;
  project: string;
  chain: string;
  symbol: string;
  tvlUsd: number;
  apy: number;
}

export class YieldHunterAgent {
  private axl: AXLClient;
  private opportunitiesFound = 0;
  private allApys: number[] = [];

  constructor(private readonly port = 9006) {
    this.axl = new AXLClient(port);
  }

  async start(): Promise<void> {
    console.log("[YieldHunter] Starting...");
    await this.axl.waitForNode();
    await this.axl.init();
    console.log(`[YieldHunter] AXL key: ${this.axl.publicKey}`);
    console.log("[YieldHunter] Goal: find the HIGHEST yields across all protocols");

    this.axl.startPolling(this.handleMessage.bind(this), 400);
    this.scanLoop();
  }

  // ── Yield scanning ─────────────────────────────────────────────────────────
  private async scanLoop(): Promise<void> {
    await sleep(5_000); // brief startup pause
    while (true) {
      try { await this.scan(); } catch (e) { console.error("[YieldHunter] Scan error:", e); }
      await sleep(SCAN_INTERVAL_MS);
    }
  }

  private async scan(): Promise<void> {
    console.log("[YieldHunter] Scanning DefiLlama for highest yields...");
    const resp = await fetch(DEFILLAMA_URL);
    if (!resp.ok) throw new Error(`DefiLlama HTTP ${resp.status}`);
    const json = await resp.json() as any;

    const pools: Pool[] = (json.data ?? [])
      .filter((p: Pool) => p.chain === "Ethereum" && p.tvlUsd >= MIN_TVL_USD && p.apy > 0)
      .sort((a: Pool, b: Pool) => b.apy - a.apy) // highest APY first — no risk filter
      .slice(0, TOP_N);

    if (!pools.length) { console.log("[YieldHunter] No pools found"); return; }

    console.log(
      `[YieldHunter] Top yield: ${(pools[0].apy).toFixed(1)}% APY ` +
      `(${pools[0].symbol} on ${pools[0].project})`
    );

    // Broadcast each opportunity to all mesh peers
    for (const pool of pools) {
      const [tokenA = "?", tokenB = "?"] = pool.symbol.split("-");
      const msg: YieldOpportunityMsg = {
        type: "YIELD_OPPORTUNITY",
        hunterKey: this.axl.publicKey,
        opportunityId: randomUUID(),
        protocol: pool.project,
        poolAddress: pool.pool,
        tokenA,
        tokenB,
        apy: pool.apy / 100, // DefiLlama returns % e.g. 12.5 → 0.125
        tvl: pool.tvlUsd,
        timestamp: Date.now(),
      };
      await this.broadcastAll(msg);
      this.opportunitiesFound++;
      this.allApys.push(msg.apy);
    }

    console.log(`[YieldHunter] ↗ Broadcast ${pools.length} opportunities (best: ${(pools[0].apy).toFixed(1)}%)`);
  }

  // ── Message handlers ───────────────────────────────────────────────────────
  private async handleMessage(raw: any, body: any): Promise<void> {
    switch (body?.type) {
      case "ALLOCATION_DECISION":
        console.log(
          `[YieldHunter] ← PortfolioManager ${body.approved ? "✓ APPROVED" : "✗ REJECTED"} ` +
          `opportunity (allocated: ${(body.actualAllocation * 100).toFixed(1)}%` +
          (body.cappedBy30pct ? ", capped at 30%" : "") + ")"
        );
        break;

      case "RISK_CHALLENGE":
        console.log(
          `[YieldHunter] ← RiskManager challenge on ${body.opportunityId.slice(0, 8)}...: ` +
          `${body.approved ? "approved" : "REJECTED"} (riskScore=${body.riskScore}, ` +
          `Sharpe≈${body.sharpeEstimate.toFixed(2)}, maxAlloc=${(body.maxAllocation * 100).toFixed(0)}%)`
        );
        break;

      case "PORTFOLIO_SNAPSHOT":
        console.log(
          `[YieldHunter] ← Portfolio: ${body.positions.length} positions, ` +
          `utilisation ${(body.utilisation * 100).toFixed(1)}%`
        );
        break;

      case "RISK_ASSESSMENT":
        console.log(`[YieldHunter] ← RiskManager assessment: ${JSON.stringify(body.assessments)}`);
        break;

      case "PERF_REQUEST":
        await this.onPerfRequest(raw.from, body as PerfRequest);
        break;
    }
  }

  private async onPerfRequest(from: string, msg: PerfRequest): Promise<void> {
    const avgApy = this.allApys.length
      ? this.allApys.reduce((s, v) => s + v, 0) / this.allApys.length
      : 0;
    const bestApy = this.allApys.length ? Math.max(...this.allApys) : 0;

    await this.axl.send(from, {
      type: "PERF_RESPONSE",
      fromKey: this.axl.publicKey,
      requestId: msg.requestId,
      agentRole: "yield-hunter",
      opportunitiesFound: this.opportunitiesFound,
      avgApy,
      bestApy,
    });
    console.log(`[YieldHunter] → PERF_RESPONSE to RiskManager`);
  }

  private async broadcastAll(msg: object): Promise<void> {
    const topo = await this.axl.topology();
    await Promise.allSettled(
      topo.peers.filter(p => p.up).map(p => this.axl.send(p.public_key, msg))
    );
  }
}
