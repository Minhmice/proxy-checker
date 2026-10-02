import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openProxyIntelligenceDb } from "../src/server/proxy-intelligence-db.js";
import { createProxyIntelligenceRepository } from "../src/server/proxy-intelligence-repository.js";
import type { ProxyAuditResult } from "../src/auditor/types.js";

test("getAuditDetail returns five scores, probe statuses, and reason codes", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-detail-test-"));
  try {
    const db = openProxyIntelligenceDb(tmpDir);
    const repo = createProxyIntelligenceRepository({ db });

    const key = "socks5://198.51.100.77:1080";
    db.run(
      `INSERT INTO proxies (proxy_key, endpoint, protocol, host, port, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [key, "198.51.100.77:1080", "socks5", "198.51.100.77", 1080, "usable", "test"]
    );

    const mockResult: ProxyAuditResult = {
      proxy: { protocol: "socks5", host: "198.51.100.77", port: 1080 },
      verdict: "WARN",
      scores: {
        overallSafety: 78,
        transportSecurity: 95,
        privacy: 70,
        reputation: 65,
        reliability: 80,
      },
      security: {
        inputValidation: { valid: true },
        ssrfProtection: { passed: true, resolvedIps: ["198.51.100.77"] },
      },
      connectivity: { reachable: true, latencyMs: 240 },
      exitIp: { ip: "198.51.100.77", country: "United States", city: "Ashburn" },
      network: { organization: "CloudProvider LLC", asn: "AS12345" },
      headerLeak: { detected: true, headers: [{ name: "X-Forwarded-For", value: "client-ip" }] },
      tls: { secure: true, certificateValid: true },
      dns: { dnsLeakDetected: null },
      riskFactors: [
        {
          id: "risk-header",
          code: "HEADER_LEAK",
          severity: "medium",
          title: "Proxy header leak",
          description: "Response contains proxy forwarding headers",
          category: "privacy",
        },
      ],
      recommendations: ["Strip headers at proxy gateway"],
      metadata: {
        startedAt: "2026-10-02T08:00:00.000Z",
        completedAt: "2026-10-02T08:00:01.000Z",
        durationMs: 1000,
        version: "1.0.0",
        toolVersion: "1.0.0",
        schemaVersion: "1.0.0",
      },
    };

    await repo.persistAuditSnapshot({
      proxyKey: key,
      result: mockResult,
      auditId: "audit-warn-1",
      finishedAt: Date.now(),
    });

    const detail = await repo.getAuditDetail(key);
    assert.ok(detail);
    assert.equal(detail.proxyKey, key);
    assert.equal(detail.verdict, "WARN");

    // 5 Scores
    assert.equal(detail.scores.overallSafety, 78);
    assert.equal(detail.scores.transportSecurity, 95);
    assert.equal(detail.scores.privacy, 70);
    assert.equal(detail.scores.reputation, 65);
    assert.equal(detail.scores.reliability, 80);

    // Reasons
    assert.equal(detail.reasons.length, 1);
    assert.equal(detail.reasons[0].code, "HEADER_LEAK");
    assert.equal(detail.reasons[0].severity, "warning");

    // Probes
    const dnsProbe = detail.probes.find((p) => p.name === "dns");
    assert.ok(dnsProbe);
    assert.equal(dnsProbe.status, "UNSUPPORTED");

    const headerProbe = detail.probes.find((p) => p.name === "headers");
    assert.ok(headerProbe);
    assert.equal(headerProbe.status, "WARN");

    // Exit details
    assert.equal(detail.exit.ip, "198.51.100.77");
    assert.equal(detail.exit.isp, "CloudProvider LLC");

    db.close();
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});
