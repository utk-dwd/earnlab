import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

export interface Reflection {
  id:        number;
  timestamp: number;
  content:   string;
  summary:   string;  // 1-line compact version included in future prompts
  archived:  boolean;
}

const RECENT_DAYS = 5;

export class ReflectionStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const p = dbPath ?? path.join(process.cwd(), "data", "reflections.db");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    this.db = new Database(p);
    this.migrate();
    this.archiveOld();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reflections (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        content   TEXT    NOT NULL,
        summary   TEXT    NOT NULL DEFAULT '',
        archived  INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_ref_ts ON reflections(timestamp DESC);
    `);
  }

  insert(content: string, summary: string): number {
    return this.db
      .prepare("INSERT INTO reflections (timestamp, content, summary, archived) VALUES (?, ?, ?, 0)")
      .run(Date.now(), content, summary)
      .lastInsertRowid as number;
  }

  archiveOld(): void {
    const cutoff = Date.now() - RECENT_DAYS * 86_400_000;
    this.db.prepare("UPDATE reflections SET archived = 1 WHERE timestamp < ? AND archived = 0").run(cutoff);
  }

  getRecent(): Reflection[] {
    const cutoff = Date.now() - RECENT_DAYS * 86_400_000;
    return (this.db
      .prepare("SELECT * FROM reflections WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT 200")
      .all(cutoff) as any[])
      .map(rowToReflection);
  }

  getArchived(limit = 50): Reflection[] {
    const cutoff = Date.now() - RECENT_DAYS * 86_400_000;
    return (this.db
      .prepare("SELECT * FROM reflections WHERE timestamp < ? ORDER BY timestamp DESC LIMIT ?")
      .all(cutoff, limit) as any[])
      .map(rowToReflection);
  }

  // Returns last N reflections as a compact newline-joined string for LLM context
  getCompactMemory(n = 15): string {
    const rows = this.db
      .prepare("SELECT timestamp, summary FROM reflections ORDER BY timestamp DESC LIMIT ?")
      .all(n) as any[];
    return rows
      .reverse()
      .map((r: any) => {
        const d = new Date(r.timestamp);
        const label = d.toLocaleString("en", {
          month: "short", day: "numeric",
          hour: "2-digit", minute: "2-digit",
        });
        return `[${label}] ${r.summary}`;
      })
      .join("\n");
  }

  close(): void { this.db.close(); }
}

function rowToReflection(r: any): Reflection {
  return {
    id:       r.id,
    timestamp: r.timestamp,
    content:  r.content,
    summary:  r.summary,
    archived: r.archived === 1,
  };
}
