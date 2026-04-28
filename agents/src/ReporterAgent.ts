import * as dotenv from "dotenv";
dotenv.config({ path: "../.env" });

import { UniswapV4Scanner, type PoolState } from "./scanner/UniswapV4Scanner";
import { calcPoolFeeAPY, formatAPY, apyRisk } from "./calculator/APYCalculator";
import { SlippageGuard } from "./calculator/SlippageGuard";
import { computePairRAR, type RARResult } from "./calculator/VolatilityCalculator";
import { ExecutionHistory } from "./storage/ExecutionHistory";
import { ETH_ADDRESS, KNOWN_TOKENS } from "./config/chains";

const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS ?? 60_000);
const TOP_N            = Number(process.env.TOP_N            ?? 20);
const NETWORK_FILTER   = (process.env.NETWORK_FILTER ?? "all") as "mainnet" | "testnet" | "all";

// ─── Ranked yield opportunity ─────────────────────────────────────────────────
export interface RankedOpportunity {
  rank:          number;
  chainId:       number;
  chainName:     string;
  network:       "mainnet" | "testnet";
  poolId:        string;
  pair:          string;
  feeTier:       number;
  feeTierLabel:  string;
  liveAPY:       number;
  referenceAPY:  number;
  displayAPY:    number;
  apySource:     "live" | "reference";
  risk:          ReturnType<typeof apyRisk>;
  tvlUsd:        number;
  volume24hUsd:  number;
  token0Price:   number;
  token1Price:   number;
  // ── Risk-Adjusted Return ──────────────────────────────────────────────────
  /** RAR = displayAPY / annualised vol (24h hourly log-returns). 0 = not yet computed. */
  rar24h:        number;
  /** RAR = displayAPY / annualised vol (7d hourly log-returns). */
  rar7d:         number;
  /** Annualised volatility % used for rar24h */
  vol24h:        number;
  /** Annualised volatility % used for rar7d */
  vol7d:         number;
  rarQuality:    RARResult["quality"];
  token0PriceChange24h: number;
  token0PriceChange7d:  number;
  token1PriceChange24h: number;
  token1PriceChange7d:  number;
  pairPriceChange24h:   number;
  pairPriceChange7d:    number;
  // ── Net APY (fee APY minus expected impermanent loss) ─────────────────────
  /** Annualised expected IL % = 0.5 × (vol7d/100)² × 100. 0 = vol not yet computed. */
  expectedIL:    number;
  /** Net APY = displayAPY − expectedIL. Can be negative for volatile pairs. */
  netAPY:        number;
  lastUpdated:   number;
}

export class ReporterAgent {
  private scanner  = new UniswapV4Scanner();
  private slippage = new SlippageGuard();
  private history  = new ExecutionHistory();
  private latest:  RankedOpportunity[] = [];
  private running  = false;

  async start(): Promise<void> {
    this.running = true;
    const net = NETWORK_FILTER === "all" ? "mainnet + testnet" : NETWORK_FILTER;
    console.log(`[Reporter] Starting — ${SCAN_INTERVAL_MS / 1000}s interval  [${net}]`);
    await this.runScan();
    const interval = setInterval(async () => {
      if (!this.running) { clearInterval(interval); return; }
      await this.runScan();
    }, SCAN_INTERVAL_MS);
  }

  stop(): void { this.running = false; this.history.close(); }

  // ─── Scan cycle ───────────────────────────────────────────────────────────
  private async runScan(): Promise<void> {
    const t0 = Date.now();
    console.log(`\n[Reporter] ─── ${new Date().toISOString()} ───`);

    let pools: PoolState[];
    try {
      pools = await this.scanner.scanAllChains(
        NETWORK_FILTER === "all" ? undefined : NETWORK_FILTER
      );
    } catch (err: any) {
      console.error(`[Reporter] Scan failed: ${err.message}`);
      return;
    }

    // Rank without RAR first (fast), then enrich with RAR async
    const ranked = this.rankBasic(pools).slice(0, TOP_N);
    this.latest  = ranked; // serve immediately without waiting for vol

    // Compute RAR for top N in background — updates this.latest in-place
    this.enrichRAR(ranked).then(() => {
      console.log(`[Reporter] RAR computed for ${ranked.length} pools`);
    });

    console.log(`[Reporter] ${pools.length} pools → top ${ranked.length} (${Date.now() - t0}ms)`);
    this.printTable(ranked.slice(0, 10));
  }

  // ─── Basic ranking (APY only, no vol) ────────────────────────────────────
  private rankBasic(pools: PoolState[]): RankedOpportunity[] {
    // Build lookup of previous RAR values so we don't blank them mid-scan
    const prevRar = new Map(this.latest.map(o => [o.poolId, o]));

    return pools
      .map((p): RankedOpportunity => {
        const displayAPY  = p.liveAPY > 0.01 ? p.liveAPY : p.referenceAPY;
        const apySource   = p.liveAPY > 0.01 ? "live" : "reference";
        const prev        = prevRar.get(p.poolId);
        return {
          rank:         0,
          chainId:      p.chainId,
          chainName:    p.chainName,
          network:      p.network,
          poolId:       p.poolId,
          pair:         `${p.token0Symbol}/${p.token1Symbol}`,
          feeTier:      p.poolKey.fee,
          feeTierLabel: `${(p.poolKey.fee / 10_000).toFixed(2)}%`,
          liveAPY:      p.liveAPY,
          referenceAPY: p.referenceAPY,
          displayAPY,
          apySource,
          risk:         apyRisk(displayAPY),
          tvlUsd:       p.tvlUsd,
          volume24hUsd: p.volume24hUsd,
          token0Price:  p.token0Price,
          token1Price:  p.token1Price,
          rar24h:       prev?.rar24h       ?? 0,
          rar7d:        prev?.rar7d        ?? 0,
          vol24h:       prev?.vol24h       ?? 0,
          vol7d:        prev?.vol7d        ?? 0,
          rarQuality:           prev?.rarQuality           ?? "n/a",
          token0PriceChange24h: prev?.token0PriceChange24h ?? 0,
          token0PriceChange7d:  prev?.token0PriceChange7d  ?? 0,
          token1PriceChange24h: prev?.token1PriceChange24h ?? 0,
          token1PriceChange7d:  prev?.token1PriceChange7d  ?? 0,
          pairPriceChange24h:   prev?.pairPriceChange24h   ?? 0,
          pairPriceChange7d:    prev?.pairPriceChange7d    ?? 0,
          expectedIL:           prev?.expectedIL           ?? 0,
          netAPY:               prev?.netAPY               ?? displayAPY,
          lastUpdated:  p.lastUpdated,
          // stash addresses for RAR calc
          _token0Address: p.poolKey.currency0,
          _token1Address: p.poolKey.currency1,
          _token0Symbol:  p.token0Symbol,
          _token1Symbol:  p.token1Symbol,
        } as any;
      })
      .sort((a, b) => b.displayAPY - a.displayAPY)
      .map((o, i) => ({ ...o, rank: i + 1 }));
  }

  // ─── Enrich ranked list with RAR (network calls per unique token) ─────────
  private async enrichRAR(ranked: RankedOpportunity[]): Promise<void> {
    await Promise.allSettled(
      ranked.map(async (opp) => {
        const r = opp as any; // access stashed fields
        if (!r._token0Address) return;
        const rar = await computePairRAR({
          apy:           opp.displayAPY,
          chainId:       opp.chainId,
          token0Address: r._token0Address,
          token1Address: r._token1Address,
          token0Symbol:  r._token0Symbol,
          token1Symbol:  r._token1Symbol,
        });
        opp.rar24h             = rar.rar24h;
        opp.rar7d              = rar.rar7d;
        opp.vol24h             = rar.vol24h;
        opp.vol7d              = rar.vol7d;
        opp.rarQuality         = rar.quality;
        opp.token0PriceChange24h = rar.token0PriceChange24h;
        opp.token0PriceChange7d  = rar.token0PriceChange7d;
        opp.token1PriceChange24h = rar.token1PriceChange24h;
        opp.token1PriceChange7d  = rar.token1PriceChange7d;
        opp.pairPriceChange24h = rar.pairPriceChange24h;
        opp.pairPriceChange7d  = rar.pairPriceChange7d;
        // IL = 0.5 × σ² (annualised). vol7d is in %, so divide by 100 first.
        opp.expectedIL = rar.vol7d > 0 ? 0.5 * (rar.vol7d / 100) ** 2 * 100 : 0;
        opp.netAPY     = opp.displayAPY - opp.expectedIL;
      })
    );
  }

  // ─── Console table ────────────────────────────────────────────────────────
  private printTable(opps: RankedOpportunity[]): void {
    console.log(
      `${"#".padEnd(4)} ${"Chain".padEnd(17)} ${"Pair".padEnd(13)} ${"APY".padEnd(9)} ${"RAR-24h".padEnd(9)} ${"RAR-7d".padEnd(9)} ${"TVL".padEnd(11)} Risk`
    );
    console.log("─".repeat(88));
    for (const o of opps) {
      const rar24 = o.rar24h > 0 ? o.rar24h.toFixed(2) : "…";
      const rar7d = o.rar7d  > 0 ? o.rar7d.toFixed(2)  : "…";
      console.log(
        `${String(o.rank).padEnd(4)} ${o.chainName.padEnd(17)} ${o.pair.padEnd(13)} ` +
        `${formatAPY(o.displayAPY).padEnd(9)} ${rar24.padEnd(9)} ${rar7d.padEnd(9)} ` +
        `$${(o.tvlUsd / 1000).toFixed(0)}K`.padEnd(11) + ` ${o.risk}`
      );
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────
  getLatest()   { return this.latest; }
  getHistory(opts?: Parameters<ExecutionHistory["getExecutions"]>[0]) { return this.history.getExecutions(opts); }
  getPositions()    { return this.history.getOpenPositions(); }
  getAllPositions()  { return this.history.getAllPositions(); }
  getStats()        { return this.history.stats(); }
  getSlippageGuard(){ return this.slippage; }
  getHistoryStore() { return this.history; }
  async checkSlippage(params: Parameters<SlippageGuard["check"]>[0]) { return this.slippage.check(params); }
}
