import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_PATH = path.join(process.cwd(), "data", "snapshots.db");

export class SnapshotStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? DB_PATH;
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    this.db = new Database(resolvedPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        key        TEXT    PRIMARY KEY,
        updated_at INTEGER NOT NULL,
        value      TEXT    NOT NULL
      );
    `);
  }

  save<T>(key: string, value: T): void {
    this.db
      .prepare(`
        INSERT INTO snapshots (key, updated_at, value)
        VALUES (@key, @updatedAt, @value)
        ON CONFLICT(key) DO UPDATE SET
          updated_at = excluded.updated_at,
          value = excluded.value
      `)
      .run({
        key,
        updatedAt: Date.now(),
        value: JSON.stringify(value),
      });
  }

  load<T>(key: string): T | null {
    const row = this.db
      .prepare("SELECT value FROM snapshots WHERE key = ?")
      .get(key) as { value: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.value) as T;
  }

  close(): void {
    this.db.close();
  }
}
