import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openProxyIntelligenceDb } from "../src/server/proxy-intelligence-db.js";
import { createProxyIntelligenceRepository } from "../src/server/proxy-intelligence-repository.js";

test("repository and history serialization for unified proxies API", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-api-test-"));
  try {
    const db = openProxyIntelligenceDb(tmpDir);
    const repo = createProxyIntelligenceRepository({ db });

    const key = "socks5://100.71.252.27:10001";
    db.run(
      `INSERT INTO proxies (proxy_key, endpoint, protocol, host, port, status, exit_ip, latency_ms, successes, failures, source, lifecycle_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        key,
        "100.71.252.27:10001",
        "socks5",
        "100.71.252.27",
        10001,
        "usable",
        "117.5.147.3",
        2391,
        10,
        0,
        "test",
        "working",
      ],
    );

    // Insert an audit run for this proxy
    const auditId = "audit-123";
    const auditResult = {
      evidence: {
        exitIp: {
          ip: "117.5.147.3",
          geo: { city: "Hanoi", country: "Vietnam" },
          isp: "Viettel Group",
          timezone: "Asia/Bangkok",
        },
        network: {
          udp: true,
        },
      },
      connectivity: {
        latencyMs: 2391,
      },
    };

    db.run(
      `UPDATE proxies SET status = 'usable', last_verdict = 'PASS', exit_ip = '117.5.147.3', latency_ms = 2391 WHERE proxy_key = ?`,
      [key],
    );

    // 1. Unified proxies query with activePoolEndpoints mapping
    const activePoolEndpoints = new Set(["100.71.252.27:10001"]);
    const res = await repo.getUnifiedProxies({
      status: "all",
      activePoolEndpoints,
    });

    assert.equal(res.total, 1);
    assert.equal(res.counts.all, 1);
    assert.equal(res.counts.working, 1);
    const item = res.items[0];
    assert.equal(item.key, key);
    assert.equal(item.status, "working");
    assert.equal(item.sync, "active");
    assert.equal(item.udp, "Yes");
    assert.equal(item.exitIp, "117.5.147.3");
    assert.equal(item.status, "working");

    // Assert new unified contract fields
    assert.equal(res.pagination.total, 1);
    assert.equal(res.facets.all, 1);
    assert.equal(res.facets.working, 1);
    assert.equal(res.facets.protocols.socks5, 1);
    assert.equal(item.health, "working");
    assert.equal(item.poolTier, "active");
    assert.equal(item.lastAudit?.verdict, "PASS");

    // 1b. Query audit detail
    const detail = await repo.getAuditDetail(key);
    assert.ok(detail);
    assert.equal(detail.proxyKey, key);
    assert.equal(detail.verdict, "PASS");

    // 1c. Test previewImport
    const preview = await repo.previewImport({
      source: "bulk.txt",
      content: "http://1.2.3.4:8080\nsocks5://5.6.7.8:1080\ninvalid-line\n",
    });
    assert.equal(preview.totalLines, 3);
    assert.equal(preview.valid, 2);
    assert.equal(preview.invalid, 1);
    assert.equal(preview.protocols.http, 1);
    assert.equal(preview.protocols.socks5, 1);

    db.close();
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});
