import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openProxyIntelligenceDb, migrateProxyIntelligence } from "../src/server/proxy-intelligence-db.js";
import { createProxyIntelligenceRepository } from "../src/server/proxy-intelligence-repository.js";
import type { ProxyAuditResult } from "../src/lib/types.js";

test("migration is idempotent and adds snapshot columns and audit_jobs table", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mig-test-"));
  try {
    const db = openProxyIntelligenceDb(tmpDir);

    // Call migration again to verify idempotency
    migrateProxyIntelligence(db);

    // Verify columns on proxies table
    const columns = db.all<{ name: string }>("PRAGMA table_info(proxies)").map((c) => c.name);
    assert.ok(columns.includes("last_verdict"), "has last_verdict");
    assert.ok(columns.includes("last_checked_at"), "has last_checked_at");
    assert.ok(columns.includes("last_latency_ms"), "has last_latency_ms");
    assert.ok(columns.includes("last_exit_ip"), "has last_exit_ip");
    assert.ok(columns.includes("last_failure_code"), "has last_failure_code");
    assert.ok(columns.includes("ever_passed"), "has ever_passed");

    // Verify legacy audit tables are dropped
    const auditJobs = db.all<{ name: string }>("PRAGMA table_info(audit_jobs)");
    assert.equal(auditJobs.length, 0, "audit_jobs table is dropped");
    db.close();
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});

test("persistAuditSnapshot stores audit, updates snapshot columns and ever_passed", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-snap-test-"));
  try {
    const db = openProxyIntelligenceDb(tmpDir);
    const repo = createProxyIntelligenceRepository({ db });

    const key = "socks5://192.0.2.1:1080";
    db.run(
      `INSERT INTO proxies (proxy_key, endpoint, protocol, host, port, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [key, "192.0.2.1:1080", "socks5", "192.0.2.1", 1080, "dead"]
    );

    const mockResult: ProxyAuditResult = {
      proxy: { protocol: "socks5", host: "192.0.2.1", port: 1080 },
      verdict: "PASS",
      scores: {
        overallSafety: 90,
        transportSecurity: 90,
        privacy: 90,
        reputation: 90,
        reliability: 90,
      },
      security: {
        inputValidation: { valid: true },
        ssrfProtection: { passed: true, resolvedIps: ["192.0.2.1"] },
      },
      connectivity: { reachable: true, latencyMs: 85 },
      exitIp: { ip: "203.0.113.55" },
      riskFactors: [],
      recommendations: [],
      metadata: {
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 85,
        version: "1.0.0",
        toolVersion: "1.0.0",
        schemaVersion: "1.0.0",
      },
    };

    await repo.persistAuditSnapshot({
      proxyKey: key,
      result: mockResult,
      auditId: "test-snap-1",
      finishedAt: 1727800000000,
    });

    const row = db.get<{
      last_verdict: string;
      last_latency_ms: number;
      last_exit_ip: string;
      ever_passed: number;
      status: string;
    }>("SELECT last_verdict, last_latency_ms, last_exit_ip, ever_passed, status FROM proxies WHERE proxy_key = ?", [key]);

    assert.ok(row);
    assert.equal(row.last_verdict, "PASS");
    assert.equal(row.last_latency_ms, 85);
    assert.equal(row.last_exit_ip, "203.0.113.55");
    assert.equal(row.ever_passed, 1);
    assert.equal(row.status, "usable");

    db.close();
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});
