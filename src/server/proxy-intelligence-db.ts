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

    if (!columns.includes("host")) {
      db.exec("ALTER TABLE proxies ADD COLUMN host TEXT;");
    }
    if (!columns.includes("port")) {
      db.exec("ALTER TABLE proxies ADD COLUMN port INTEGER;");
    }
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
    if (!columns.includes("last_verdict")) {
      db.exec("ALTER TABLE proxies ADD COLUMN last_verdict TEXT;");
    }
    if (!columns.includes("last_checked_at")) {
      db.exec("ALTER TABLE proxies ADD COLUMN last_checked_at INTEGER;");
    }
    if (!columns.includes("last_latency_ms")) {
      db.exec("ALTER TABLE proxies ADD COLUMN last_latency_ms INTEGER;");
    }
    if (!columns.includes("last_exit_ip")) {
      db.exec("ALTER TABLE proxies ADD COLUMN last_exit_ip TEXT;");
    }
    if (!columns.includes("last_failure_code")) {
      db.exec("ALTER TABLE proxies ADD COLUMN last_failure_code TEXT;");
    }
    if (!columns.includes("ever_passed")) {
      db.exec("ALTER TABLE proxies ADD COLUMN ever_passed INTEGER NOT NULL DEFAULT 0;");
    }
    if (!columns.includes("is_pinned")) {
      db.exec("ALTER TABLE proxies ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;");
    }
    if (!columns.includes("tags")) {
      db.exec("ALTER TABLE proxies ADD COLUMN tags TEXT NOT NULL DEFAULT '';");
    }
    if (!columns.includes("remote_id")) {
      db.exec("ALTER TABLE proxies ADD COLUMN remote_id TEXT;");
    }
    if (!columns.includes("router_state")) {
      db.exec("ALTER TABLE proxies ADD COLUMN router_state TEXT NOT NULL DEFAULT 'unmanaged';");
    }
    if (!columns.includes("removed_at")) {
      db.exec("ALTER TABLE proxies ADD COLUMN removed_at INTEGER;");
    }

    // Create proxy_test_history
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
    `);
    // 3. Drop legacy auditor tables
    db.exec(`
      DROP TABLE IF EXISTS proxy_audit_risks;
      DROP TABLE IF EXISTS proxy_audits;
      DROP TABLE IF EXISTS audit_jobs;
      DROP TABLE IF EXISTS proxy_diagnostics;
    `);

    // 4. Create indexes on proxies
    db.exec(`
      CREATE INDEX IF NOT EXISTS proxies_lifecycle_idx ON proxies(lifecycle_state);
      CREATE INDEX IF NOT EXISTS proxies_source_idx ON proxies(source);
      CREATE INDEX IF NOT EXISTS proxies_protocol_lifecycle_idx ON proxies(protocol, lifecycle_state);
      CREATE INDEX IF NOT EXISTS proxies_source_lifecycle_idx ON proxies(source, lifecycle_state);
      CREATE INDEX IF NOT EXISTS proxies_last_checked_idx ON proxies(last_checked_at DESC);
    `);

    // 5. Create fleet_managed_endpoints mapping table with pending_cleanup & owned_exclusive
    const fleetCols = db.all<{ name: string }>("PRAGMA table_info(fleet_managed_endpoints)").map((c) => c.name);
    if (fleetCols.length > 0) {
      if (!fleetCols.includes("pending_cleanup")) {
        db.exec("ALTER TABLE fleet_managed_endpoints ADD COLUMN pending_cleanup INTEGER NOT NULL DEFAULT 0;");
      }
      if (!fleetCols.includes("owned_exclusive")) {
        db.exec("ALTER TABLE fleet_managed_endpoints ADD COLUMN owned_exclusive INTEGER NOT NULL DEFAULT 1;");
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

export function configureProxyIntelligenceDb(raw: { exec(sql: string): void }, sleep: (delayMs: number) => void = sleepSync): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      raw.exec("PRAGMA journal_mode = WAL;");
      break;
    } catch (error) {
      const sqliteError = error as { code?: string; errcode?: number };
      const retryable = sqliteError.code === "ERR_SQLITE_ERROR" && [5, 6, 1546].includes(sqliteError.errcode ?? 0);
      if (!retryable || attempt >= 2) throw error;
      sleep(25 * 2 ** attempt);
    }
  }
  raw.exec("PRAGMA foreign_keys = ON;");
}

export function openProxyIntelligenceDb(dataDir: string): ProxyIntelligenceDb {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, "proxies.sqlite3");
  const raw = new DatabaseSync(dbFile, { timeout: 3000 });

  // Enable WAL and foreign keys for durability and cascading
  configureProxyIntelligenceDb(raw);

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
