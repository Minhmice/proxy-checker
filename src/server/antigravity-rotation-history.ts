import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { openRotationDb } from '../db/rotation/client.js';
import { accountTurns } from '../db/rotation/schema.js';

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

export function openAntigravityRotationHistory(
  dataDir: string,
): AntigravityRotationHistory {
  fs.mkdirSync(dataDir, { recursive: true });
  const client = openRotationDb(
    path.join(dataDir, 'antigravity-rotation.sqlite3'),
  );
  client.raw.exec(`
    CREATE TABLE IF NOT EXISTS antigravity_account_turns (
      account_id TEXT PRIMARY KEY,
      turn_count INTEGER NOT NULL DEFAULT 0,
      last_activated_at INTEGER
    )
  `);
  return {
    get(accountId) {
      const row = client.db
        .select()
        .from(accountTurns)
        .where(eq(accountTurns.accountId, accountId))
        .get();
      return row
        ? {
            accountId: row.accountId,
            turnCount: row.turnCount,
            lastActivatedAt: row.lastActivatedAt,
          }
        : undefined;
    },
    recordActivation(accountId, activatedAt) {
      client.db
        .insert(accountTurns)
        .values({ accountId, turnCount: 1, lastActivatedAt: activatedAt })
        .onConflictDoUpdate({
          target: accountTurns.accountId,
          set: {
            turnCount: sql`${accountTurns.turnCount} + 1`,
            lastActivatedAt: activatedAt,
          },
        })
        .run();
      const turn = this.get(accountId);
      if (!turn)
        throw new Error(
          `Rotation history missing after activation: ${accountId}`,
        );
      return turn;
    },
    close() {
      client.close();
    },
  };
}
