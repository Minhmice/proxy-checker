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
      [key, "100.71.252.27:10001", "socks5", "100.71.252.27", 10001, "usable", "117.5.147.3", 2391, 10, 0, "test", "working"]
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
      `INSERT INTO proxy_audits (id, proxy_key, verdict, lifecycle_state, overall_score, transport_score, privacy_score, reputation_score, reliability_score, started_at, finished_at, result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [auditId, key, "PASS", "working", 95, 90, 100, 95, 95, 1727715500000, 1727715518000, JSON.stringify(auditResult)]
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
    assert.equal(item.isp, "Viettel Group");
    assert.equal(item.geo?.city, "Hanoi");
    assert.equal(item.geo?.country, "Vietnam");
    assert.equal(item.timezone, "Asia/Bangkok");

    // 2. Query history
    const historyRows = db.all<{
      id: string;
      verdict: string;
      finished_at: number;
      result_json: string;
    }>(
      "SELECT id, verdict, finished_at, result_json FROM proxy_audits WHERE proxy_key = ? ORDER BY finished_at DESC LIMIT 10",
      [key]
    );

    assert.equal(historyRows.length, 1);
    const parsed = JSON.parse(historyRows[0].result_json);
    assert.equal(parsed.evidence.exitIp.isp, "Viettel Group");
    assert.equal(parsed.evidence.network.udp, true);

    db.close();
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});
