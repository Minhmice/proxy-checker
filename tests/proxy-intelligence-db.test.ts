import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  configureProxyIntelligenceDb,
  openProxyIntelligenceDb,
  migrateProxyIntelligence,
} from "../src/server/proxy-intelligence-db.js";

test("migrates a fresh database with inventory and audit tables", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fresh-db-"));
  const db = openProxyIntelligenceDb(dir);
  try {
    const columns = db.all<{ name: string }>("PRAGMA table_info(proxies)");
    const names = columns.map((col) => col.name);
    assert.ok(names.includes("source"));
    assert.ok(names.includes("lifecycle_state"));
    assert.ok(names.includes("username"));
    assert.ok(names.includes("password"));
    assert.ok(names.includes("created_at"));
    assert.ok(names.includes("updated_at"));
    assert.equal(
      db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='proxy_audits'",
      ).length,
      0,
    );
    assert.equal(
      db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='proxy_diagnostics'",
      ).length,
      0,
    );
    assert.equal(
      db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='proxy_audit_risks'",
      ).length,
      0,
    );

    // Idempotency: migrate again without throwing
    assert.doesNotThrow(() => {
      migrateProxyIntelligence(db);
    });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("retries transient SQLite I/O while enabling WAL", () => {
  let attempts = 0;
  const waits: number[] = [];
  const raw = {
    exec() {
      attempts += 1;
      if (attempts < 3) {
        const error = Object.assign(new Error("disk I/O error"), {
          code: "ERR_SQLITE_ERROR",
          errcode: 1546,
        });
        throw error;
      }
    },
  };

  configureProxyIntelligenceDb(raw, (delayMs) => waits.push(delayMs));

  assert.equal(attempts, 4);
  assert.deepEqual(waits, [25, 50]);
});

test("preserves legacy rows and is idempotent across reopen", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-legacy-db-"));
  const dbPath = path.join(dir, "proxies.sqlite3");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE proxies (
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
  legacy
    .prepare(
      "INSERT INTO proxies (proxy_key, endpoint, protocol, host, port, status, successes, failures) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run("legacy-key", "http://127.0.0.1:8080", "http", "127.0.0.1", 8080, "usable", 3, 1);
  legacy.close();

  const db = openProxyIntelligenceDb(dir);
  try {
    const migrated = db.get<{
      proxy_key: string;
      source: string;
      lifecycle_state: string;
      successes: number;
    }>(
      "SELECT proxy_key, source, lifecycle_state, successes FROM proxies WHERE proxy_key = 'legacy-key'",
    );
    assert.deepEqual(migrated, {
      proxy_key: "legacy-key",
      source: "legacy",
      lifecycle_state: "unknown",
      successes: 3,
    });

    const countBefore = db.get<{ count: number }>("SELECT COUNT(*) AS count FROM proxies")?.count;

    // Opening the same DB runs migration a second time.
    db.close();
    const reopened = openProxyIntelligenceDb(dir);
    try {
      assert.equal(
        reopened.get<{ count: number }>("SELECT COUNT(*) AS count FROM proxies")?.count,
        countBefore,
      );
      assert.equal(
        reopened.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='proxy_audits'",
        ).length,
        0,
      );
    } finally {
      reopened.close();
    }
  } finally {
    try {
      db.close();
    } catch {
      // closed above
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
