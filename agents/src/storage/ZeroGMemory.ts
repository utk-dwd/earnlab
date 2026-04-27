/**
 * Persists LLM decision records to 0G decentralised KV storage.
 * Falls back to an in-memory ring buffer when ZEROG_* env vars are absent.
 *
 * 0G KV layout
 *   stream: ZEROG_STREAM_ID  (defaults to a fixed test stream)
 *   key:    8-byte big-endian unix timestamp (ms) — sortable, no collisions
 *   value:  JSON-encoded DecisionRecord
 */

export interface DecisionRecord {
  timestamp:  number;
  action:     "open" | "close" | "hold";
  poolId?:    string;
  pair?:      string;
  chainName?: string;
  apy?:       number;
  rar7d?:     number;
  reasoning:  string;
}

const MAX_IN_MEMORY = 50;

// 0G testnet defaults — override via env
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

export class ZeroGMemory {
  private buffer: DecisionRecord[] = [];
  private ready = false;
  private kv:      any = null;
  private batchFn: (() => Promise<any>) | null = null;

  async init(): Promise<void> {
    if (!ZEROG_PRIVATE_KEY) {
      console.log("[ZeroGMemory] ZEROG_PRIVATE_KEY not set — using in-memory fallback");
      return;
    }
    try {
      // Require the CJS build directly to bypass moduleResolution: node limitation
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
        if (err || !nodes?.length) throw new Error(`0G node selection failed: ${err?.message}`);
        return new Batcher(1, nodes, flow, ZEROG_RPC_URL);
      };

      await this.loadRecent(MAX_IN_MEMORY);
      this.ready = true;
      console.log(`[ZeroGMemory] Connected — ${this.buffer.length} decisions loaded from 0G`);
    } catch (err: any) {
      console.warn(`[ZeroGMemory] Init failed, using in-memory fallback: ${err.message}`);
    }
  }

  async append(record: DecisionRecord): Promise<void> {
    this.buffer.push(record);
    if (this.buffer.length > MAX_IN_MEMORY) this.buffer.shift();

    if (!this.ready || !this.batchFn) return;

    // fire-and-forget — don't block the portfolio tick
    this.writeToZeroG(record).catch((err: any) =>
      console.warn(`[ZeroGMemory] Write failed: ${err.message}`)
    );
  }

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
          const raw = cursor.value?.data ?? cursor.value;
          records.unshift(JSON.parse(Buffer.from(raw).toString("utf-8")));
        } catch { /* skip malformed */ }
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

  getRecent(n = 10): DecisionRecord[] {
    return this.buffer.slice(-n);
  }

  isConnected(): boolean { return this.ready; }
}
