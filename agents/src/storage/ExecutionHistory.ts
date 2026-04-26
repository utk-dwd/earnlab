import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

// ─── Schema types ────────────────────────────────────────────────────────────
export type ExecutionAction = "add_liquidity" | "remove_liquidity" | "swap" | "collect_fees";
export type ExecutionStatus = "pending" | "confirmed" | "failed";
export type PositionStatus  = "open" | "closed";

export interface ExecutionRecord {
  id?:            number;
  timestamp:      number;
  chainId:        number;
  chainName:      string;
  poolId:         string;
  token0Symbol:   string;
  token1Symbol:   string;
  feeTier:        number;
  action:         ExecutionAction;
  amountIn:       string;     // bigint serialised as string
  amountOut?:     string;
  txHash?:        string;
  blockNumber?:   number;
  gasUsed?:       string;
  gasCostUsd?:    number;
  apyAtEntry?:    number;
  pnlUsd?:        number;
  slippageBps?:   number;     // actual slippage observed
  status:         ExecutionStatus;
  notes?:         string;
}

export interface PositionRecord {
  id?:             number;
  chainId:         number;
  chainName:       string;
  poolId:          string;
  token0:          string;
  token1:          string;
  token0Symbol:    string;
  token1Symbol:    string;
  feeTier:         number;
  tickLower:       number;
  tickUpper:       number;
  liquidity:       string;   // uint128 as string
  sqrtPriceEntry:  string;   // sqrtPriceX96 as string
  entryValueUsd:   number;
  entryTimestamp:  number;
  fees0Collected:  string;   // cumulative, token0 units
  fees1Collected:  string;
  fees0Usd:        number;
  fees1Usd:        number;
  currentValueUsd: number;
  unrealizedPnlUsd: number;
  realizedAPY:     number;
  status:          PositionStatus;
  closedTimestamp?: number;
  closedValueUsd?:  number;
}

// ─── ExecutionHistory (SQLite-backed) ────────────────────────────────────────
export class ExecutionHistory {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? path.join(process.cwd(), "data", "yield-hunter.db");
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    this.db = new Database(resolvedPath);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS executions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp       INTEGER NOT NULL,
        chain_id        INTEGER NOT NULL,
        chain_name      TEXT    NOT NULL,
        pool_id         TEXT    NOT NULL,
        token0_symbol   TEXT    NOT NULL DEFAULT '',
        token1_symbol   TEXT    NOT NULL DEFAULT '',
        fee_tier        INTEGER NOT NULL DEFAULT 0,
        action          TEXT    NOT NULL,
        amount_in       TEXT    NOT NULL,
        amount_out      TEXT,
        tx_hash         TEXT,
        block_number    INTEGER,
        gas_used        TEXT,
        gas_cost_usd    REAL,
        apy_at_entry    REAL,
        pnl_usd         REAL,
        slippage_bps    INTEGER,
        status          TEXT    NOT NULL DEFAULT 'pending',
        notes           TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_executions_pool ON executions(pool_id);
      CREATE INDEX IF NOT EXISTS idx_executions_chain ON executions(chain_id);
      CREATE INDEX IF NOT EXISTS idx_executions_ts ON executions(timestamp DESC);

      CREATE TABLE IF NOT EXISTS positions (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        chain_id          INTEGER NOT NULL,
        chain_name        TEXT    NOT NULL,
        pool_id           TEXT    NOT NULL,
        token0            TEXT    NOT NULL,
        token1            TEXT    NOT NULL,
        token0_symbol     TEXT    NOT NULL DEFAULT '',
        token1_symbol     TEXT    NOT NULL DEFAULT '',
        fee_tier          INTEGER NOT NULL,
        tick_lower        INTEGER NOT NULL,
        tick_upper        INTEGER NOT NULL,
        liquidity         TEXT    NOT NULL,
        sqrt_price_entry  TEXT    NOT NULL,
        entry_value_usd   REAL    NOT NULL,
        entry_timestamp   INTEGER NOT NULL,
        fees0_collected   TEXT    NOT NULL DEFAULT '0',
        fees1_collected   TEXT    NOT NULL DEFAULT '0',
        fees0_usd         REAL    NOT NULL DEFAULT 0,
        fees1_usd         REAL    NOT NULL DEFAULT 0,
        current_value_usd REAL    NOT NULL DEFAULT 0,
        unrealized_pnl_usd REAL   NOT NULL DEFAULT 0,
        realized_apy      REAL    NOT NULL DEFAULT 0,
        status            TEXT    NOT NULL DEFAULT 'open',
        closed_timestamp  INTEGER,
        closed_value_usd  REAL
      );

      CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
      CREATE INDEX IF NOT EXISTS idx_positions_pool   ON positions(pool_id);
    `);
  }

  // ─── Executions ────────────────────────────────────────────────────────────
  insertExecution(rec: Omit<ExecutionRecord, "id">): number {
    const stmt = this.db.prepare(`
      INSERT INTO executions
        (timestamp, chain_id, chain_name, pool_id, token0_symbol, token1_symbol,
         fee_tier, action, amount_in, amount_out, tx_hash, block_number,
         gas_used, gas_cost_usd, apy_at_entry, pnl_usd, slippage_bps, status, notes)
      VALUES
        (@timestamp, @chainId, @chainName, @poolId, @token0Symbol, @token1Symbol,
         @feeTier, @action, @amountIn, @amountOut, @txHash, @blockNumber,
         @gasUsed, @gasCostUsd, @apyAtEntry, @pnlUsd, @slippageBps, @status, @notes)
    `);
    const info = stmt.run(rec);
    return info.lastInsertRowid as number;
  }

  updateExecution(id: number, patch: Partial<ExecutionRecord>): void {
    const fields = Object.entries(patch)
      .filter(([k]) => k !== "id")
      .map(([k]) => {
        const col = k.replace(/([A-Z])/g, "_$1").toLowerCase();
        return `${col} = @${k}`;
      })
      .join(", ");
    if (!fields) return;
    this.db.prepare(`UPDATE executions SET ${fields} WHERE id = @id`).run({ ...patch, id });
  }

  getExecutions(opts?: {
    chainId?: number;
    poolId?: string;
    action?: ExecutionAction;
    status?: ExecutionStatus;
    limit?: number;
    offset?: number;
  }): ExecutionRecord[] {
    const where: string[] = [];
    const params: Record<string, any> = {};
    if (opts?.chainId) { where.push("chain_id = @chainId"); params.chainId = opts.chainId; }
    if (opts?.poolId)  { where.push("pool_id  = @poolId");  params.poolId  = opts.poolId; }
    if (opts?.action)  { where.push("action   = @action");  params.action  = opts.action; }
    if (opts?.status)  { where.push("status   = @status");  params.status  = opts.status; }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit  = opts?.limit  ?? 100;
    const offset = opts?.offset ?? 0;

    const rows = this.db
      .prepare(`SELECT * FROM executions ${whereClause} ORDER BY timestamp DESC LIMIT ${limit} OFFSET ${offset}`)
      .all(params) as any[];

    return rows.map(rowToExecution);
  }

  // ─── Positions ─────────────────────────────────────────────────────────────
  insertPosition(pos: Omit<PositionRecord, "id">): number {
    const stmt = this.db.prepare(`
      INSERT INTO positions
        (chain_id, chain_name, pool_id, token0, token1, token0_symbol, token1_symbol,
         fee_tier, tick_lower, tick_upper, liquidity, sqrt_price_entry,
         entry_value_usd, entry_timestamp, fees0_collected, fees1_collected,
         fees0_usd, fees1_usd, current_value_usd, unrealized_pnl_usd, realized_apy, status)
      VALUES
        (@chainId, @chainName, @poolId, @token0, @token1, @token0Symbol, @token1Symbol,
         @feeTier, @tickLower, @tickUpper, @liquidity, @sqrtPriceEntry,
         @entryValueUsd, @entryTimestamp, @fees0Collected, @fees1Collected,
         @fees0Usd, @fees1Usd, @currentValueUsd, @unrealizedPnlUsd, @realizedAPY, @status)
    `);
    return this.db.prepare("SELECT last_insert_rowid() as id").get()
      ? (stmt.run(pos).lastInsertRowid as number)
      : 0;
  }

  updatePosition(id: number, patch: Partial<PositionRecord>): void {
    const fieldMap: Record<string, string> = {
      fees0Collected:   "fees0_collected",
      fees1Collected:   "fees1_collected",
      fees0Usd:         "fees0_usd",
      fees1Usd:         "fees1_usd",
      currentValueUsd:  "current_value_usd",
      unrealizedPnlUsd: "unrealized_pnl_usd",
      realizedAPY:      "realized_apy",
      status:           "status",
      closedTimestamp:  "closed_timestamp",
      closedValueUsd:   "closed_value_usd",
    };
    const sets = Object.entries(patch)
      .filter(([k]) => fieldMap[k])
      .map(([k]) => `${fieldMap[k]} = @${k}`)
      .join(", ");
    if (!sets) return;
    this.db.prepare(`UPDATE positions SET ${sets} WHERE id = @id`).run({ ...patch, id });
  }

  getOpenPositions(): PositionRecord[] {
    return (this.db.prepare("SELECT * FROM positions WHERE status = 'open' ORDER BY entry_timestamp DESC").all() as any[])
      .map(rowToPosition);
  }

  getAllPositions(limit = 50): PositionRecord[] {
    return (this.db.prepare("SELECT * FROM positions ORDER BY entry_timestamp DESC LIMIT ?").all(limit) as any[])
      .map(rowToPosition);
  }

  // ─── Aggregate stats ────────────────────────────────────────────────────────
  stats(): {
    totalExecutions: number;
    totalPositions:  number;
    openPositions:   number;
    totalPnlUsd:     number;
    totalFeesUsd:    number;
  } {
    const ex  = this.db.prepare("SELECT COUNT(*) as n, SUM(pnl_usd) as pnl FROM executions WHERE status = 'confirmed'").get() as any;
    const pos = this.db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) as open, SUM(fees0_usd + fees1_usd) as fees FROM positions").get() as any;
    return {
      totalExecutions: ex?.n ?? 0,
      totalPositions:  pos?.total ?? 0,
      openPositions:   pos?.open  ?? 0,
      totalPnlUsd:     ex?.pnl    ?? 0,
      totalFeesUsd:    pos?.fees  ?? 0,
    };
  }

  close(): void {
    this.db.close();
  }
}

// ─── Row mappers ─────────────────────────────────────────────────────────────
function rowToExecution(r: any): ExecutionRecord {
  return {
    id:           r.id,
    timestamp:    r.timestamp,
    chainId:      r.chain_id,
    chainName:    r.chain_name,
    poolId:       r.pool_id,
    token0Symbol: r.token0_symbol,
    token1Symbol: r.token1_symbol,
    feeTier:      r.fee_tier,
    action:       r.action,
    amountIn:     r.amount_in,
    amountOut:    r.amount_out,
    txHash:       r.tx_hash,
    blockNumber:  r.block_number,
    gasUsed:      r.gas_used,
    gasCostUsd:   r.gas_cost_usd,
    apyAtEntry:   r.apy_at_entry,
    pnlUsd:       r.pnl_usd,
    slippageBps:  r.slippage_bps,
    status:       r.status,
    notes:        r.notes,
  };
}

function rowToPosition(r: any): PositionRecord {
  return {
    id:               r.id,
    chainId:          r.chain_id,
    chainName:        r.chain_name,
    poolId:           r.pool_id,
    token0:           r.token0,
    token1:           r.token1,
    token0Symbol:     r.token0_symbol,
    token1Symbol:     r.token1_symbol,
    feeTier:          r.fee_tier,
    tickLower:        r.tick_lower,
    tickUpper:        r.tick_upper,
    liquidity:        r.liquidity,
    sqrtPriceEntry:   r.sqrt_price_entry,
    entryValueUsd:    r.entry_value_usd,
    entryTimestamp:   r.entry_timestamp,
    fees0Collected:   r.fees0_collected,
    fees1Collected:   r.fees1_collected,
    fees0Usd:         r.fees0_usd,
    fees1Usd:         r.fees1_usd,
    currentValueUsd:  r.current_value_usd,
    unrealizedPnlUsd: r.unrealized_pnl_usd,
    realizedAPY:      r.realized_apy,
    status:           r.status,
    closedTimestamp:  r.closed_timestamp,
    closedValueUsd:   r.closed_value_usd,
  };
}
