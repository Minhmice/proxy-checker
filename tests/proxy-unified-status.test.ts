import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openProxyIntelligenceDb } from "../src/server/proxy-intelligence-db.js";
import { createProxyIntelligenceRepository } from "../src/server/proxy-intelligence-repository.js";

test("computes working, dead, and regressed proxy statuses accurately", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-status-test-"));
  try {
    const db = openProxyIntelligenceDb(tmpDir);
    const repo = createProxyIntelligenceRepository({ db });

    // 1. Insert 3 test proxies
    // Proxy 1: Usable -> working
    db.run(
      `INSERT INTO proxies (proxy_key, endpoint, protocol, host, port, status, exit_ip, latency_ms, successes, failures, source, lifecycle_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "p1",
        "10.0.0.1:8080",
        "http",
        "10.0.0.1",
        8080,
        "usable",
        "1.1.1.1",
        120,
        5,
        0,
        "test",
        "working",
      ],
    );

    // Proxy 2: Dead with 0 successes, 0 audit passes -> dead
    db.run(
      `INSERT INTO proxies (proxy_key, endpoint, protocol, host, port, status, exit_ip, latency_ms, successes, failures, source, lifecycle_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["p2", "10.0.0.2:8080", "socks5", "10.0.0.2", 8080, "dead", null, null, 0, 3, "test", "dead"],
    );

    // Proxy 3: Dead with past successes > 0 -> regressed
    db.run(
      `INSERT INTO proxies (proxy_key, endpoint, protocol, host, port, status, exit_ip, latency_ms, successes, failures, source, lifecycle_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["p3", "10.0.0.3:1080", "socks5", "10.0.0.3", 1080, "dead", null, null, 2, 1, "test", "dead"],
    );

    // 2. Fetch unified proxies
    const resAll = await repo.getUnifiedProxies({ status: "all" });
    assert.equal(resAll.total, 3);
    assert.equal(resAll.counts.working, 1);
    assert.equal(resAll.counts.dead, 1);
    assert.equal(resAll.counts.regressed, 1);

    const item1 = resAll.items.find((p) => p.key === "p1");
    assert.equal(item1?.status, "working");

    const item2 = resAll.items.find((p) => p.key === "p2");
    assert.equal(item2?.status, "dead");

    const item3 = resAll.items.find((p) => p.key === "p3");
    assert.equal(item3?.status, "regressed");

    // 3. Filter by regressed
    const resRegressed = await repo.getUnifiedProxies({ status: "regressed" });
    assert.equal(resRegressed.items.length, 1);
    assert.equal(resRegressed.items[0].key, "p3");

    db.close();
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});
