/**
 * APYHistoryStore — persists one APY snapshot per pool per hour in SQLite.
 *
 * PRIMARY KEY (pool_id, hour_key) deduplicates naturally: calling record()
 * multiple times within the same clock-hour is a no-op (INSERT OR REPLACE
 * just overwrites with the same data).  This means ~1 row per pool per hour,
 * 168 rows per pool per 7 days, independent of scan frequency.
 *
 * Median query is a simple sorted-array median over the retained window — fast
 * at this cardinality (≤ 168 rows per pool, ≤ ~20 pools in TOP_N).
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_PATH      = path.join(process.cwd(), "data", "apy_history.db");
const RETAIN_HOURS = 8 * 24;   // keep 8 days (small buffer beyond the 7d window)
const WINDOW_HOURS = 7 * 24;   // 168-hour median window
const MIN_SAMPLES  = 6;        // need at least 6h of data before penalising

export class APYHistoryStore {
  private db: Database.Database;

  constructor() {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    this.db = new Database(DB_PATH);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS apy_snapshots (
        pool_id   TEXT    NOT NULL,
        hour_key  INTEGER NOT NULL,
        apy       REAL    NOT NULL,
        PRIMARY KEY (pool_id, hour_key)
      );
      CREATE INDEX IF NOT EXISTS idx_apy_pool ON apy_snapshots(pool_id, hour_key DESC);
    `);
  }

  /** Record current APY for a pool. One row per (pool, hour) — idempotent. */
  record(poolId: string, apy: number): void {
    if (apy <= 0) return;
    const hourKey = Math.floor(Date.now() / 3_600_000);
    this.db
      .prepare("INSERT OR REPLACE INTO apy_snapshots (pool_id, hour_key, apy) VALUES (?, ?, ?)")
      .run(poolId, hourKey, apy);
  }

  /**
   * Median fee APY for this pool over the past 7 days.
   * Returns null when fewer than MIN_SAMPLES hourly buckets are stored
   * (prevents a false "spike" flag during the first hours of data collection).
   */
  getMedian7d(poolId: string): number | null {
    const cutoff = Math.floor(Date.now() / 3_600_000) - WINDOW_HOURS + 1;
    const rows = this.db
      .prepare("SELECT apy FROM apy_snapshots WHERE pool_id = ? AND hour_key >= ? ORDER BY apy ASC")
      .all(poolId, cutoff) as { apy: number }[];

    if (rows.length < MIN_SAMPLES) return null;

    const mid = Math.floor(rows.length / 2);
    return rows.length % 2 === 1
      ? rows[mid].apy
      : (rows[mid - 1].apy + rows[mid].apy) / 2;
  }

  /** Remove snapshots older than RETAIN_HOURS. */
  prune(): void {
    const cutoff = Math.floor(Date.now() / 3_600_000) - RETAIN_HOURS;
    this.db.prepare("DELETE FROM apy_snapshots WHERE hour_key < ?").run(cutoff);
  }
}
