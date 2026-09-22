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
    tls: { secure: true, protocol: "TLSv1.3" },
    dns: { resolved: true, addresses: ["93.184.216.34"] },
    headerLeak: { detected: false, headers: [] },
    contentIntegrity: { intact: true },
    reputation: { score: 90 },
    stability: { stable: true },
    rotation: { supported: false },
    browserAudit: { supported: false },
    riskFactors: [],
    recommendations: [],
    metadata: {
      startedAt: "2026-09-22T00:00:00.000Z",
      completedAt: "2026-09-22T00:00:01.000Z",
      durationMs: 1000,
      version: "1.0.0",
      schemaVersion: "1",
    },
  };

  assert.equal(result.proxy.username, "alice:********");
  assert.equal(result.verdict, "UNKNOWN");
  assert.equal(result.security.ssrfProtection.passed, true);
  assert.equal(result.metadata.schemaVersion, "1");
});
