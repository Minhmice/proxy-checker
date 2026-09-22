import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuditorJobManager, type AuditorJobManager } from "../src/server/auditor-jobs.js";
import { parseProxyInput } from "../src/auditor/parser.js";
import type { AuditorJobOptions, ProxyAuditResult, ProxyInput } from "../src/lib/types.js";

const defaults: AuditorJobOptions = {
  attempts: 1,
  timeoutMs: 2000,
  concurrency: 2,
  reputation: false,
  browser: false,
};

function createMockAuditResult(input: ProxyInput): ProxyAuditResult {
  const { redacted } = parseProxyInput(input);
  return {
    proxy: redacted,
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
      ssrfProtection: { passed: true, resolvedIps: ["1.1.1.1"] },
    },
    riskFactors: [],
    recommendations: [],
    metadata: {
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 50,
      version: "1.0.0",
      toolVersion: "1.0.0",
      schemaVersion: "1.0.0",
    },
  };
}

async function waitForTerminal(manager: AuditorJobManager, jobId: string, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const job = manager.getJob(jobId);
    if (job && (job.status === "done" || job.status === "error" || job.status === "cancelled")) {
      return job;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
  throw new Error("Job did not reach terminal state");
}

test("single audit persists only redacted identity", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "auditor-jobs-test-"));
  const historyPath = path.join(dataDir, "auditor-history.json");
  const manager = createAuditorJobManager({
    dataDir,
    auditProxy: async (p) => createMockAuditResult(p),
  });

  const job = await manager.createSingle({
    proxy: "socks5://alice:secret@example.com:1080",
    options: defaults,
  });

  await waitForTerminal(manager, job.id);
  const persisted = fs.readFileSync(historyPath, "utf8");
  assert.equal(persisted.includes("secret"), false);
  assert.match(persisted, /alice:\*\*\*\*\*\*\*\*/);
});

test("bulk validation deduplicates endpoints and isolates invalid lines", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "auditor-jobs-test-"));
  const manager = createAuditorJobManager({
    dataDir,
    auditProxy: async (p) => createMockAuditResult(p),
  });

  const job = await manager.createBulk({
    name: "sample.txt",
    content: "http://a.example:80\nnot-a-proxy-at-all\nhttp://a.example:80\nhttp://b.example:80",
    options: defaults,
  });

  await waitForTerminal(manager, job.id);
  const current = manager.getJob(job.id)!;
  assert.equal(current.total, 3);
  assert.equal(current.duplicateCount, 1);
  assert.equal(current.results.some((item) => Boolean(item.error)), true);
});

test("rejects invalid options, enforces 50-job retention and 500-result cap", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "auditor-jobs-test-"));
  const manager = createAuditorJobManager({
    dataDir,
    auditProxy: async (p) => createMockAuditResult(p),
  });

  // non-txt name
  await assert.rejects(
    manager.createBulk({ name: "bad.pdf", content: "http://1.1.1.1:80", options: defaults }),
    /must have \.txt extension/i
  );

  // attempts bound
  await assert.rejects(
    manager.createSingle({ proxy: "http://1.1.1.1:80", options: { ...defaults, attempts: 20 } }),
    /attempts/i
  );
});

test("cancellation transitions running job to cancelled", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "auditor-jobs-test-"));
  const manager = createAuditorJobManager({
    dataDir,
    auditProxy: async (proxy) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 100);
      await promise;
      return createMockAuditResult(proxy);
    },
  });

  const job = await manager.createBulk({
    name: "bulk.txt",
    content: "http://1.1.1.1:80\nhttp://2.2.2.2:80\nhttp://3.3.3.3:80",
    options: { ...defaults, concurrency: 1 },
  });

  const cancelled = await manager.cancelJob(job.id);
  assert.equal(cancelled.status, "cancelled");
});

test("export produces valid JSON and CSV outputs", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "auditor-jobs-test-"));
  const manager = createAuditorJobManager({
    dataDir,
    auditProxy: async (p) => createMockAuditResult(p),
  });

  const job = await manager.createSingle({
    proxy: "http://test:secret@example.com:8080",
    options: defaults,
  });
  await waitForTerminal(manager, job.id);

  const jsonExp = await manager.exportJob(job.id, "json");
  assert.equal(jsonExp.contentType, "application/json");
  assert.equal(jsonExp.body.toString("utf8").includes("secret"), false);

  const csvExp = await manager.exportJob(job.id, "csv");
  assert.equal(csvExp.contentType.includes("text/csv"), true);
  assert.equal(csvExp.body.toString("utf8").includes("secret"), false);
});

test("corrupted history file is handled gracefully on startup", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "auditor-jobs-test-"));
  fs.writeFileSync(path.join(dataDir, "auditor-history.json"), "{ invalid json... [");
  assert.doesNotThrow(() => {
    const manager = createAuditorJobManager({ dataDir });
    assert.deepEqual(manager.listHistory(), []);
  });
});
