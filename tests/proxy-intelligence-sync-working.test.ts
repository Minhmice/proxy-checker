import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openProxyIntelligenceDb } from "../src/server/proxy-intelligence-db.js";
import { createProxyIntelligenceRepository } from "../src/server/proxy-intelligence-repository.js";

test("syncWorkingPools imports active/usable pool proxies into intelligence and marks them working", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-intelligence-working-"));
  const db = openProxyIntelligenceDb(tmpDir);
  const repo = createProxyIntelligenceRepository({ db });

  try {
    const summary = await repo.syncWorkingPools([
      {
        endpoint: "103.227.243.73:8080",
        proxyUrl: "http://103.227.243.73:8080",
        tier: "active",
        status: "usable",
        isActiveOnRouter: true,
        latency_ms: 120,
        exit_ip: "103.227.243.73",
      },
      {
        endpoint: "89.116.30.252:8888",
        proxyUrl: "socks5://user:pass@89.116.30.252:8888",
        tier: "reserve",
        status: "usable",
        isActiveOnRouter: false,
        latency_ms: 240,
        exit_ip: "89.116.30.252",
      },
      {
        endpoint: "1.2.3.4:80",
        proxyUrl: "http://1.2.3.4:80",
        tier: "dead",
        status: "dead",
        isActiveOnRouter: false,
        latency_ms: null,
        exit_ip: null,
      },
    ]);

    assert.equal(summary.imported, 2);
    assert.equal(summary.proxyKeys.length, 2);

    const workingPage = await repo.listProxies({ lifecycle: "working" });
    assert.equal(workingPage.total, 2);
    const active = workingPage.items.find((item) => item.endpoint === "103.227.243.73:8080");
    assert.ok(active);
    assert.equal(active.lifecycleState, "working");
    assert.equal(active.status, "usable");
    assert.equal(active.source, "9router-working");
    assert.equal(active.latencyMs, 120);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
