import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
      raw.prepare(
        "INSERT INTO proxies (proxy_key, endpoint, protocol, status, successes, failures) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(`key-${i}`, `10.0.0.${i}:8080`, "http", i % 2 === 0 ? "usable" : "dead", i, 0);
    }
    raw.close();

    // Run migration
    const db = openProxyIntelligenceDb(tmpDir);
    const count = db.get<{ count: number }>("SELECT COUNT(*) AS count FROM proxies")?.count;
    assert.equal(count, 10);

    // Verify fields preserved
    const row2 = db.get<{ status: string; successes: number; source: string; lifecycle_state: string }>(
      "SELECT status, successes, source, lifecycle_state FROM proxies WHERE proxy_key = 'key-2'"
    );
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
