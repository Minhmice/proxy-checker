import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface AntigravityTurn {
  accountId: string;
  turnCount: number;
  lastActivatedAt: number | null;
}

export interface AntigravityRotationHistory {
  get(accountId: string): AntigravityTurn | undefined;
  recordActivation(accountId: string, activatedAt: number): AntigravityTurn;
  close(): void;
}

export function openAntigravityRotationHistory(dataDir: string): AntigravityRotationHistory {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "antigravity-rotation.sqlite3"), { timeout: 3000 });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS antigravity_account_turns (
      account_id TEXT PRIMARY KEY,
      turn_count INTEGER NOT NULL DEFAULT 0,
      last_activated_at INTEGER
    )
  `);

  return {
    get(accountId: string): AntigravityTurn | undefined {
      const row = db.prepare(`
        SELECT account_id AS accountId, turn_count AS turnCount, last_activated_at AS lastActivatedAt
        FROM antigravity_account_turns WHERE account_id = ?
      `).get(accountId) as AntigravityTurn | undefined;
      return row;
    },
    recordActivation(accountId: string, activatedAt: number): AntigravityTurn {
      db.prepare(`
        INSERT INTO antigravity_account_turns(account_id, turn_count, last_activated_at)
        VALUES (?, 1, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          turn_count = antigravity_account_turns.turn_count + 1,
          last_activated_at = excluded.last_activated_at
      `).run(accountId, activatedAt);
      return this.get(accountId)!;
    },
    close(): void {
      db.close();
    },
  };
}