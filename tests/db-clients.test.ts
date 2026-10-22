import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openFleetDb } from "../src/db/fleet/client.js";
import { openProxyDb } from "../src/db/proxies/client.js";
import { openRotationDb } from "../src/db/rotation/client.js";
import { proxies, proxyTestHistory } from "../src/db/proxies/schema.js";
import { fleetNodes } from "../src/db/fleet/schema.js";
import { accountTurns } from "../src/db/rotation/schema.js";
import { migrateDomain } from "../src/db/common/migrate.js";

test("domain clients preserve records across reopen and roll back foreign key failures", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-checker-drizzle-"));
  const proxy = openProxyDb(path.join(dir, "proxies.sqlite3"));
  const fleet = openFleetDb(path.join(dir, "fleet.sqlite3"));
  const rotation = openRotationDb(path.join(dir, "rotation.sqlite3"));
  try {
    proxy.db
      .insert(proxies)
      .values({
        proxyKey: "http://127.0.0.1:8080",
        endpoint: "127.0.0.1:8080",
        protocol: "http",
        host: "127.0.0.1",
        port: 8080,
      })
      .run();
    assert.throws(
      () =>
        proxy.db.transaction((tx) => {
          tx.insert(proxies)
            .values({
              proxyKey: "rollback",
              endpoint: "127.0.0.1:8081",
              protocol: "http",
            })
            .run();
          tx.insert(proxyTestHistory).values({ proxyKey: "missing", testedAt: 1234, ok: 1 }).run();
        }),
      /FOREIGN KEY|constraint/i,
    );
    assert.deepEqual(proxy.db.select({ key: proxies.proxyKey }).from(proxies).all(), [
      { key: "http://127.0.0.1:8080" },
    ]);
    migrateDomain(fleet.raw, "fleet");
    fleet.db
      .insert(fleetNodes)
      .values({
        id: "controller",
        name: "Controller",
        wireguardIp: "10.77.0.1",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    rotation.db
      .insert(accountTurns)
      .values({ accountId: "account", turnCount: 2, lastActivatedAt: 1234 })
      .run();
  } finally {
    proxy.close();
    fleet.close();
    rotation.close();
  }
  try {
    const reopened = openRotationDb(path.join(dir, "rotation.sqlite3"));
    try {
      assert.deepEqual(reopened.db.select().from(accountTurns).all(), [
        { accountId: "account", turnCount: 2, lastActivatedAt: 1234 },
      ]);
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
