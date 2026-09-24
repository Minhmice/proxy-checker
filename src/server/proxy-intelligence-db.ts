import fs from "node:fs";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";

export type SqlParam = SQLInputValue;

export interface ProxyIntelligenceDb {
  exec(sql: string): void;
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T[];
  get<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T | undefined;
  run(sql: string, params?: readonly unknown[]): { changes: number; lastInsertRowid: number | bigint };
  transaction<T>(work: () => T): T;
  close(): void;
}

export function migrateProxyIntelligence(db: ProxyIntelligenceDb): void {
  db.transaction(() => {
    // 1. Ensure proxies table exists if starting from completely empty DB
    db.exec(`
      CREATE TABLE IF NOT EXISTS proxies (
        proxy_key TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL,
        protocol TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'dead',
        latency_ms INTEGER,
        exit_ip TEXT,
        successes INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        checked_at INTEGER NOT NULL DEFAULT 0
      );
    `);

    // 2. Add additive columns to proxies if not present
    const columns = db.all<{ name: string }>("PRAGMA table_info(proxies)").map((c) => c.name);

    if (!columns.includes("source")) {
      db.exec("ALTER TABLE proxies ADD COLUMN source TEXT NOT NULL DEFAULT 'legacy';");
    }
    if (!columns.includes("lifecycle_state")) {
      db.exec("ALTER TABLE proxies ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'unknown';");
    }
    if (!columns.includes("username")) {
      db.exec("ALTER TABLE proxies ADD COLUMN username TEXT;");
    }
    if (!columns.includes("password")) {
      db.exec("ALTER TABLE proxies ADD COLUMN password TEXT;");
    }
    if (!columns.includes("created_at")) {
      db.exec("ALTER TABLE proxies ADD COLUMN created_at INTEGER;");
    }
    if (!columns.includes("updated_at")) {
      db.exec("ALTER TABLE proxies ADD COLUMN updated_at INTEGER;");
    }

    // 3. Create proxy_diagnostics table
    db.exec(`
      CREATE TABLE IF NOT EXISTS proxy_diagnostics (
        id TEXT PRIMARY KEY,
        proxy_key TEXT NOT NULL REFERENCES proxies(proxy_key) ON DELETE CASCADE,
        status TEXT NOT NULL,
        latency_ms INTEGER,
        error_code TEXT,
        error_message TEXT,
        checked_at INTEGER NOT NULL
      );
    `);

    // 4. Create proxy_audits table
    db.exec(`
      CREATE TABLE IF NOT EXISTS proxy_audits (
        id TEXT PRIMARY KEY,
        proxy_key TEXT NOT NULL REFERENCES proxies(proxy_key) ON DELETE CASCADE,
        verdict TEXT NOT NULL,
        lifecycle_state TEXT NOT NULL,
        overall_score REAL,
        transport_score REAL,
        privacy_score REAL,
        reputation_score REAL,
        reliability_score REAL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        result_json TEXT NOT NULL
      );
    `);

    // 5. Create proxy_audit_risks table
    db.exec(`
      CREATE TABLE IF NOT EXISTS proxy_audit_risks (
        id TEXT PRIMARY KEY,
        audit_id TEXT NOT NULL REFERENCES proxy_audits(id) ON DELETE CASCADE,
        risk_code TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        explanation TEXT NOT NULL
      );
    `);

    // 6. Create indexes
    db.exec(`
      CREATE INDEX IF NOT EXISTS proxy_diagnostics_proxy_checked_idx ON proxy_diagnostics(proxy_key, checked_at DESC);
      CREATE INDEX IF NOT EXISTS proxy_audits_proxy_finished_idx ON proxy_audits(proxy_key, finished_at DESC);
      CREATE INDEX IF NOT EXISTS proxy_audits_verdict_idx ON proxy_audits(verdict, lifecycle_state);
      CREATE INDEX IF NOT EXISTS proxies_lifecycle_idx ON proxies(lifecycle_state);
      CREATE INDEX IF NOT EXISTS proxies_source_idx ON proxies(source);
    `);
  });
}

export function openProxyIntelligenceDb(dataDir: string): ProxyIntelligenceDb {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, "proxies.sqlite3");
  const raw = new DatabaseSync(dbFile);

  // Enable WAL and foreign keys for durability and cascading
  raw.exec("PRAGMA journal_mode = WAL;");
  raw.exec("PRAGMA foreign_keys = ON;");

  const db: ProxyIntelligenceDb = {
    exec(sql: string): void {
      raw.exec(sql);
    },
    all<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): T[] {
      const stmt = raw.prepare(sql);
      const rows = stmt.all(...(params as readonly SQLInputValue[]));
      return rows.map((r) => (r && typeof r === "object" ? { ...r } : r)) as T[];
    },
    get<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): T | undefined {
      const stmt = raw.prepare(sql);
      const row = stmt.get(...(params as readonly SQLInputValue[]));
      return (row && typeof row === "object" ? { ...row } : row) as T | undefined;
    },
    run(sql: string, params: readonly unknown[] = []): { changes: number; lastInsertRowid: number | bigint } {
      const stmt = raw.prepare(sql);
      const res = stmt.run(...(params as readonly SQLInputValue[]));
      return {
        changes: Number(res.changes),
        lastInsertRowid: res.lastInsertRowid,
      };
    },
    transaction<T>(work: () => T): T {
      raw.exec("BEGIN IMMEDIATE;");
      try {
        const result = work();
        raw.exec("COMMIT;");
        return result;
      } catch (err) {
        raw.exec("ROLLBACK;");
        throw err;
      }
    },
    close(): void {
      raw.close();
    },
  };

  migrateProxyIntelligence(db);
  return db;
}
