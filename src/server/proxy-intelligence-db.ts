import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openProxyDb } from '../db/proxies/client.js';
import { migrateDomain } from '../db/common/migrate.js';

export type SqlParam = string | number | bigint | Buffer | null | undefined;

export interface ProxyIntelligenceDb {
  exec(sql: string): void;
  all<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): T[];
  get<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): T | undefined;
  run(
    sql: string,
    params?: readonly unknown[],
  ): { changes: number; lastInsertRowid: number | bigint };
  transaction<T>(work: () => T): T;
  close(): void;
  raw?: Database.Database;
}

export function migrateProxyIntelligence(db: ProxyIntelligenceDb): void {
  if (db.raw) {
    migrateDomain(db.raw, 'proxies');
    return;
  }
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS proxies (
        proxy_key TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL,
        protocol TEXT NOT NULL,
        host TEXT,
        port INTEGER,
        status TEXT NOT NULL DEFAULT 'dead',
        latency_ms INTEGER,
        exit_ip TEXT,
        successes INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        checked_at INTEGER NOT NULL DEFAULT 0
      );
    `);

    const columns = db
      .all<{ name: string }>('PRAGMA table_info(proxies)')
      .map((c) => c.name);
    for (const [col, def] of [
      ['host', 'TEXT'],
      ['port', 'INTEGER'],
      ['source', "TEXT NOT NULL DEFAULT 'legacy'"],
      ['lifecycle_state', "TEXT NOT NULL DEFAULT 'unknown'"],
      ['username', 'TEXT'],
      ['password', 'TEXT'],
      ['created_at', 'INTEGER'],
      ['updated_at', 'INTEGER'],
      ['last_verdict', 'TEXT'],
      ['last_checked_at', 'INTEGER'],
      ['last_latency_ms', 'INTEGER'],
      ['last_exit_ip', 'TEXT'],
      ['last_failure_code', 'TEXT'],
      ['ever_passed', 'INTEGER NOT NULL DEFAULT 0'],
      ['is_pinned', 'INTEGER NOT NULL DEFAULT 0'],
      ['tags', "TEXT NOT NULL DEFAULT ''"],
      ['remote_id', 'TEXT'],
      ['router_state', "TEXT NOT NULL DEFAULT 'unmanaged'"],
      ['removed_at', 'INTEGER'],
    ]) {
      if (!columns.includes(col))
        db.exec(`ALTER TABLE proxies ADD COLUMN ${col} ${def};`);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS proxy_test_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proxy_key TEXT NOT NULL,
        tested_at INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        latency_ms INTEGER,
        error_message TEXT,
        FOREIGN KEY (proxy_key) REFERENCES proxies(proxy_key) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_proxy_test_history_key ON proxy_test_history(proxy_key, tested_at DESC);
      DROP TABLE IF EXISTS proxy_audit_risks;
      DROP TABLE IF EXISTS proxy_audits;
      DROP TABLE IF EXISTS audit_jobs;
      DROP TABLE IF EXISTS proxy_diagnostics;
      CREATE INDEX IF NOT EXISTS proxies_lifecycle_idx ON proxies(lifecycle_state);
      CREATE INDEX IF NOT EXISTS proxies_source_idx ON proxies(source);
      CREATE INDEX IF NOT EXISTS proxies_protocol_lifecycle_idx ON proxies(protocol, lifecycle_state);
      CREATE INDEX IF NOT EXISTS proxies_source_lifecycle_idx ON proxies(source, lifecycle_state);
      CREATE INDEX IF NOT EXISTS proxies_last_checked_idx ON proxies(last_checked_at DESC);
    `);

    const fleetCols = db
      .all<{ name: string }>('PRAGMA table_info(fleet_managed_endpoints)')
      .map((c) => c.name);
    if (fleetCols.length > 0) {
      if (!fleetCols.includes('pending_cleanup')) {
        db.exec(
          'ALTER TABLE fleet_managed_endpoints ADD COLUMN pending_cleanup INTEGER NOT NULL DEFAULT 0;',
        );
      }
      if (!fleetCols.includes('owned_exclusive')) {
        db.exec(
          'ALTER TABLE fleet_managed_endpoints ADD COLUMN owned_exclusive INTEGER NOT NULL DEFAULT 1;',
        );
      }
    } else {
      db.exec(`
        CREATE TABLE IF NOT EXISTS fleet_managed_endpoints (
          node_id TEXT NOT NULL,
          endpoint_id TEXT NOT NULL,
          proxy_key TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          pending_cleanup INTEGER NOT NULL DEFAULT 0,
          owned_exclusive INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (node_id, endpoint_id, proxy_key),
          FOREIGN KEY (proxy_key) REFERENCES proxies(proxy_key) ON DELETE CASCADE
        );
      `);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_fleet_managed_proxy_key ON fleet_managed_endpoints(proxy_key);
      CREATE INDEX IF NOT EXISTS idx_fleet_managed_node_id ON fleet_managed_endpoints(node_id);
    `);
  });
}

function sleepSync(delayMs: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

export function configureProxyIntelligenceDb(
  raw: { exec(sql: string): void },
  sleep: (delayMs: number) => void = sleepSync,
): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      raw.exec('PRAGMA journal_mode = WAL;');
      break;
    } catch (error) {
      const sqliteError = error as { code?: string; errcode?: number };
      const retryable =
        sqliteError.code === 'ERR_SQLITE_ERROR' &&
        [5, 6, 1546].includes(sqliteError.errcode ?? 0);
      if (!retryable || attempt >= 2) throw error;
      sleep(25 * 2 ** attempt);
    }
  }
  raw.exec('PRAGMA foreign_keys = ON;');
}

export function openProxyIntelligenceDb(dataDir: string): ProxyIntelligenceDb {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, 'proxies.sqlite3');
  const client = openProxyDb(dbFile);
  const raw = client.raw;

  const db: ProxyIntelligenceDb = {
    exec(sql: string): void {
      raw.exec(sql);
    },
    all<T = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): T[] {
      const stmt = raw.prepare(sql);
      const rows = stmt.all(...params);
      return rows.map((r) =>
        r && typeof r === 'object' ? { ...r } : r,
      ) as T[];
    },
    get<T = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): T | undefined {
      const stmt = raw.prepare(sql);
      const row = stmt.get(...params);
      return (row && typeof row === 'object' ? { ...row } : row) as
        | T
        | undefined;
    },
    run(
      sql: string,
      params: readonly unknown[] = [],
    ): { changes: number; lastInsertRowid: number | bigint } {
      const stmt = raw.prepare(sql);
      const res = stmt.run(...params);
      return {
        changes: Number(res.changes),
        lastInsertRowid: res.lastInsertRowid,
      };
    },
    transaction<T>(work: () => T): T {
      return raw.transaction(work).immediate();
    },
    close(): void {
      client.close();
    },
    raw,
  };

  return db;
}
