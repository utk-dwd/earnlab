import { createHash } from "crypto";

/**
 * ZeroGStorage — mock 0G content-addressed storage.
 * CID is sha256(canonical JSON) — purely deterministic.
 * Since seeker verifies by re-hashing the data it received from executor,
 * no shared state needed between processes.
 *
 * In production: store to 0G network, retrieve by CID, verify against hash.
 */
export class ZeroGStorage {
  static computeCid(data: object): string {
    const json = JSON.stringify(data, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v
    );
    return "0g:" + createHash("sha256").update(json).digest("hex").slice(0, 40);
  }

  /** Store data, return content-addressed CID */
  async store(data: object): Promise<string> {
    const cid = ZeroGStorage.computeCid(data);
    // In production: POST to 0G Storage endpoint, await confirmation
    console.log(`[0G Storage] Stored ${cid.slice(0, 20)}...`);
    return cid;
  }

  /**
   * Verify that `data` matches `cid`.
   * Works cross-process because CIDs are deterministic hashes.
   */
  async verify(cid: string, data: object): Promise<boolean> {
    const expected = ZeroGStorage.computeCid(data);
    const ok = cid === expected;
    console.log(`[0G Storage] Verify ${cid.slice(0, 20)}... → ${ok ? "✓" : "✗"}`);
    return ok;
  }
}
