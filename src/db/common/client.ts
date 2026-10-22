import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  drizzle,
  type BetterSQLite3Database,
} from 'drizzle-orm/better-sqlite3';

export interface SqliteClient<TSchema extends Record<string, unknown>> {
  db: BetterSQLite3Database<TSchema>;
  raw: Database.Database;
  close(): void;
}

export function openSqlite<TSchema extends Record<string, unknown>>(
  filePath: string,
  schema: TSchema,
  synchronous = 'NORMAL',
): SqliteClient<TSchema> {
  if (filePath !== ':memory:')
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const raw = new Database(filePath, { timeout: 3000 });
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma(`synchronous = ${synchronous}`);
  const db = drizzle(raw, { schema });
  return { db, raw, close: () => raw.close() };
}
