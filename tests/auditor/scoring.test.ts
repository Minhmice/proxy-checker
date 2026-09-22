import assert from "node:assert/strict";
import test from "node:test";
import { calculateScores, type AuditEvidence } from "../../src/auditor/scoring/scores.js";
import { determineVerdict } from "../../src/auditor/scoring/verdict.js";

function safeEvidence(): AuditEvidence {
  return {
    security: {
      inputValidation: { valid: true },
      ssrfProtection: { passed: true, resolvedIps: ["203.0.113.10"] },
    },
    connectivity: { reachable: true, latencyMs: 120 },
    baseline: { established: true, statusCode: 200, latencyMs: 20 },
    exitIp: { ip: "203.0.113.10", country: "US", matchesDeclared: true },
    network: { asn: "AS64500", isDatacenter: false, isTor: false },
    tls: { secure: true, certificateValid: true, protocol: "TLSv1.3" },
    dns: { resolved: true, addresses: ["203.0.113.53"], dnsLeakDetected: false },
    headerLeak: { detected: false, headers: [], originIpExposed: false },
    contentIntegrity: {
      intact: true,
      injectedScripts: [],
      modifiedHeaders: [],
      tlsStripping: false,
      spkiValid: true,
      bodyMatches: true,
    },
    reputation: {
      score: 0,
      blacklists: [],
      fraudScore: 0,
      spamScore: 0,
      maliciousSignals: [],
    },
    stability: {
      stable: true,
      samplesAttempted: 20,
      samplesSucceeded: 20,
      successRate: 100,
      packetLossPercent: 0,
      p95LatencyMs: 120,
      jitterMs: 5,
    },
    rotation: {
      supported: false,
      exitIpChanged: false,
      distinctIpsObserved: ["203.0.113.10"],
    },
    browserAudit: {
      supported: true,
      navigationSucceeded: true,
      webrtcLeakDetected: false,
      timezoneMismatch: false,
      canvasFingerprintConsistent: true,
    },
  };
}

test("calculateScores applies 35/30/20/15 category weights", () => {
  const evidence = safeEvidence();
  evidence.contentIntegrity = { ...evidence.contentIntegrity, intact: false, bodyMatches: false };
  evidence.dns = { ...evidence.dns, dnsLeakDetected: true };
  evidence.reputation = { ...evidence.reputation, score: 40 };
  evidence.stability = { ...evidence.stability, stable: true, successRate: 80 };

  assert.deepEqual(calculateScores(evidence), {
    overallSafety: 39,
    transportSecurity: 0,
    privacy: 50,
    reputation: 60,
    reliability: 80,
  });
});

test("calculateScores preserves nullable categories and never treats missing evidence as safe", () => {
  const evidence = safeEvidence();
  evidence.tls = undefined;

  assert.deepEqual(calculateScores(evidence), {
    overallSafety: null,
    transportSecurity: null,
    privacy: 100,
    reputation: 100,
    reliability: 100,
  });

  evidence.tls = safeEvidence().tls;
  evidence.reputation = { score: null };
  assert.equal(calculateScores(evidence).reputation, null);
  assert.equal(calculateScores(evidence).overallSafety, null);
});

test("transportSecurity reflects verified TLS when optional content integrity is absent", () => {
  const evidence = safeEvidence();
  evidence.contentIntegrity = undefined;

  const scores = calculateScores(evidence);
  assert.equal(scores.transportSecurity, 100);
  assert.equal(scores.overallSafety, 100);
});

const criticalCases: Array<[string, (evidence: AuditEvidence) => void, string]> = [
  ["SSRF violation", (e) => { e.security.ssrfProtection.passed = false; }, "SSRF_VIOLATION"],
  ["connection failure", (e) => { e.connectivity = { reachable: false, error: "ECONNREFUSED" }; }, "CONNECTION_FAILED"],
  ["invalid TLS", (e) => { e.tls = { secure: false, certificateValid: false, error: "expired" }; }, "TLS_CERTIFICATE_INVALID"],
  ["SPKI mismatch", (e) => { e.contentIntegrity = { ...e.contentIntegrity, intact: false, spkiValid: false }; }, "SPKI_MISMATCH"],
  ["content tampering", (e) => { e.contentIntegrity = { ...e.contentIntegrity, intact: false, bodyMatches: false }; }, "CONTENT_TAMPERING"],
  ["origin IP exposure", (e) => { e.headerLeak = { detected: true, originIpExposed: true, headers: [] }; }, "ORIGIN_IP_EXPOSED"],
];

for (const [name, mutate, expectedCode] of criticalCases) {
  test(`${name} forces FAIL regardless of numeric score`, () => {
    const evidence = safeEvidence();
    const safeScores = calculateScores(evidence);
    mutate(evidence);

    const result = determineVerdict(evidence, safeScores);
    assert.equal(result.verdict, "FAIL");
    assert.equal(result.riskFactors.some((factor) => factor.code === expectedCode && factor.severity === "critical"), true);
  });
}

test("fully measured safe evidence produces PASS", () => {
  const evidence = safeEvidence();
  const result = determineVerdict(evidence, calculateScores(evidence));

  assert.equal(result.verdict, "PASS");
  assert.deepEqual(result.riskFactors, []);
  assert.deepEqual(result.recommendations, []);
});

const warningCases: Array<[string, (evidence: AuditEvidence) => void, string]> = [
  ["high latency", (e) => { e.connectivity = { reachable: true, latencyMs: 2_500 }; }, "HIGH_LATENCY"],
  ["abuse history", (e) => { e.reputation = { ...e.reputation, score: 60, maliciousSignals: ["abuse_confidence_60"] }; }, "ABUSE_HISTORY"],
  ["unstable exit IP", (e) => { e.rotation = { supported: true, exitIpChanged: true, distinctIpsObserved: ["203.0.113.10", "203.0.113.11"] }; }, "UNSTABLE_EXIT_IP"],
  ["DNS leak", (e) => { e.dns = { resolved: true, dnsLeakDetected: true }; }, "DNS_LEAK"],
];

for (const [name, mutate, expectedCode] of warningCases) {
  test(`${name} produces WARN with explanation`, () => {
    const evidence = safeEvidence();
    mutate(evidence);

    const result = determineVerdict(evidence, calculateScores(evidence));
    assert.equal(result.verdict, "WARN");
    assert.equal(result.riskFactors.some((factor) => factor.code === expectedCode), true);
    assert.equal(result.recommendations.length > 0, true);
  });
}

test("incomplete evidence produces UNKNOWN rather than PASS or WARN", () => {
  const evidence = safeEvidence();
  evidence.tls = undefined;
  evidence.dns = undefined;

  const result = determineVerdict(evidence, calculateScores(evidence));
  assert.equal(result.verdict, "UNKNOWN");
  assert.equal(result.riskFactors.some((factor) => factor.code === "INSUFFICIENT_EVIDENCE"), true);
});

test("risk factors expose every severity with stable codes, evidence, and recommendations", () => {
  const evidence = safeEvidence();
  evidence.security.ssrfProtection = { passed: false, resolvedIps: ["127.0.0.1"], reason: "private target" };
  evidence.network = { ...evidence.network, isDatacenter: true, isVpn: true };
  evidence.headerLeak = { detected: true, originIpExposed: false, headers: [{ name: "via", value: "proxy" }] };
  evidence.exitIp = { ip: "203.0.113.10", matchesDeclared: false };
  evidence.reputation = { score: 80, maliciousSignals: ["abuse_confidence_80"] };

  const result = determineVerdict(evidence, calculateScores(evidence));
  assert.deepEqual(new Set(result.riskFactors.map((factor) => factor.severity)), new Set([
    "info",
    "low",
    "medium",
    "high",
    "critical",
  ]));

  for (const factor of result.riskFactors) {
    assert.match(factor.code, /^[A-Z][A-Z0-9_]+$/);
    assert.equal(factor.message.length > 0, true);
    assert.equal(Object.keys(factor.evidence).length > 0, true);
    assert.equal(factor.recommendations.length > 0, true);
  }
  assert.equal(new Set(result.recommendations).size, result.recommendations.length);
});

test("datacenter and vpn classifications do not trigger risk warnings or anti-detection advice", () => {
  const evidence = safeEvidence();
  evidence.network = { isDatacenter: true, isVpn: true, isProxy: true, asn: "AS12345" };

  const result = determineVerdict(evidence, calculateScores(evidence));
  assert.equal(result.verdict, "PASS");
  assert.equal(result.riskFactors.every((factor) => factor.severity === "info"), true);
  for (const rec of result.recommendations) {
    assert.doesNotMatch(rec, /residential|mobile|anti-detection/i);
  }
});

test("observed warning takes precedence over unrelated incomplete evidence", () => {
  const evidence = safeEvidence();
  evidence.tls = undefined;
  evidence.dns = { resolved: true, dnsLeakDetected: true };

  const result = determineVerdict(evidence, calculateScores(evidence));
  assert.equal(result.verdict, "WARN");
  assert.equal(result.riskFactors.some((factor) => factor.code === "DNS_LEAK"), true);
  assert.equal(result.riskFactors.some((factor) => factor.code === "INSUFFICIENT_EVIDENCE"), true);
});

test("insufficient evidence alone stays UNKNOWN instead of escalating to WARN", () => {
  const evidence = safeEvidence();
  evidence.reputation = { score: null };

  const result = determineVerdict(evidence, calculateScores(evidence));
  assert.equal(result.verdict, "UNKNOWN");
  assert.deepEqual(result.riskFactors.map((factor) => factor.code), ["INSUFFICIENT_EVIDENCE"]);
});

const unstableCases: Array<[string, (evidence: AuditEvidence) => void]> = [
  ["explicit unstable status", (e) => { e.stability = { ...e.stability, stable: false }; }],
  ["success rate below 80 percent", (e) => { e.stability = { ...e.stability, successRate: 79 }; }],
  ["p95 latency above 3000ms", (e) => { e.stability = { ...e.stability, p95LatencyMs: 3_001 }; }],
];

for (const [name, mutate] of unstableCases) {
  test(`${name} produces explained reliability WARN`, () => {
    const evidence = safeEvidence();
    mutate(evidence);

    const result = determineVerdict(evidence, calculateScores(evidence));
    const factor = result.riskFactors.find((candidate) => candidate.code === "UNSTABLE_RELIABILITY");
    assert.equal(result.verdict, "WARN");
    assert.equal(factor?.severity, "medium");
    assert.equal(factor?.evidence.successRate, evidence.stability?.successRate);
    assert.equal(factor?.recommendations.length, 1);
  });
}

test("confirmed browser origin leak is critical despite incomplete evidence", () => {
  const evidence = safeEvidence();
  evidence.reputation = { score: null };
  evidence.browserAudit = { supported: true, navigationSucceeded: true, webrtcLeakDetected: true };

  const result = determineVerdict(evidence, calculateScores(evidence));
  const factor = result.riskFactors.find((candidate) => candidate.code === "BROWSER_ORIGIN_LEAK");
  assert.equal(result.verdict, "FAIL");
  assert.equal(factor?.severity, "critical");
  assert.equal(factor?.evidence.webrtcLeakDetected, true);
  assert.equal(factor?.recommendations.length, 1);
});

test("sub-threshold reputation deduction is explained without escalating verdict", () => {
  const evidence = safeEvidence();
  evidence.reputation = { score: 15, fraudScore: 10, spamScore: 20, maliciousSignals: [] };

  const result = determineVerdict(evidence, calculateScores(evidence));
  const factor = result.riskFactors.find((candidate) => candidate.code === "REPUTATION_CONCERNS");
  assert.equal(result.verdict, "PASS");
  assert.equal(calculateScores(evidence).reputation, 85);
  assert.equal(factor?.severity, "info");
  assert.equal(factor?.evidence.score, 15);
  assert.equal(factor?.recommendations.length, 1);
});

test("present probe objects with missing fields remain explicitly incomplete", () => {
  const evidence = safeEvidence();
  evidence.tls = {};
  evidence.dns = { dnsLeakDetected: null };
  evidence.headerLeak = {};
  evidence.reputation = { score: null };
  evidence.stability = {};

  const result = determineVerdict(evidence, calculateScores(evidence));
  const factor = result.riskFactors.find((candidate) => candidate.code === "INSUFFICIENT_EVIDENCE");
  assert.equal(result.verdict, "UNKNOWN");
  assert.deepEqual(factor?.evidence.missingMeasurements, [
    "tls.secure",
    "tls.certificateValid",
    "dns.dnsLeakDetected",
    "headerLeak.detected",
    "reputation.score",
    "stability.stable",
    "stability.successRate",
  ]);
});

test("supported browser audit without leak result keeps privacy unknown", () => {
  const evidence = safeEvidence();
  evidence.browserAudit = { supported: true, navigationSucceeded: true };

  const scores = calculateScores(evidence);
  const result = determineVerdict(evidence, scores);
  assert.equal(scores.privacy, null);
  assert.equal(result.verdict, "UNKNOWN");
  assert.equal(result.riskFactors.some((factor) => factor.code === "INSUFFICIENT_EVIDENCE"), true);
});
