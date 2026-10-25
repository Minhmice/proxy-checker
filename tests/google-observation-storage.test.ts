import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { migrateDomain } from "../src/db/common/migrate.js";

test("proxy observation schema upgrades known baseline without losing existing proxy", () => {
  const db = new Database(":memory:");
  db.exec(fs.readFileSync("src/db/migrations/proxies/0000_baseline.sql", "utf8"));
  db.exec(
    "CREATE TABLE __drizzle_migrations(id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC NOT NULL)",
  );
  db.prepare("INSERT INTO __drizzle_migrations(hash,created_at) VALUES(?,1)").run(
    "6ff2ebf85ff6352ee05cdb87b96e853c2bdd5e30e0a3e16bf4f2d9d1f6e95d18",
  );
  db.prepare("INSERT INTO proxies(proxy_key,endpoint,protocol) VALUES(?,?,?)").run(
    "p",
    "127.0.0.1:8080",
    "http",
  );
  try {
    migrateDomain(db, "proxies");
    assert.equal(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM proxies").get()?.n, 1);
    db.prepare(
      "INSERT INTO google_transport_observations(router_url,proxy_pool_id,endpoint,pool_revision,status,checked_at,expires_at) VALUES(?,?,?,?,?,?,?)",
    ).run("http://a", "pool-a", "https://daily-cloudcode-pa.googleapis.com", 1, "passed", 100, 200);
    migrateDomain(db, "proxies");
    assert.equal(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM google_transport_observations").get()
        ?.n,
      1,
    );
  } finally {
    db.close();
  }
});
