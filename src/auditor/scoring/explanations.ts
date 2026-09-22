import type { RiskFactor } from "../types.js";
import type { AuditEvidence } from "./scores.js";

export interface ExplainedRiskFactor extends RiskFactor {
  code: string;
  message: string;
  evidence: Record<string, unknown>;
  recommendations: string[];
}

export function explainRiskFactors(evidence: AuditEvidence): ExplainedRiskFactor[] {
  const factors: ExplainedRiskFactor[] = [];
  const add = (
    code: string,
    severity: ExplainedRiskFactor["severity"],
    title: string,
    message: string,
    evidenceValue: Record<string, unknown>,
    recommendations: string[],
    category: string,
  ) => {
    factors.push({
      id: `RISK-${String(factors.length + 1).padStart(2, "0")}`,
      code,
      severity,
      title,
      description: message,
      message,
      category,
      evidence: evidenceValue,
      recommendations,
    });
  };

  if (evidence.security.ssrfProtection.passed === false) {
    add("SSRF_VIOLATION", "critical", "SSRF policy violation", "Target resolved to a disallowed address.", { ssrf: evidence.security.ssrfProtection }, ["Block target and investigate SSRF path before use."], "transport");
  }
  if (evidence.connectivity?.reachable === false) {
    add("CONNECTION_FAILED", "critical", "Proxy unreachable", "Proxy could not establish a connection.", { error: evidence.connectivity.error }, ["Remove proxy from rotation and verify host, port, and upstream availability."], "reliability");
  }
  if (evidence.tls && (evidence.tls.certificateValid === false || evidence.tls.secure === false)) {
    add("TLS_CERTIFICATE_INVALID", "critical", "TLS certificate invalid", "TLS certificate or secure handshake validation failed.", { error: evidence.tls.error, certificateValid: evidence.tls.certificateValid }, ["Reject proxy until certificate chain and hostname validate."], "transport");
  }
  if (evidence.contentIntegrity?.spkiValid === false) {
    add("SPKI_MISMATCH", "critical", "SPKI pin mismatch", "Observed certificate public key differs from pinned key.", { spkiValid: false, error: evidence.contentIntegrity.error }, ["Reject endpoint and investigate certificate interception."], "transport");
  }
  if (evidence.contentIntegrity && (evidence.contentIntegrity.bodyMatches === false || evidence.contentIntegrity.intact === false)) {
    add("CONTENT_TAMPERING", "critical", "Content integrity failure", "Response content or headers differed from trusted content.", { intact: evidence.contentIntegrity.intact, bodyMatches: evidence.contentIntegrity.bodyMatches, injectedScripts: evidence.contentIntegrity.injectedScripts }, ["Stop using proxy and inspect for content injection or TLS stripping."], "transport");
  }
  if (evidence.headerLeak?.originIpExposed === true) {
    add("ORIGIN_IP_EXPOSED", "critical", "Origin IP exposed", "Proxy response revealed the direct origin address.", { originIpExposed: true, headers: evidence.headerLeak.headers }, ["Rotate origin address and remove proxy headers that disclose it."], "privacy");
  }
  if (evidence.browserAudit?.webrtcLeakDetected === true) {
    add("BROWSER_ORIGIN_LEAK", "critical", "Browser origin leak", "Browser WebRTC observation exposed client or origin IP directly.", { webrtcLeakDetected: true, browserAudit: evidence.browserAudit }, ["Disable WebRTC leakage or enforce proxy-only browser networking."], "privacy");
  }
  if (evidence.headerLeak?.detected === true && evidence.headerLeak.originIpExposed !== true) {
    add("HEADER_LEAK", "medium", "Proxy header leak", "Response contains headers that disclose proxy or client metadata.", { detected: true, headers: evidence.headerLeak.headers }, ["Strip forwarding and proxy-identifying headers at the proxy."], "privacy");
  }
  if (evidence.connectivity?.latencyMs !== undefined && evidence.connectivity.latencyMs >= 2000) {
    add("HIGH_LATENCY", "medium", "High proxy latency", "Proxy latency may degrade application reliability.", { latencyMs: evidence.connectivity.latencyMs }, ["Prefer lower-latency proxy or tune upstream timeout."], "reliability");
  }
  if (
    evidence.stability &&
    (evidence.stability.stable === false ||
      (typeof evidence.stability.successRate === "number" && evidence.stability.successRate < 80) ||
      (typeof evidence.stability.p95LatencyMs === "number" && evidence.stability.p95LatencyMs > 3000))
  ) {
    add(
      "UNSTABLE_RELIABILITY",
      "medium",
      "Unstable proxy reliability",
      "Proxy reliability checks fell below stability thresholds.",
      {
        stable: evidence.stability.stable,
        successRate: evidence.stability.successRate,
        packetLossPercent: evidence.stability.packetLossPercent,
        p95LatencyMs: evidence.stability.p95LatencyMs,
      },
      ["Replace or deprioritize proxy due to packet loss, failures, or latency spikes."],
      "reliability",
    );
  }
  if (evidence.reputation?.maliciousSignals && evidence.reputation.maliciousSignals.length > 0) {
    add("ABUSE_HISTORY", "high", "Abuse history detected", "Reputation providers reported abuse or fraud signals.", { maliciousSignals: evidence.reputation.maliciousSignals, score: evidence.reputation.score }, ["Quarantine proxy and review provider reports before reuse."], "reputation");
  } else if (typeof evidence.reputation?.score === "number" && evidence.reputation.score > 0) {
    add(
      "REPUTATION_CONCERNS",
      "info",
      "Reputation score deduction",
      "Measured reputation provider signals deducted safety points without confirmed abuse listing.",
      {
        score: evidence.reputation.score,
        fraudScore: evidence.reputation.fraudScore,
        spamScore: evidence.reputation.spamScore,
      },
      ["Monitor provider scores and rotate proxy if score trend worsens."],
      "reputation",
    );
  }
  if (evidence.rotation?.exitIpChanged === true) {
    add("UNSTABLE_EXIT_IP", "medium", "Exit IP changed", "Proxy returned different exit addresses across observations.", { distinctIpsObserved: evidence.rotation.distinctIpsObserved, changesObserved: evidence.rotation.changesObserved }, ["Use sticky sessions or a proxy with stable egress identity."], "reliability");
  }
  if (evidence.dns?.dnsLeakDetected === true) {
    add("DNS_LEAK", "high", "DNS leak detected", "DNS resolution escaped expected proxy path.", { dnsLeakDetected: true, resolverAsn: evidence.dns.resolverAsn }, ["Use remote DNS resolution and verify resolver ownership."], "privacy");
  }
  if (evidence.network?.isDatacenter === true) {
    add("DATACENTER_EXIT", "info", "Datacenter network context", "Exit address belongs to a datacenter network operator.", { isDatacenter: true, asn: evidence.network.asn }, ["Note hosting provider infrastructure when evaluating operator trust."], "network");
  }
  if (evidence.network?.isVpn === true) {
    add("VPN_EXIT", "info", "VPN network context", "Exit address belongs to a VPN provider network.", { isVpn: true, asn: evidence.network.asn }, ["Verify provider tunnel configuration aligns with security policy."], "network");
  }
  if (evidence.network?.isProxy === true) {
    add("PROXY_NETWORK_CONTEXT", "info", "Public proxy network context", "Exit address is classified as a public or commercial proxy service.", { isProxy: true, asn: evidence.network.asn }, ["Evaluate operator trustworthiness for sensitive traffic."], "network");
  }
  if (evidence.exitIp?.matchesDeclared === false) {
    add("EXIT_IP_MISMATCH", "low", "Exit IP mismatch", "Observed exit location or identity differs from declaration.", { ip: evidence.exitIp.ip, matchesDeclared: false }, ["Confirm proxy inventory and declared egress metadata."], "privacy");
  }

  const missingMeasurements: string[] = [];
  if (typeof evidence.tls?.secure !== "boolean") missingMeasurements.push("tls.secure");
  if (typeof evidence.tls?.certificateValid !== "boolean") missingMeasurements.push("tls.certificateValid");
  if (typeof evidence.dns?.dnsLeakDetected !== "boolean") missingMeasurements.push("dns.dnsLeakDetected");
  if (typeof evidence.headerLeak?.detected !== "boolean") missingMeasurements.push("headerLeak.detected");
  if (typeof evidence.reputation?.score !== "number") missingMeasurements.push("reputation.score");
  if (typeof evidence.stability?.stable !== "boolean") missingMeasurements.push("stability.stable");
  if (typeof evidence.stability?.successRate !== "number") missingMeasurements.push("stability.successRate");
  if (evidence.browserAudit?.supported === true && typeof evidence.browserAudit.webrtcLeakDetected !== "boolean") {
    missingMeasurements.push("browserAudit.webrtcLeakDetected");
  }

  if (missingMeasurements.length > 0) {
    add(
      "INSUFFICIENT_EVIDENCE",
      "low",
      "Incomplete audit evidence",
      "One or more required probe measurements are missing.",
      { missingMeasurements },
      ["Run missing probes before relying on this verdict."],
      "audit",
    );
  }

  return factors;
}

export function recommendationsFromRiskFactors(factors: ExplainedRiskFactor[]): string[] {
  const recommendations: string[] = [];
  for (const factor of factors) {
    for (const recommendation of factor.recommendations) {
      if (recommendation && !recommendations.includes(recommendation)) recommendations.push(recommendation);
    }
  }
  return recommendations;
}
