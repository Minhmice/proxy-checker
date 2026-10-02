import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openProxyIntelligenceDb } from "../src/server/proxy-intelligence-db.js";
import { createProxyIntelligenceRepository } from "../src/server/proxy-intelligence-repository.js";
import { createProxyIntelligenceJobManager } from "../src/server/proxy-intelligence-jobs.js";
import type { ProxyAuditResult, ProxyInput } from "../src/auditor/types.js";

function mockAudit(proxy: ProxyInput): Promise<ProxyAuditResult> {
  const host = typeof proxy === "string" ? proxy : proxy.host;
  const protocol = typeof proxy === "string" ? "http" : proxy.protocol;
  const port = typeof proxy === "string" ? 8080 : proxy.port;
  return Promise.resolve({
    proxy: { protocol, host, port },
    verdict: "PASS",
    scores: { overallSafety: 90, transportSecurity: 90, privacy: 90, reputation: 90, reliability: 90 },
    security: { inputValidation: { valid: true }, ssrfProtection: { passed: true, resolvedIps: [host] } },
    riskFactors: [],
    recommendations: [],
    metadata: { startedAt: "", completedAt: "", durationMs: 10, version: "1.0", toolVersion: "1.0", schemaVersion: "1.0" },
  });
}

test("restart exposes interrupted audit job from database", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-restart-test-"));
  try {
    const db = openProxyIntelligenceDb(tmpDir);
    const repo = createProxyIntelligenceRepository({ db });

    const now = 1727800000000;
    // Insert an unfinished running job simulating process kill
    db.run(
      `INSERT INTO audit_jobs (id, state, created_at, started_at, total, completed, passed, options_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["job-interrupted-1", "running", now, now, 10, 4, 4, JSON.stringify({ concurrency: 2 })]
    );

    // Boot fresh manager instance
    const manager = createProxyIntelligenceJobManager({
      db,
      repo,
      auditFn: mockAudit,
      now: () => now + 5000,
    });

    const job = manager.getJob("job-interrupted-1");
    assert.ok(job);
    assert.equal(job.id, "job-interrupted-1");
    assert.equal(job.status, "interrupted");
    assert.equal(job.total, 10);
    assert.equal(job.checked, 4);
    assert.equal(job.passCount, 4);

    const list = manager.listJobs();
    assert.ok(list.some((j) => j.id === "job-interrupted-1"));

    db.close();
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});
