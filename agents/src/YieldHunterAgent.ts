import * as dotenv from "dotenv";
dotenv.config({ path: "../../.env" });

import { UniswapV4Scanner, type PoolState } from "./scanner/UniswapV4Scanner";
import { calcPoolFeeAPY, formatAPY, apyRisk } from "./calculator/APYCalculator";
import { SlippageGuard } from "./calculator/SlippageGuard";
import { ExecutionHistory } from "./storage/ExecutionHistory";

const SCAN_INTERVAL_MS  = Number(process.env.SCAN_INTERVAL_MS  ?? 60_000);
const MAX_SLIPPAGE_BPS  = Number(process.env.MAX_SLIPPAGE_BPS  ?? 50);
const TOP_N             = Number(process.env.TOP_N             ?? 20);
// Set NETWORK_FILTER=mainnet or NETWORK_FILTER=testnet to restrict scanning.
// Default: scan both.
const NETWORK_FILTER    = (process.env.NETWORK_FILTER ?? "all") as "mainnet" | "testnet" | "all";

// ─── Ranked yield opportunity (what the API/dashboard consumes) ───────────────
export interface RankedOpportunity {
  rank:           number;
  chainId:        number;
  chainName:      string;
  network:        "mainnet" | "testnet";
  poolId:         string;
  pair:           string;           // e.g. "WETH/USDC"
  feeTier:        number;
  feeTierLabel:   string;           // e.g. "0.30%"
  liveAPY:        number;
  referenceAPY:   number;
  /** Best APY to display: live if >0, else reference */
  displayAPY:     number;
  apySource:      "live" | "reference";
  risk:           ReturnType<typeof apyRisk>;
  tvlUsd:         number;
  volume24hUsd:   number;
  token0Price:    number;
  token1Price:    number;
  lastUpdated:    number;
}

export class YieldHunterAgent {
  private scanner  = new UniswapV4Scanner();
  private slippage = new SlippageGuard();
  private history  = new ExecutionHistory();
  private latest:  RankedOpportunity[] = [];
  private running  = false;

  // ─── Start the scan loop ──────────────────────────────────────────────────
  async start(): Promise<void> {
    this.running = true;
    const networkLabel = NETWORK_FILTER === "all" ? "mainnet + testnet" : NETWORK_FILTER;
    console.log(`[YieldHunter] Starting — scanning every ${SCAN_INTERVAL_MS / 1000}s  [${networkLabel}]`);

    await this.runScan(); // immediate first scan

    const interval = setInterval(async () => {
      if (!this.running) {
        clearInterval(interval);
        return;
      }
      await this.runScan();
    }, SCAN_INTERVAL_MS);
  }

  stop(): void {
    this.running = false;
    this.history.close();
  }

  // ─── Core scan + rank cycle ──────────────────────────────────────────────
  private async runScan(): Promise<void> {
    const start = Date.now();
    console.log(`\n[YieldHunter] ─── Scan cycle ${new Date().toISOString()} ───`);

    let pools: PoolState[];
    try {
      pools = await this.scanner.scanAllChains(
        NETWORK_FILTER === "all" ? undefined : NETWORK_FILTER
      );
    } catch (err: any) {
      console.error(`[YieldHunter] Scan failed: ${err.message}`);
      return;
    }

    const ranked = this.rank(pools).slice(0, TOP_N);
    this.latest  = ranked;

    const elapsed = Date.now() - start;
    console.log(`[YieldHunter] Found ${pools.length} pools → top ${ranked.length} ranked (${elapsed}ms)`);
    this.printTable(ranked.slice(0, 10));
  }

  // ─── Ranking logic ───────────────────────────────────────────────────────
  private rank(pools: PoolState[]): RankedOpportunity[] {
    return pools
      .map((p, i): RankedOpportunity => {
        const displayAPY  = p.liveAPY > 0.01 ? p.liveAPY : p.referenceAPY;
        const apySource   = p.liveAPY > 0.01 ? "live" : "reference";
        const feeTierLabel = `${(p.poolKey.fee / 10_000).toFixed(2)}%`;

        return {
          rank:         i + 1,
          chainId:      p.chainId,
          chainName:    p.chainName,
          network:      p.network,
          poolId:       p.poolId,
          pair:         `${p.token0Symbol}/${p.token1Symbol}`,
          feeTier:      p.poolKey.fee,
          feeTierLabel,
          liveAPY:      p.liveAPY,
          referenceAPY: p.referenceAPY,
          displayAPY,
          apySource,
          risk:         apyRisk(displayAPY),
          tvlUsd:       p.tvlUsd,
          volume24hUsd: p.volume24hUsd,
          token0Price:  p.token0Price,
          token1Price:  p.token1Price,
          lastUpdated:  p.lastUpdated,
        };
      })
      .sort((a, b) => b.displayAPY - a.displayAPY)
      .map((o, i) => ({ ...o, rank: i + 1 }));
  }

  // ─── Console table ───────────────────────────────────────────────────────
  private printTable(opps: RankedOpportunity[]): void {
    console.log(
      `${"Rank".padEnd(5)} ${"Chain".padEnd(18)} ${"Pair".padEnd(14)} ${"Fee".padEnd(6)} ${"Live APY".padEnd(10)} ${"Ref APY".padEnd(10)} ${"TVL".padEnd(12)} Risk`
    );
    console.log("─".repeat(85));
    for (const o of opps) {
      console.log(
        `${String(o.rank).padEnd(5)} ${o.chainName.padEnd(18)} ${o.pair.padEnd(14)} ${o.feeTierLabel.padEnd(6)} ${formatAPY(o.liveAPY).padEnd(10)} ${formatAPY(o.referenceAPY).padEnd(10)} $${o.tvlUsd.toLocaleString("en", { maximumFractionDigits: 0 }).padEnd(11)} ${o.risk}`
      );
    }
  }

  // ─── Public API surface (used by api/server.ts) ───────────────────────────
  getLatest(): RankedOpportunity[] {
    return this.latest;
  }

  getHistory(opts?: Parameters<ExecutionHistory["getExecutions"]>[0]) {
    return this.history.getExecutions(opts);
  }

  getPositions() {
    return this.history.getOpenPositions();
  }

  getAllPositions() {
    return this.history.getAllPositions();
  }

  getStats() {
    return this.history.stats();
  }

  getSlippageGuard(): SlippageGuard {
    return this.slippage;
  }

  getHistoryStore(): ExecutionHistory {
    return this.history;
  }

  // ─── Pre-trade slippage check (callable from dashboard/API) ──────────────
  async checkSlippage(params: Parameters<SlippageGuard["check"]>[0]) {
    return this.slippage.check(params);
  }
}
