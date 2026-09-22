import assert from "node:assert/strict";
import test from "node:test";
import type { ProxyAuditResult } from "../../src/auditor/types.js";

test("ProxyAuditResult matches required result contract", () => {
  const result: ProxyAuditResult = {
    proxy: {
      protocol: "http",
      host: "proxy.example.com",
      port: 8080,
      username: "alice:********",
    },
    verdict: "UNKNOWN",
    scores: {
      overallSafety: null,
      transportSecurity: 80,
      privacy: null,
      reputation: 70,
      reliability: null,
    },
    security: {
      inputValidation: { valid: true },
      ssrfProtection: {
        passed: true,
        resolvedIps: ["93.184.216.34"],
      },
    },
    connectivity: { reachable: true, latencyMs: 120 },
    baseline: { established: true, statusCode: 200 },
    exitIp: { ip: "203.0.113.10", country: "US" },
    network: { asn: "AS64500", organization: "Example ISP" },
    dns: { resolved: true, addresses: ["93.184.216.34"], dnsLeakDetected: null },
    headerLeak: { detected: false, headers: [] },
    contentIntegrity: { intact: true },
    reputation: { score: 90 },
    stability: { stable: true },
    riskFactors: [
      {
        id: "RISK-01",
        code: "UNENCRYPTED_TRANSPORT",
        severity: "info",
        title: "Plaintext HTTP Proxy",
        description: "Proxy transmits data without TLS",
        message: "Traffic can be intercepted",
        evidence: { protocol: "http", port: 8080 },
      },
    ],
    browserAudit: { supported: false },
    recommendations: [],
    metadata: {
      startedAt: "2026-09-22T00:00:00.000Z",
      completedAt: "2026-09-22T00:00:01.000Z",
      durationMs: 1000,
      version: "1.0.0",
      toolVersion: "1.0.0",
      schemaVersion: "1",
    },
  };

  assert.equal(result.proxy.username, "alice:********");
  assert.equal(result.metadata.toolVersion, "1.0.0");
  assert.equal(result.riskFactors[0].evidence !== undefined, true);
  assert.equal(result.security.ssrfProtection.passed, true);
  assert.equal(result.riskFactors[0].severity, "info");
  assert.equal(result.dns?.dnsLeakDetected, null);
});
