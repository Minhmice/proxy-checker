import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openProxyIntelligenceDb } from "../src/server/proxy-intelligence-db.js";
import { createProxyIntelligenceRepository } from "../src/server/proxy-intelligence-repository.js";
import type { ProxyAuditResult } from "../src/lib/types.js";

test("exportWorkingProxies strictly redacts credentials by default", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-export-test-"));
  try {
    const db = openProxyIntelligenceDb(tmpDir);
    const repo = createProxyIntelligenceRepository({ db });

    const key = "socks5://operator:mysecretpass@198.51.100.10:1080";
    db.run(
      `INSERT INTO proxies (proxy_key, endpoint, protocol, host, port, username, password, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        key,
        "198.51.100.10:1080",
        "socks5",
        "198.51.100.10",
        1080,
        "operator",
        "mysecretpass",
        "usable",
        "test",
      ],
    );

    const mockResult: ProxyAuditResult = {
      proxy: { protocol: "socks5", host: "198.51.100.10", port: 1080, username: "operator" },
      verdict: "PASS",
      scores: {
        overallSafety: 95,
        transportSecurity: 95,
        privacy: 95,
        reputation: 95,
        reliability: 95,
      },
      security: {
        inputValidation: { valid: true },
        ssrfProtection: { passed: true, resolvedIps: ["198.51.100.10"] },
      },
      connectivity: { reachable: true, latencyMs: 50 },
      exitIp: { ip: "198.51.100.10" },
      riskFactors: [],
      recommendations: [],
      metadata: {
        startedAt: "",
        completedAt: "",
        durationMs: 50,
        version: "1.0",
        toolVersion: "1.0",
        schemaVersion: "1.0",
      },
    };

    await repo.persistAuditSnapshot({
      proxyKey: key,
      result: mockResult,
      auditId: "audit-exp-1",
      finishedAt: Date.now(),
    });

    // 1. Default export without credentials
    const defaultExport = await repo.exportWorkingProxies({
      format: "txt",
      includeCredentials: false,
    });

    assert.ok(defaultExport.body.includes("198.51.100.10:1080"));
    assert.equal(
      defaultExport.body.includes("mysecretpass"),
      false,
      "Plaintext password must not be in default export",
    );
    assert.equal(
      defaultExport.body.includes("operator:"),
      false,
      "Username must not be in default export",
    );

    // 2. Explicit export with credentials
    const credExport = await repo.exportWorkingProxies({
      format: "txt",
      includeCredentials: true,
    });
    assert.ok(credExport.body.includes("operator:mysecretpass@198.51.100.10:1080"));

    // 3. CSV format with credentials
    const csvExport = await repo.exportWorkingProxies({
      format: "csv",
      includeCredentials: false,
    });
    assert.ok(csvExport.body.includes('"socks5","198.51.100.10",1080,"",""'));

    db.close();
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});
