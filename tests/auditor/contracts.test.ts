import test from "node:test";
import assert from "node:assert/strict";
import { serializeAuditDetail } from "../../src/auditor/detail.js";
import type { ProxyAuditResult } from "../../src/auditor/types.js";

const mockSampleResult: ProxyAuditResult = {
  proxy: {
    protocol: "http",
    host: "104.248.63.15",
    port: 3128,
  },
  verdict: "PASS",
  scores: {
    overallSafety: 92,
    transportSecurity: 100,
    privacy: 88,
    reputation: 85,
    reliability: 95,
  },
  security: {
    inputValidation: { valid: true },
    ssrfProtection: { passed: true, resolvedIps: ["104.248.63.15"] },
  },
  connectivity: {
    reachable: true,
    latencyMs: 145,
  },
  exitIp: {
    ip: "104.248.63.15",
  },
  headerLeak: {
    detected: false,
    headers: [],
  },
  tls: {
    secure: true,
    certificateValid: true,
  },
  dns: {
    dnsLeakDetected: null,
  },
  contentIntegrity: {
    intact: true,
  },
  stability: {
    stable: true,
    successRate: 100,
  },
  riskFactors: [],
  recommendations: [],
  metadata: {
    startedAt: "2026-10-02T08:00:00.000Z",
    completedAt: "2026-10-02T08:00:01.200Z",
    durationMs: 1200,
    version: "1.0.0",
    toolVersion: "1.0.0",
    schemaVersion: "1.0.0",
  },
};

test("unsupported measurement is not a failure", () => {
  const detail = serializeAuditDetail(mockSampleResult, "http://104.248.63.15:3128", "audit-1");

  // DNS probe returned null for dnsLeakDetected -> probe status should be UNSUPPORTED or SKIPPED, NOT FAIL
  const dnsProbe = detail.probes.find((p) => p.name === "dns");
  assert.ok(dnsProbe, "dns probe should exist");
  assert.equal(dnsProbe.status, "UNSUPPORTED");
  assert.notEqual(dnsProbe.status, "FAIL");

  // UDP probe on HTTP proxy is unsupported
  const udpProbe = detail.probes.find((p) => p.name === "udp");
  assert.ok(udpProbe, "udp probe should exist");
  assert.equal(udpProbe.status, "UNSUPPORTED");
  assert.notEqual(udpProbe.status, "FAIL");
});

test("critical risk maps to critical reason and failure code", () => {
  const failingResult: ProxyAuditResult = {
    ...mockSampleResult,
    verdict: "FAIL",
    riskFactors: [
      {
        id: "risk-origin",
        code: "ORIGIN_IP_EXPOSED",
        severity: "critical",
        title: "Origin IP exposed",
        description: "Proxy response revealed the direct origin address.",
      },
    ],
  };

  const detail = serializeAuditDetail(failingResult, "http://104.248.63.15:3128", "audit-2");
  assert.equal(detail.verdict, "FAIL");
  const originReason = detail.reasons.find((r) => r.code === "ORIGIN_IP_EXPOSED");
  assert.ok(originReason);
  assert.equal(originReason.severity, "critical");
});

test("provenance and versioning are properly populated", () => {
  const detail = serializeAuditDetail(mockSampleResult, "http://104.248.63.15:3128", "audit-3");
  assert.ok(detail.provenance);
  assert.equal(detail.provenance.auditorVersion, "1.0.0");
  assert.equal(detail.scoringVersion, "1.0.0");
  assert.equal(detail.proxyKey, "http://104.248.63.15:3128");
  assert.equal(detail.auditId, "audit-3");
});
