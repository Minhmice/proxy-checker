import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openProxyIntelligenceDb } from "../src/server/proxy-intelligence-db.js";
import {
  createProxyIntelligenceRepository,
  type ProxyInventoryItem,
} from "../src/server/proxy-intelligence-repository.js";
import type { ProxyAuditResult } from "../src/lib/types.js";

function auditResult(verdict: "PASS" | "FAIL", latencyMs: number): ProxyAuditResult {
  return {
    proxy: { protocol: "http", host: "10.0.0.1", port: 8080 },
    verdict,
    scores: { overallSafety: 0, transportSecurity: 0, privacy: 0, reputation: 0, reliability: 0 },
    security: {
      inputValidation: { valid: true },
      ssrfProtection: { passed: true, resolvedIps: ["10.0.0.1"] },
    },
    connectivity: { reachable: verdict === "PASS", latencyMs },
    riskFactors: [],
    recommendations: [],
    metadata: {
      startedAt: "",
      completedAt: "",
      durationMs: latencyMs,
      version: "1.0.0",
      toolVersion: "1.0.0",
      schemaVersion: "1.0.0",
    },
  };
}

test("repository imports text lines into sqlite and redacts credentials", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-repo-test-"));
  try {
    const db = openProxyIntelligenceDb(tmpDir);
    const repo = createProxyIntelligenceRepository({ db });

    const rawContent = [
      "http://user1:pass1@127.0.0.1:8080",
      "socks5://127.0.0.2:1080",
      "invalid-junk-line",
      "",
    ].join("\n");

    const summary = await repo.importProxies({
      source: "test-import.txt",
      content: rawContent,
    });

    assert.equal(summary.totalLines, 3);
    assert.equal(summary.inserted, 2);
    assert.equal(summary.invalid, 1);

    // List proxies through repository (server-side pagination)
    const page = await repo.listProxies({ page: 1, pageSize: 10 });
    assert.equal(page.total, 2);
    assert.equal(page.items.length, 2);

    // Password must be redacted/omitted from list
    const authProxy = page.items.find((p: ProxyInventoryItem) => p.host === "127.0.0.1");
    assert.ok(authProxy);
    assert.equal(authProxy.hasAuth, true);
    assert.equal((authProxy as unknown as Record<string, unknown>).password, undefined);

    // Detail lookup
    const detail = await repo.getProxy(authProxy.proxyKey);
    assert.ok(detail);
    assert.equal(detail.host, "127.0.0.1");
    assert.equal(detail.username, "user1");
    // In detail view, password should be masked or omitted
    assert.equal((detail as unknown as Record<string, unknown>).password, undefined);

    db.close();
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // ignore Windows file locking race in temp dir cleanup
    }
  }
});

test("repository filter queries by lifecycle and search term", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-repo-test-filter-"));
  try {
    const db = openProxyIntelligenceDb(tmpDir);
    const repo = createProxyIntelligenceRepository({ db });

    await repo.importProxies({
      source: "bulk.txt",
      content: "http://10.0.0.1:8080\nhttp://10.0.0.2:8080\nhttp://192.168.1.5:3128",
    });

    // Manually simulate a dangerous lifecycle state on one proxy
    db.run("UPDATE proxies SET lifecycle_state = 'dangerous' WHERE endpoint LIKE '%192.168.1.5%'");

    const dangerousOnly = await repo.listProxies({ lifecycle: "dangerous" });
    assert.equal(dangerousOnly.total, 1);
    assert.equal(dangerousOnly.items[0].host, "192.168.1.5");

    const searchResult = await repo.listProxies({ search: "10.0.0" });
    assert.equal(searchResult.total, 2);
    db.close();
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // ignore Windows file locking race in temp dir cleanup
    }
  }
});

test("persistAuditSnapshot clears latency_ms and last_latency_ms on FAIL", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-repo-test-fail-latency-"));
  try {
    const db = openProxyIntelligenceDb(tmpDir);
    const repo = createProxyIntelligenceRepository({ db });

    await repo.importProxies({
      source: "test.txt",
      content: "http://10.0.0.1:8080",
    });

    const listBefore = await repo.listProxies();
    const proxyKey = listBefore.items[0].proxyKey;

    // Pre-populate with latency
    db.run("UPDATE proxies SET latency_ms = 150, last_latency_ms = 150 WHERE proxy_key = ?", [
      proxyKey,
    ]);

    // Snapshot with FAIL verdict
    await repo.persistAuditSnapshot({
      proxyKey,
      result: auditResult("FAIL", 9999),
    });

    const row = db.get<{ latency_ms: number | null; last_latency_ms: number | null }>(
      "SELECT latency_ms, last_latency_ms FROM proxies WHERE proxy_key = ?",
      [proxyKey],
    );

    assert.equal(row?.latency_ms, null);
    assert.equal(row?.last_latency_ms, null);

    // Snapshot with PASS verdict preserves/updates latency
    await repo.persistAuditSnapshot({
      proxyKey,
      result: auditResult("PASS", 120),
    });

    const rowPass = db.get<{ latency_ms: number | null; last_latency_ms: number | null }>(
      "SELECT latency_ms, last_latency_ms FROM proxies WHERE proxy_key = ?",
      [proxyKey],
    );
    assert.equal(rowPass?.latency_ms, 120);
    assert.equal(rowPass?.last_latency_ms, 120);

    db.close();
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // ignore Windows file locking race
    }
  }
});

test("listProxies sorts dead proxies with freshly-checked at bottom", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-repo-test-dead-sort-"));
  try {
    const db = openProxyIntelligenceDb(tmpDir);
    const repo = createProxyIntelligenceRepository({ db });

    await repo.importProxies({
      source: "dead-test.txt",
      content: "http://10.0.0.1:8080\nhttp://10.0.0.2:8080\nhttp://10.0.0.3:8080",
    });

    // Mark all three as dead:
    // 10.0.0.1: never checked (checked_at = 0)
    // 10.0.0.2: checked long ago (checked_at = 1000)
    // 10.0.0.3: checked recently (checked_at = 2000)
    db.run("UPDATE proxies SET status = 'dead', checked_at = 0 WHERE endpoint LIKE '%10.0.0.1%'");
    db.run(
      "UPDATE proxies SET status = 'dead', checked_at = 1000 WHERE endpoint LIKE '%10.0.0.2%'",
    );
    db.run(
      "UPDATE proxies SET status = 'dead', checked_at = 2000 WHERE endpoint LIKE '%10.0.0.3%'",
    );

    const list = await repo.listProxies({ pageSize: 10 });
    const hosts = list.items.map((i: ProxyInventoryItem) => i.host);

    // Never checked (NULL) should come first, then older (1000), then recent (2000) last
    assert.equal(hosts[0], "10.0.0.1");
    assert.equal(hosts[1], "10.0.0.2");
    assert.equal(hosts[2], "10.0.0.3");

    db.close();
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // ignore Windows file locking race
    }
  }
});
test("unified health order rotates failed proxies by check age, not stale latency", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-repo-test-unified-order-"));
  try {
    const db = openProxyIntelligenceDb(tmpDir);
    const repo = createProxyIntelligenceRepository({ db });
    const rows = [
      ["http://never.example:8080", "never.example", 0, 0, null, 0],
      ["http://old.example:8080", "old.example", 0, 1000, 9999, 2],
      ["http://recent.example:8080", "recent.example", 0, 2000, 1, 3],
    ];
    for (const [key, host, everPassed, checkedAt, latency, failures] of rows) {
      db.run(
        `INSERT INTO proxies (proxy_key, endpoint, protocol, host, port, status, latency_ms, checked_at, successes, failures, source, lifecycle_state, ever_passed)
         VALUES (?, ?, 'http', ?, 8080, 'dead', ?, ?, 0, ?, 'test', 'dead', ?)`,
        [key, `${host}:8080`, host, latency, checkedAt, failures, everPassed],
      );
    }

    const result = await repo.getUnifiedProxies({ pageSize: 10 });
    assert.deepEqual(
      result.items.map((item) => item.host),
      ["never.example", "old.example", "recent.example"],
    );
    assert.equal(result.items[1]?.latencyMs, null);
    assert.equal(result.items[2]?.latencyMs, null);
    db.close();
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {}
  }
});

test("unified filters exact proxy key, source, and computed health separately from lifecycle", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-repo-test-unified-filter-"));
  try {
    const db = openProxyIntelligenceDb(tmpDir);
    const repo = createProxyIntelligenceRepository({ db });
    db.run(
      `INSERT INTO proxies (proxy_key, endpoint, protocol, host, port, status, successes, failures, source, lifecycle_state)
       VALUES (?, ?, 'http', ?, 8080, 'dead', 1, 2, ?, 'working')`,
      ["http://exact.example:8080", "exact.example:8080", "exact.example", "shown-source"],
    );
    db.run(
      `INSERT INTO proxies (proxy_key, endpoint, protocol, host, port, status, successes, failures, source, lifecycle_state)
       VALUES (?, ?, 'http', ?, 8080, 'dead', 0, 2, ?, 'dead')`,
      ["http://other.example:8080", "other.example:8080", "other.example", "other-source"],
    );

    const exact = await repo.getUnifiedProxies({
      proxyKey: "http://exact.example:8080",
      source: "shown-source",
    });
    assert.deepEqual(
      exact.items.map((item) => item.proxyKey),
      ["http://exact.example:8080"],
    );

    const regressed = await repo.getUnifiedProxies({ health: "regressed", source: "shown-source" });
    assert.deepEqual(
      regressed.items.map((item) => item.proxyKey),
      ["http://exact.example:8080"],
    );
    db.close();
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {}
  }
});

test("failed live latency is sanitized without changing audit evidence", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-repo-test-audit-evidence-"));
  try {
    const db = openProxyIntelligenceDb(tmpDir);
    const repo = createProxyIntelligenceRepository({ db });
    await repo.importProxies({ source: "test.txt", content: "http://evidence.example:8080" });
    const key = "http://evidence.example:8080";
    await repo.persistAuditSnapshot({
      proxyKey: key,
      result: auditResult("FAIL", 9876),
      finishedAt: 5000,
    });
    const current = await repo.getUnifiedProxies({ proxyKey: key });
    assert.equal(current.items[0]?.latencyMs, null);
    const row = db.get<{ last_verdict: string }>(
      "SELECT last_verdict FROM proxies WHERE proxy_key = ?",
      [key],
    );
    assert.equal(row?.last_verdict, "FAIL");
    db.close();
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {}
  }
});
