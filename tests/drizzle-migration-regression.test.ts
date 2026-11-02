import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openProxyIntelligenceDb } from "../src/server/proxy-intelligence-db.js";
import { createProxyIntelligenceRepository } from "../src/server/proxy-intelligence-repository.js";

test("drizzle migration regression: proxy repository operations and rollback under Drizzle", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-drizzle-reg-"));
  const db = openProxyIntelligenceDb(dir);
  const repo = createProxyIntelligenceRepository({ db });

  try {
    const summary = await repo.importProxies({
      source: "drizzle-test.txt",
      content: "http://user:pass@127.0.0.1:8080\nsocks5://127.0.0.2:1080",
    });
    assert.equal(summary.inserted, 2);
    assert.equal(summary.invalid, 0);

    const list = await repo.listProxies({ page: 1, pageSize: 10 });
    assert.equal(list.total, 2);

    const item = await repo.getProxy("http://user@127.0.0.1:8080");
    assert.ok(item);
    assert.equal(item.hasAuth, true);
    assert.equal(item.username, "user");

    // Transaction rollback on duplicate or error
    assert.throws(() => {
      db.transaction(() => {
        db.run(
          "INSERT INTO proxies (proxy_key, endpoint, protocol, host, port) VALUES (?, ?, ?, ?, ?)",
          ["fail-test-1", "127.0.0.1:9000", "http", "127.0.0.1", 9000],
        );
        throw new Error("simulated failure inside transaction");
      });
    }, /simulated failure/);

    const checkFailed = await repo.getProxy("fail-test-1");
    assert.equal(checkFailed, null);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
