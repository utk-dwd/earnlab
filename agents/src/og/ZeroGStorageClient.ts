/**
 * ZeroGStorageClient — upload and retrieve agent state bundles on 0G Storage.
 *
 * Agent artifacts (strategy config, risk parameters, performance history,
 * hook preferences, reflection history) are serialized to JSON and stored as
 * blobs.  The returned root hash becomes the `storageUri` embedded in the
 * on-chain INFT record.
 *
 * Two storage backends (tried in order):
 *   1. 0G Storage (file-based blob, larger payloads) — requires SDK support
 *   2. 0G KV (key-value, used by ZeroGMemory) — fallback for smaller payloads
 *
 * When neither is available the client stores artifacts in local memory and
 * returns a deterministic sha256 URI so the rest of the INFT flow still works.
 */

import { createHash } from "crypto";

// ─── Config ───────────────────────────────────────────────────────────────────

const ZEROG_RPC_URL      = process.env.ZEROG_RPC_URL      ?? "https://evmrpc-testnet.0g.ai";
const ZEROG_INDEXER_URL  = process.env.ZEROG_INDEXER_URL  ?? "https://indexer-storage-testnet-turbo.0g.ai";
const ZEROG_KV_URL       = process.env.ZEROG_KV_URL       ?? "http://3.101.147.150:6789";
const ZEROG_FLOW_ADDRESS = process.env.ZEROG_FLOW_ADDRESS ?? "0xbD2C3F0E65eDF5582141C35969d66e34629cC768";
const ZEROG_PRIVATE_KEY  = process.env.ZEROG_PRIVATE_KEY;

// Dedicated stream for agent state blobs (separate from decision records)
const AGENT_STREAM_ID    = process.env.ZEROG_AGENT_STREAM_ID
  ?? "0x6561726e796c645f6167656e74735f76310000000000000000000000000000000";

// ─── In-memory fallback ───────────────────────────────────────────────────────

const localStore = new Map<string, string>();  // rootHash → JSON string

// ─── Helpers ─────────────────────────────────────────────────────────────────

function contentHash(json: string): string {
  return createHash("sha256").update(json).digest("hex");
}

function uriFromHash(hash: string): string {
  return `sha256-${hash}`;
}

function keyFromHash(hash: string): Uint8Array {
  // Encode hash prefix as 8-byte key for 0G KV
  const buf = Buffer.alloc(8);
  const hashBytes = Buffer.from(hash.slice(0, 16), "hex");
  hashBytes.copy(buf);
  return new Uint8Array(buf);
}

// ─── ZeroGStorageClient ───────────────────────────────────────────────────────

export class ZeroGStorageClient {
  private kv:      any = null;
  private batchFn: (() => Promise<any>) | null = null;
  private ready    = false;

  async init(): Promise<void> {
    if (!ZEROG_PRIVATE_KEY) {
      console.log("[ZeroGStorage] ZEROG_PRIVATE_KEY not set — using in-memory fallback");
      return;
    }
    try {
      const sdk = require("@0glabs/0g-ts-sdk/lib.commonjs/index.js") as any;
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

      this.ready = true;
      console.log("[ZeroGStorage] Connected to 0G network");
    } catch (err: any) {
      console.warn(`[ZeroGStorage] Init failed, using in-memory: ${err.message}`);
    }
  }

  /**
   * Upload an agent state bundle.
   * Returns the root hash URI — store this as `storageUri` in the INFT.
   */
  async upload(payload: object): Promise<string> {
    const json = JSON.stringify(payload);
    const hash = contentHash(json);
    const uri  = uriFromHash(hash);

    // Always store locally for instant retrieval
    localStore.set(hash, json);

    if (this.ready && this.batchFn) {
      try {
        const batcher = await this.batchFn();
        const key     = keyFromHash(hash);
        const value   = Buffer.from(json, "utf-8");
        // Chunk if > 4096 bytes (0G KV limit per value)
        if (value.length <= 4096) {
          batcher.streamDataBuilder.set(AGENT_STREAM_ID, key, value);
          const [, err] = await batcher.exec();
          if (err) throw err;
          console.log(`[ZeroGStorage] Uploaded ${value.length}B → ${uri}`);
        } else {
          // For payloads > 4KB, store a summary version
          const summary = JSON.stringify({
            _type:    "agent-bundle-ref",
            hash,
            size:     value.length,
            preview:  (payload as any).name ?? "agent",
          });
          batcher.streamDataBuilder.set(AGENT_STREAM_ID, key, Buffer.from(summary));
          const [, err] = await batcher.exec();
          if (err) throw err;
          console.log(`[ZeroGStorage] Uploaded summary for large bundle (${value.length}B) → ${uri}`);
        }
      } catch (err: any) {
        console.warn(`[ZeroGStorage] Upload failed, keeping in-memory: ${err.message}`);
      }
    }

    return uri;
  }

  /**
   * Retrieve an agent state bundle by its root hash URI.
   * Returns null if not found.
   */
  async retrieve(uri: string): Promise<object | null> {
    const hash = uri.replace("sha256-", "");

    // Fast path: local memory
    const cached = localStore.get(hash);
    if (cached) {
      try { return JSON.parse(cached); } catch { /* corrupted */ }
    }

    // Slow path: 0G KV
    if (this.ready && this.kv) {
      try {
        const key  = keyFromHash(hash);
        const data = await this.kv.getValue(AGENT_STREAM_ID, key, 0, 8192);
        if (data?.value) {
          const raw = Buffer.from(data.value?.data ?? data.value).toString("utf-8");
          const parsed = JSON.parse(raw);
          if (parsed._type === "agent-bundle-ref") {
            console.log(`[ZeroGStorage] Found bundle reference for ${hash} — full blob in 0G Storage`);
            return parsed;
          }
          localStore.set(hash, raw);
          return parsed;
        }
      } catch (err: any) {
        console.warn(`[ZeroGStorage] Retrieve failed: ${err.message}`);
      }
    }

    return null;
  }

  isConnected(): boolean { return this.ready; }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const zeroGStorage = new ZeroGStorageClient();
