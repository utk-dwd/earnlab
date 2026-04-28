/**
 * ZeroGMemory — outcome-based episodic memory on 0G decentralised KV storage.
 *
 * Lifecycle:
 *   1. recordEntry() — called when a position is opened; stored in a pending map.
 *   2. recordExit()  — called when a position closes; completes the record with
 *                      outcome data, pushes to the in-memory buffer, and writes
 *                      to 0G (fire-and-forget, never blocks the portfolio tick).
 *
 * Retrieval:
 *   getSimilar(conditions, n) — Euclidean nearest-neighbour over completed records'
 *   marketConditions (rar7d, vol7d, change7d).  Returns the n closest past
 *   outcomes — the LLM uses these to reason from experience, not just recency.
 *
 * 0G KV layout
 *   stream: ZEROG_STREAM_ID
 *   key:    8-byte big-endian unix timestamp (ms) — sortable
 *   value:  JSON-encoded DecisionRecord
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MarketConditions {
  rar7d:    number;  // risk-adjusted return, 7d (0–30+)
  vol7d:    number;  // annualized volatility % (0–100+)
  change7d: number;  // signed pair price change over 7d, in % (e.g. −7.4)
}

export interface DecisionSummary {
  action:             "enter" | "exit" | "rebalance" | "hold" | "wait";
  confidence:         number;     // 0–1
  allocationPct?:     number;
  reasoning:          string;
  vetoed:             boolean;    // Critic blocked the trade
  critiqueReasoning?: string;     // Critic's reasoning when vetoed=false too
}

export interface DecisionOutcome {
  actualAPY:    number;  // realized annualized fee APY (TiR-adjusted)
  ilCost:       number;  // estimated IL % (0 when unknown)
  netReturn:    number;  // USD P&L after exit fee
  daysHeld:     number;
  closeReason?: string;
}

export interface DecisionRecord {
  timestamp:  number;
  pool:       string;
  pair:       string;
  chainName:  string;
  conditions: MarketConditions;
  decision:   DecisionSummary;
  outcome?:   DecisionOutcome;  // undefined = position still open
}

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_IN_MEMORY = 100;  // ring buffer of completed records

const ZEROG_RPC_URL      = process.env.ZEROG_RPC_URL      ?? "https://evmrpc-testnet.0g.ai";
const ZEROG_INDEXER_URL  = process.env.ZEROG_INDEXER_URL  ?? "https://indexer-storage-testnet-turbo.0g.ai";
const ZEROG_KV_URL       = process.env.ZEROG_KV_URL       ?? "http://3.101.147.150:6789";
const ZEROG_FLOW_ADDRESS = process.env.ZEROG_FLOW_ADDRESS ?? "0xbD2C3F0E65eDF5582141C35969d66e34629cC768";
const ZEROG_STREAM_ID    = process.env.ZEROG_STREAM_ID    ?? "0x7f5f4552091a69125d5dfcb7b8c2659029395bdf";
const ZEROG_PRIVATE_KEY  = process.env.ZEROG_PRIVATE_KEY;

function timestampKey(ts: number): Uint8Array {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(ts));
  return new Uint8Array(buf);
}

// ─── Similarity metric ────────────────────────────────────────────────────────

// Normalized Euclidean distance over the three condition dimensions.
// Normalizers chosen for typical observed ranges.
function marketDistance(a: MarketConditions, b: MarketConditions): number {
  const dR = (a.rar7d    - b.rar7d)    / 10;   // rar7d range  ≈ 0–30
  const dV = (a.vol7d    - b.vol7d)    / 30;   // vol7d range  ≈ 0–100%
  const dC = (a.change7d - b.change7d) / 20;   // change range ≈ −50% to +50%
  return Math.sqrt(dR * dR + dV * dV + dC * dC);
}

// ─── ZeroGMemory ──────────────────────────────────────────────────────────────

export class ZeroGMemory {
  /** Completed records (outcome known) — used for RAG retrieval. */
  private buffer:  DecisionRecord[] = [];
  /** Positions opened but not yet closed — awaiting outcome. */
  private pending: Map<string, DecisionRecord> = new Map();

  private ready   = false;
  private kv:      any = null;
  private batchFn: (() => Promise<any>) | null = null;

  async init(): Promise<void> {
    if (!ZEROG_PRIVATE_KEY) {
      console.log("[ZeroGMemory] ZEROG_PRIVATE_KEY not set — using in-memory fallback");
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sdk = require("@0glabs/0g-ts-sdk/lib.commonjs/index.js") as any;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ethers } = require("ethers") as typeof import("ethers");

      const { KvClient, Indexer, Batcher, getFlowContract } = sdk;

      this.kv = new KvClient(ZEROG_KV_URL);

      const provider = new ethers.JsonRpcProvider(ZEROG_RPC_URL);
      const signer   = new ethers.Wallet(ZEROG_PRIVATE_KEY, provider);
      const flow     = getFlowContract(ZEROG_FLOW_ADDRESS, signer);
      const indexer  = new Indexer(ZEROG_INDEXER_URL);

      this.batchFn = async () => {
        const [nodes, err] = await indexer.selectNodes(1);
        if (err || !nodes?.length) throw new Error(`0G node selection: ${err?.message}`);
        return new Batcher(1, nodes, flow, ZEROG_RPC_URL);
      };

      await this.loadRecent(MAX_IN_MEMORY);
      this.ready = true;
      console.log(`[ZeroGMemory] Connected — ${this.buffer.length} past outcomes loaded from 0G`);
    } catch (err: any) {
      console.warn(`[ZeroGMemory] Init failed, using in-memory: ${err.message}`);
    }
  }

  // ─── Write path ─────────────────────────────────────────────────────────────

  /** Called when a position is opened. Stores the record in the pending map. */
  recordEntry(
    poolId:     string,
    pair:       string,
    chainName:  string,
    conditions: MarketConditions,
    decision:   DecisionSummary,
  ): void {
    this.pending.set(poolId, {
      timestamp: Date.now(),
      pool:      poolId,
      pair,
      chainName,
      conditions,
      decision,
      outcome:   undefined,
    });
  }

  /** Called when a position is closed. Completes the record and persists it. */
  recordExit(poolId: string, outcome: DecisionOutcome): void {
    const record = this.pending.get(poolId);
    if (!record) return;
    this.pending.delete(poolId);

    const completed: DecisionRecord = { ...record, outcome };
    this.buffer.push(completed);
    if (this.buffer.length > MAX_IN_MEMORY) this.buffer.shift();

    if (this.ready && this.batchFn) {
      this.writeToZeroG(completed).catch((err: any) =>
        console.warn(`[ZeroGMemory] Write failed: ${err.message}`)
      );
    }
  }

  // ─── Read path ───────────────────────────────────────────────────────────────

  /**
   * Returns the n completed records whose market conditions are most similar
   * to the supplied query.  The result drives LLM context with real experience.
   */
  getSimilar(conditions: MarketConditions, n: number): DecisionRecord[] {
    if (this.buffer.length === 0) return [];
    return [...this.buffer]
      .sort((a, b) => marketDistance(conditions, a.conditions) - marketDistance(conditions, b.conditions))
      .slice(0, n);
  }

  /** Returns the n most recent completed records (chronological, newest last). */
  getRecent(n = 10): DecisionRecord[] {
    return this.buffer.slice(-n);
  }

  isConnected(): boolean { return this.ready; }

  // ─── 0G I/O ─────────────────────────────────────────────────────────────────

  private async writeToZeroG(record: DecisionRecord): Promise<void> {
    const batcher = await this.batchFn!();
    const key   = timestampKey(record.timestamp);
    const value = Buffer.from(JSON.stringify(record), "utf-8");
    batcher.streamDataBuilder.set(ZEROG_STREAM_ID, key, value);
    const [, err] = await batcher.exec();
    if (err) throw err;
  }

  private async loadRecent(n: number): Promise<void> {
    if (!this.kv) return;
    try {
      const records: DecisionRecord[] = [];
      const last = await this.kv.getLast(ZEROG_STREAM_ID, 0, 4096);
      if (!last?.key) return;

      let cursor = last;
      for (let i = 0; i < n; i++) {
        if (!cursor?.value) break;
        try {
          const raw  = cursor.value?.data ?? cursor.value;
          const rec  = JSON.parse(Buffer.from(raw).toString("utf-8")) as DecisionRecord;
          // Only load completed records (with outcomes) — open records weren't persisted
          if (rec.outcome) records.unshift(rec);
        } catch { /* skip malformed or old-format records */ }
        if (i + 1 < n) {
          cursor = await this.kv.getPrev(ZEROG_STREAM_ID, cursor.key, 0, 4096, false);
          if (!cursor?.key) break;
        }
      }
      this.buffer = records;
    } catch (err: any) {
      console.warn(`[ZeroGMemory] Load failed: ${err.message}`);
    }
  }
}
