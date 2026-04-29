import * as dotenv from "dotenv";
dotenv.config({ path: "../.env" });

import pLimit from "p-limit";
import type { EnrichmentStage, RankedOpportunity } from "./api/types";
import { UniswapV4Scanner, type PoolState } from "./scanner/UniswapV4Scanner";
import { calcPoolFeeAPY, formatAPY, apyRisk } from "./calculator/APYCalculator";
import { SlippageGuard } from "./calculator/SlippageGuard";
import { computePairRAR, type RARResult } from "./calculator/VolatilityCalculator";
import { computeLiquidityQuality, lqRankFactor, rankFactor } from "./calculator/LiquidityQualityCalculator";
import { TokenRiskAssessor } from "./calculator/TokenRiskAssessor";
import { StablecoinRiskAssessor } from "./calculator/StablecoinRiskAssessor";
import { computeCapitalEfficiency } from "./calculator/CapitalEfficiencyCalculator";
import { detectAdverseSelection } from "./calculator/AdverseSelectionDetector";
import { runStressTest } from "./calculator/ScenarioStressTester";
import { computeScorecard } from "./calculator/DecisionScorecard";
import { APYHistoryStore } from "./storage/APYHistoryStore";
import { ExecutionHistory } from "./storage/ExecutionHistory";
import { SnapshotStore } from "./storage/SnapshotStore";
import { ETH_ADDRESS, KNOWN_TOKENS } from "./config/chains";

export type { RankedOpportunity } from "./api/types";

const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS ?? 60_000);
const TOP_N            = Number(process.env.TOP_N            ?? 20);
const ENRICH_CONCURRENCY = Number(process.env.ENRICH_CONCURRENCY ?? 5);
const NETWORK_FILTER   = (process.env.NETWORK_FILTER ?? "all") as "mainnet" | "testnet" | "all";

interface RankedSnapshot {
  latest: RankedOpportunity[];
  savedAt: number;
}

export class ReporterAgent {
  private scanner    = new UniswapV4Scanner();
  private slippage   = new SlippageGuard();
  private history    = new ExecutionHistory();
  private apyHistory = new APYHistoryStore();
  private snapshots  = new SnapshotStore();
  private tokenRisk  = new TokenRiskAssessor();
  private stableRisk = new StablecoinRiskAssessor();
  private latest:    RankedOpportunity[] = [];
  private running    = false;
  private scanCount  = 0;

  constructor() {
    this.restoreLatest();
  }

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

  stop(): void {
    this.running = false;
    this.persistLatest();
    this.history.close();
    this.snapshots.close();
  }

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
    this.persistLatest();

    // Record APY snapshots + compute persistence synchronously (SQLite, fast)
    this.enrichPersistence(ranked);

    // Prune old history rows every 100 scans (~100 min at default interval)
    if (++this.scanCount % 100 === 0) this.apyHistory.prune();

    // Compute RAR, then token risk + stablecoin risk in parallel — all in background
    this.enrichRAR(ranked)
      .then(() => Promise.all([
        this.enrichTokenRisk(ranked),
        this.enrichStablecoinRisk(ranked),
      ]))
      .then(() => {
        this.persistLatest();
        console.log(`[Reporter] RAR + token risk + stable risk enriched for ${ranked.length} pools`);
      })
      .catch((err) => {
        console.error(`[Reporter] Enrichment pipeline failed: ${errorMessage(err)}`);
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
        const lq = computeLiquidityQuality(
          p.tvlUsd, p.volume24hUsd, p.poolKey.fee,
          p.liveAPY, p.referenceAPY, apySource,
          prev?.vol7d ?? 0,
        );
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
          liquidityQuality:     prev?.liquidityQuality     ?? lq.score,
          medianAPY7d:          prev?.medianAPY7d          ?? 0,
          apyPersistence:       prev?.apyPersistence       ?? 1.0,
          tokenRisk:            prev?.tokenRisk            ?? null,
          stablecoinRisk:       prev?.stablecoinRisk       ?? null,
          timeInRangePct:       prev?.timeInRangePct       ?? 0,
          feeCaptureEfficiency: prev?.feeCaptureEfficiency ?? 0,
          capitalUtilization:   prev?.capitalUtilization   ?? 0,
          effectiveNetAPY:      prev?.effectiveNetAPY      ?? displayAPY,
          halfRangePct:         prev?.halfRangePct         ?? 0,
          adverseSelection:     prev?.adverseSelection     ?? null,
          stressTest:           prev?.stressTest           ?? null,
          scorecard:            prev?.scorecard            ?? null,
          hookFlags:            p.hookFlags      ?? [],
          hasCustomHooks:       p.hasCustomHooks ?? false,
          enrichmentDegraded:   false,
          enrichmentErrors:     [],
          lastUpdated:  p.lastUpdated,
          // stash addresses for RAR calc
          _token0Address: p.poolKey.currency0,
          _token1Address: p.poolKey.currency1,
          _token0Symbol:  p.token0Symbol,
          _token1Symbol:  p.token1Symbol,
        } as any;
      })
      .sort((a, b) =>
        b.displayAPY * rankFactor(b.liquidityQuality, b.apyPersistence) -
        a.displayAPY * rankFactor(a.liquidityQuality, a.apyPersistence)
      )
      .map((o, i) => ({ ...o, rank: i + 1 }));
  }

  // ─── Enrich ranked list with RAR (network calls per unique token) ─────────
  private async enrichRAR(ranked: RankedOpportunity[]): Promise<void> {
    const limit = pLimit(ENRICH_CONCURRENCY);
    await Promise.allSettled(
      ranked.map((opp) => limit(async () => {
        const r = opp as any; // access stashed fields
        if (!r._token0Address) return;

        try {
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
          // IL = 0.5 × sigma^2 (annualised). vol7d is in %, so divide by 100 first.
          opp.expectedIL = rar.vol7d > 0 ? 0.5 * (rar.vol7d / 100) ** 2 * 100 : 0;
          opp.netAPY     = opp.displayAPY - opp.expectedIL;
          // Recompute LQ now that vol7d is available (depth component becomes accurate)
          opp.liquidityQuality = computeLiquidityQuality(
            opp.tvlUsd, opp.volume24hUsd, opp.feeTier,
            opp.liveAPY, opp.referenceAPY, opp.apySource,
            opp.vol7d,
          ).score;
        } catch (err) {
          markEnrichmentFailed("enrichRAR", opp, err);
        }

        try {
          const ce = await computeCapitalEfficiency({
            chainId:            opp.chainId,
            token0Address:      r._token0Address,
            token0Symbol:       r._token0Symbol,
            token1Address:      r._token1Address,
            token1Symbol:       r._token1Symbol,
            vol7d:              opp.vol7d,
            liveAPY:            opp.liveAPY,
            referenceAPY:       opp.referenceAPY,
            tvlUsd:             opp.tvlUsd,
            volume24hUsd:       opp.volume24hUsd,
            netAPY:             opp.netAPY,
          });
          opp.timeInRangePct       = ce.timeInRangePct;
          opp.feeCaptureEfficiency = ce.feeCaptureEfficiency;
          opp.capitalUtilization   = ce.capitalUtilization;
          opp.effectiveNetAPY      = ce.effectiveNetAPY;
          opp.halfRangePct         = ce.halfRangePct;
        } catch (err) {
          markEnrichmentFailed("capitalEfficiency", opp, err);
        }

        try {
          const adv = await detectAdverseSelection({
            chainId:            opp.chainId,
            token0Address:      r._token0Address,
            token0Symbol:       r._token0Symbol,
            token1Address:      r._token1Address,
            token1Symbol:       r._token1Symbol,
            liveAPY:            opp.liveAPY,
            referenceAPY:       opp.referenceAPY,
            vol24h:             opp.vol24h,
            vol7d:              opp.vol7d,
            tvlUsd:             opp.tvlUsd,
            volume24hUsd:       opp.volume24hUsd,
            pairPriceChange24h: opp.pairPriceChange24h,
          });
          opp.adverseSelection = adv;
          if (adv.quality === "high" || adv.quality === "elevated") {
            console.log(`[Reporter] Adverse selection ${adv.quality}: ${opp.pair} score=${adv.score} — ${adv.flags[0] ?? ""}`);
          }
        } catch (err) {
          markEnrichmentFailed("adverseSelection", opp, err);
        }

        try {
          // Stress test: synchronous — all inputs are already available
          const isStablePool = !!(opp.stablecoinRisk?.isStablePool);
          opp.stressTest = runStressTest({
            chainId:              opp.chainId,
            vol7d:                opp.vol7d,
            displayAPY:           opp.displayAPY,
            medianAPY7d:          opp.medianAPY7d,
            apyPersistence:       opp.apyPersistence,
            timeInRangePct:       opp.timeInRangePct,
            feeCaptureEfficiency: opp.feeCaptureEfficiency,
            expectedIL:           opp.expectedIL,
            netAPY:               opp.netAPY,
            effectiveNetAPY:      opp.effectiveNetAPY,
            tvlUsd:               opp.tvlUsd,
            volume24hUsd:         opp.volume24hUsd,
            isStablePool,
          });
        } catch (err) {
          markEnrichmentFailed("stressTest", opp, err);
        }

        try {
          // Scorecard: standalone (correlation=50, regime=75 until PM enriches)
          opp.scorecard = computeScorecard(opp);
        } catch (err) {
          markEnrichmentFailed("scorecard", opp, err);
        }
      }))
    );
    // Re-sort: LQ × persistence × capitalUtilization × (1 − advPenalty) × (1 − stressPenalty)
    // advPenalty:    score > 50 discounts up to 30% at score=100
    // stressPenalty: downsideScore > 30 discounts up to 25% at score=100
    ranked.sort((a, b) => {
      const fa    = rankFactor(a.liquidityQuality, a.apyPersistence);
      const fb    = rankFactor(b.liquidityQuality, b.apyPersistence);
      const cua   = a.capitalUtilization > 0 ? a.capitalUtilization : 1.0;
      const cub   = b.capitalUtilization > 0 ? b.capitalUtilization : 1.0;
      const adva  = 1 - Math.max(0, (a.adverseSelection?.score ?? 0) - 50) / 100 * 0.3;
      const advb  = 1 - Math.max(0, (b.adverseSelection?.score ?? 0) - 50) / 100 * 0.3;
      const stra  = 1 - Math.max(0, (a.stressTest?.downsideScore ?? 0) - 30) / 70 * 0.25;
      const strb  = 1 - Math.max(0, (b.stressTest?.downsideScore ?? 0) - 30) / 70 * 0.25;
      const sa    = (a.rar7d > 0 ? a.rar7d * cua : a.effectiveNetAPY / 50) * fa * adva * stra;
      const sb    = (b.rar7d > 0 ? b.rar7d * cub : b.effectiveNetAPY / 50) * fb * advb * strb;
      return sb - sa;
    });
    ranked.forEach((o, i) => { o.rank = i + 1; });
  }

  // ─── APY persistence ─────────────────────────────────────────────────────
  // Record each pool's current APY and compute persistence from the 7d median.
  // Synchronous (SQLite), runs before enrichRAR so the final re-sort uses it.
  private enrichPersistence(ranked: RankedOpportunity[]): void {
    for (const opp of ranked) {
      this.apyHistory.record(opp.poolId, opp.displayAPY);
      const median = this.apyHistory.getMedian7d(opp.poolId);
      if (median !== null && opp.displayAPY > 0) {
        opp.medianAPY7d   = +median.toFixed(2);
        opp.apyPersistence = +Math.min(median / opp.displayAPY, 1.0).toFixed(4);
      }
      // If no history yet, leave defaults (medianAPY7d=0, apyPersistence=1.0)
    }
  }

  // ─── Token risk enrichment ───────────────────────────────────────────────
  // Runs after enrichRAR so token0/1 prices are current. Per-pool calls are bounded by ENRICH_CONCURRENCY.
  private async enrichTokenRisk(ranked: RankedOpportunity[]): Promise<void> {
    const limit = pLimit(ENRICH_CONCURRENCY);
    await Promise.allSettled(
      ranked.map((opp) => limit(async () => {
        const r = opp as any;
        if (!r._token0Address) return;
        try {
          opp.tokenRisk = await this.tokenRisk.assessPool(
            r._token0Address, r._token0Symbol,
            r._token1Address, r._token1Symbol,
            opp.chainId,
            opp.token0Price,
            opp.token1Price,
          );
          if (opp.tokenRisk.blockEntry) {
            console.log(`[Reporter] Token risk BLOCK: ${opp.pair} on ${opp.chainName} — ${opp.tokenRisk.flags.join("; ")}`);
          } else if (opp.tokenRisk.poolRiskScore > 40) {
            console.log(`[Reporter] Token risk advisory: ${opp.pair} score=${opp.tokenRisk.poolRiskScore} — ${opp.tokenRisk.flags.join("; ")}`);
          }
          // Refresh scorecard tokenRisk dimension now that real data is available
          if (opp.scorecard) opp.scorecard = computeScorecard(opp);
        } catch (err) {
          markEnrichmentFailed("tokenRisk", opp, err);
        }
      }))
    );
    // Prune expired cache entries once per scan cycle
    this.tokenRisk.clearExpired();
  }

  // ─── Stablecoin risk enrichment ──────────────────────────────────────────
  // Runs in parallel with enrichTokenRisk (both are independent post-RAR steps).
  private async enrichStablecoinRisk(ranked: RankedOpportunity[]): Promise<void> {
    const limit = pLimit(ENRICH_CONCURRENCY);
    await Promise.allSettled(
      ranked.map((opp) => limit(async () => {
        const r = opp as any;
        if (!r._token0Address) return;
        try {
          const result = await this.stableRisk.assessPool(
            r._token0Address, r._token0Symbol,
            r._token1Address, r._token1Symbol,
            opp.chainId,
            opp.token0Price,
            opp.token1Price,
          );
          opp.stablecoinRisk = result; // null if no stablecoins in pool
          if (result?.blockEntry) {
            console.log(`[Reporter] Stable risk BLOCK: ${opp.pair} — ${result.flags[0]}`);
          } else if (result && result.compositeScore > 40) {
            console.log(`[Reporter] Stable risk advisory: ${opp.pair} score=${result.compositeScore} — ${result.flags.join("; ")}`);
          }
        } catch (err) {
          markEnrichmentFailed("stablecoinRisk", opp, err);
        }
      }))
    );
  }

  // ─── Console table ────────────────────────────────────────────────────────
  private printTable(opps: RankedOpportunity[]): void {
    console.log(
      `${"#".padEnd(4)} ${"Chain".padEnd(17)} ${"Pair".padEnd(13)} ${"APY".padEnd(9)} ${"Med7d".padEnd(8)} ${"Persist".padEnd(8)} ${"RAR-7d".padEnd(9)} ${"TVL".padEnd(11)} ${"LQ".padEnd(5)} ${"TRisk".padEnd(8)} Risk`
    );
    console.log("─".repeat(114));
    for (const o of opps) {
      const rar7d   = o.rar7d       > 0 ? o.rar7d.toFixed(2)          : "…";
      const med     = o.medianAPY7d > 0 ? formatAPY(o.medianAPY7d)    : "…";
      const persist = o.medianAPY7d > 0 ? (o.apyPersistence * 100).toFixed(0) + "%" : "…";
      const lq      = o.liquidityQuality > 0 ? String(o.liquidityQuality) : "…";
      const tr      = o.tokenRisk
        ? (o.tokenRisk.blockEntry ? "BLOCK" : String(o.tokenRisk.poolRiskScore))
        : "…";
      console.log(
        `${String(o.rank).padEnd(4)} ${o.chainName.padEnd(17)} ${o.pair.padEnd(13)} ` +
        `${formatAPY(o.displayAPY).padEnd(9)} ${med.padEnd(8)} ${persist.padEnd(8)} ` +
        `${rar7d.padEnd(9)} $${(o.tvlUsd / 1000).toFixed(0)}K`.padEnd(11) + ` ${lq.padEnd(5)} ${tr.padEnd(8)} ${o.risk}`
      );
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────
  getLatest()          { return this.latest; }
  getApyHistoryStore() { return this.apyHistory; }
  getHistory(opts?: Parameters<ExecutionHistory["getExecutions"]>[0]) { return this.history.getExecutions(opts); }
  getPositions()    { return this.history.getOpenPositions(); }
  getAllPositions()  { return this.history.getAllPositions(); }
  getStats()        { return this.history.stats(); }
  getSlippageGuard(){ return this.slippage; }
  getHistoryStore() { return this.history; }
  async checkSlippage(params: Parameters<SlippageGuard["check"]>[0]) { return this.slippage.check(params); }

  private restoreLatest(): void {
    try {
      const snapshot = this.snapshots.load<RankedSnapshot>("ranked.latest");
      if (snapshot?.latest?.length) {
        this.latest = snapshot.latest;
        console.log(`[Reporter] Restored ${this.latest.length} ranked opportunities from SQLite snapshot`);
      }
    } catch (err) {
      console.warn(`[Reporter] Failed to restore ranked snapshot: ${errorMessage(err)}`);
    }
  }

  private persistLatest(): void {
    try {
      this.snapshots.save<RankedSnapshot>("ranked.latest", {
        latest: this.latest,
        savedAt: Date.now(),
      });
    } catch (err) {
      console.warn(`[Reporter] Failed to persist ranked snapshot: ${errorMessage(err)}`);
    }
  }
}

function markEnrichmentFailed(stage: EnrichmentStage, opp: RankedOpportunity, err: unknown): void {
  const message = errorMessage(err);
  opp.enrichmentDegraded = true;
  opp.enrichmentErrors.push({ stage, message, timestamp: Date.now() });
  console.warn(`[${stage}] pool ${opp.poolId} failed: ${message}`);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
