import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { migrateDomain } from "../src/db/common/migrate.js";
import { openProxyIntelligenceDb } from "../src/server/proxy-intelligence-db.js";
import { createProxyIntelligenceRepository } from "../src/server/proxy-intelligence-repository.js";

test("migration preserves legacy quick sync proxies rows without corruption", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-migration-reg-"));
  try {
    const dbFile = path.join(tmpDir, "proxies.sqlite3");
    const { DatabaseSync } = require("node:sqlite");
    const raw = new DatabaseSync(dbFile);

    // Populate with 10 legacy sync proxies
    raw.exec(`
      CREATE TABLE proxies (
        proxy_key TEXT PRIMARY KEY, endpoint TEXT, protocol TEXT, status TEXT, exit_ip TEXT,
        latency_ms INTEGER, checked_at REAL, successes INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0, last_error TEXT
      );
    `);

    for (let i = 1; i <= 10; i++) {
      raw
        .prepare(
          "INSERT INTO proxies (proxy_key, endpoint, protocol, status, successes, failures) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(`key-${i}`, `10.0.0.${i}:8080`, "http", i % 2 === 0 ? "usable" : "dead", i, 0);
    }
    raw.close();

    // Run migration
    const db = openProxyIntelligenceDb(tmpDir);
    const count = db.get<{ count: number }>("SELECT COUNT(*) AS count FROM proxies")?.count;
    assert.equal(count, 10);

    // Verify fields preserved
    const row2 = db.get<{
      status: string;
      successes: number;
      source: string;
      lifecycle_state: string;
    }>("SELECT status, successes, source, lifecycle_state FROM proxies WHERE proxy_key = 'key-2'");
    assert.equal(row2?.status, "usable");
    assert.equal(row2?.successes, 2);
    assert.equal(row2?.source, "legacy");
    assert.equal(row2?.lifecycle_state, "unknown");

    db.close();
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {}
  }
});

test("migration removes legacy fleet mappings without losing proxy rows or test history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-fleet-migration-"));
  const raw = new Database(path.join(dir, "proxies.sqlite3"));
  try {
    raw.pragma("foreign_keys = ON");
    raw.exec(`
      CREATE TABLE proxies (
        proxy_key TEXT PRIMARY KEY NOT NULL, endpoint TEXT NOT NULL, protocol TEXT NOT NULL,
        host TEXT, port INTEGER, status TEXT NOT NULL DEFAULT 'dead',
        source TEXT NOT NULL DEFAULT 'legacy', username TEXT, password TEXT,
        remote_id TEXT, router_state TEXT NOT NULL DEFAULT 'unmanaged'
      );
      CREATE TABLE proxy_test_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, proxy_key TEXT NOT NULL,
        tested_at INTEGER NOT NULL, ok INTEGER NOT NULL, latency_ms INTEGER, error_message TEXT,
        FOREIGN KEY (proxy_key) REFERENCES proxies(proxy_key) ON DELETE CASCADE
      );
      CREATE TABLE fleet_managed_endpoints (
        node_id TEXT NOT NULL, endpoint_id TEXT NOT NULL, proxy_key TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, pending_cleanup INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (node_id, endpoint_id, proxy_key),
        FOREIGN KEY (proxy_key) REFERENCES proxies(proxy_key) ON DELETE CASCADE
      );
      INSERT INTO proxies (proxy_key, endpoint, protocol, host, port, status, source, username, password, remote_id, router_state)
      VALUES
        ('http://fleet@192.0.2.1:8080', '192.0.2.1:8080', 'http', '192.0.2.1', 8080, 'usable', 'fleet', 'fleet', 'secret', 'pool-1', 'managed'),
        ('socks5://192.0.2.2:1080', '192.0.2.2:1080', 'socks5', '192.0.2.2', 1080, 'dead', 'manual', NULL, NULL, NULL, 'unmanaged');
      INSERT INTO proxy_test_history (id, proxy_key, tested_at, ok, latency_ms)
      VALUES (17, 'http://fleet@192.0.2.1:8080', 1727800000000, 1, 85);
      INSERT INTO fleet_managed_endpoints (node_id, endpoint_id, proxy_key, created_at, updated_at)
      VALUES ('node-1', 'endpoint-1', 'http://fleet@192.0.2.1:8080', 1, 2);
    `);
  } finally {
    raw.close();
  }

  try {
    // Opening twice exercises both the upgrade and its idempotent restart path.
    for (let attempt = 0; attempt < 2; attempt++) {
      const db = openProxyIntelligenceDb(dir);
      try {
        assert.deepEqual(
          db.all(
            "SELECT proxy_key, endpoint, protocol, host, port, status, source, username, password, remote_id, router_state FROM proxies ORDER BY proxy_key",
          ),
          [
            {
              proxy_key: "http://fleet@192.0.2.1:8080",
              endpoint: "192.0.2.1:8080",
              protocol: "http",
              host: "192.0.2.1",
              port: 8080,
              status: "usable",
              source: "fleet",
              username: "fleet",
              password: "secret",
              remote_id: "pool-1",
              router_state: "managed",
            },
            {
              proxy_key: "socks5://192.0.2.2:1080",
              endpoint: "192.0.2.2:1080",
              protocol: "socks5",
              host: "192.0.2.2",
              port: 1080,
              status: "dead",
              source: "manual",
              username: null,
              password: null,
              remote_id: null,
              router_state: "unmanaged",
            },
          ],
        );
        assert.deepEqual(
          db.all("SELECT id, proxy_key, tested_at, ok, latency_ms FROM proxy_test_history"),
          [
            {
              id: 17,
              proxy_key: "http://fleet@192.0.2.1:8080",
              tested_at: 1727800000000,
              ok: 1,
              latency_ms: 85,
            },
          ],
        );
        assert.equal(
          db.get(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'fleet_managed_endpoints'",
          ),
          undefined,
        );
      } finally {
        db.close();
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("proxy migration accepts known historical checksums and preserves rows", () => {
  for (const oldHash of [
    "6ff2ebf85ff6352ee05cdb87b96e853c2bdd5e30e0a3e16bf4f2d9d1f6e95d18",
    "2cebf267498c06de738c51c86366bbc1e62cf0ca9e487e2f1cffa4c94d33ff84",
    "fa2e8bd35d94b56acdbb56002b9ff7b7c86bacb1240df682a82ad841885b5da0",
  ]) {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE proxies (proxy_key TEXT PRIMARY KEY NOT NULL, endpoint TEXT NOT NULL, protocol TEXT NOT NULL);
        INSERT INTO proxies VALUES ('p', '192.0.2.1:8080', 'http');
        CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC NOT NULL);
      `);
      db.prepare("INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, 1)").run(oldHash);
      migrateDomain(db, "proxies");
      assert.deepEqual(db.prepare("SELECT proxy_key, endpoint, protocol FROM proxies").get(), {
        proxy_key: "p",
        endpoint: "192.0.2.1:8080",
        protocol: "http",
      });
      assert.deepEqual(db.prepare("SELECT hash FROM __drizzle_migrations").get(), {
        hash: "2cebf267498c06de738c51c86366bbc1e62cf0ca9e487e2f1cffa4c94d33ff84",
      });
    } finally {
      db.close();
    }
  }
});

test("proxy migration rejects an unknown checksum without changing stored rows", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE proxies (proxy_key TEXT PRIMARY KEY NOT NULL, endpoint TEXT NOT NULL, protocol TEXT NOT NULL);
      INSERT INTO proxies VALUES ('p', '192.0.2.1:8080', 'http');
      CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC NOT NULL);
      INSERT INTO __drizzle_migrations(hash, created_at) VALUES ('unrecognized', 1);
    `);
    assert.throws(() => migrateDomain(db, "proxies"), /Migration checksum mismatch: proxies/);
    assert.deepEqual(db.prepare("SELECT proxy_key, endpoint, protocol FROM proxies").get(), {
      proxy_key: "p",
      endpoint: "192.0.2.1:8080",
      protocol: "http",
    });
    assert.deepEqual(db.prepare("SELECT hash FROM __drizzle_migrations").get(), {
      hash: "unrecognized",
    });
    const columns = db.prepare<[], { name: string }>("PRAGMA table_info(proxies)").all();
    assert.deepEqual(
      columns.map((column) => column.name),
      ["proxy_key", "endpoint", "protocol"],
    );
  } finally {
    db.close();
  }
});

test("proxy migration rejects unknown tables and columns without deleting data", () => {
  for (const invalid of [
    {
      sql: "CREATE TABLE unexpected (id INTEGER PRIMARY KEY); INSERT INTO unexpected VALUES (7)",
      error: /Unknown proxies database table: unexpected/,
      query: "SELECT id FROM unexpected",
      value: { id: 7 },
    },
    {
      sql: "ALTER TABLE proxies ADD COLUMN unexpected TEXT; UPDATE proxies SET unexpected = 'keep'",
      error: /Unknown column in proxies: unexpected/,
      query: "SELECT unexpected FROM proxies",
      value: { unexpected: "keep" },
    },
  ]) {
    const db = new Database(":memory:");
    try {
      db.exec(
        "CREATE TABLE proxies (proxy_key TEXT PRIMARY KEY NOT NULL, endpoint TEXT NOT NULL, protocol TEXT NOT NULL); INSERT INTO proxies VALUES ('p', '192.0.2.1:8080', 'http')",
      );
      db.exec(invalid.sql);
      assert.throws(() => migrateDomain(db, "proxies"), invalid.error);
      assert.deepEqual(db.prepare(invalid.query).get(), invalid.value);
    } finally {
      db.close();
    }
  }
});
