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
  } else if (evidence.headerLeak?.detected === true) {
    add("HEADER_LEAK", "medium", "Proxy header leak", "Response contains headers that disclose proxy or client metadata.", { detected: true, headers: evidence.headerLeak.headers }, ["Strip forwarding and proxy-identifying headers at the proxy."], "privacy");
  }
  if (evidence.connectivity?.latencyMs !== undefined && evidence.connectivity.latencyMs >= 2000) {
    add("HIGH_LATENCY", "medium", "High proxy latency", "Proxy latency may degrade application reliability.", { latencyMs: evidence.connectivity.latencyMs }, ["Prefer lower-latency proxy or tune upstream timeout."], "reliability");
  }
  if (evidence.reputation?.maliciousSignals && evidence.reputation.maliciousSignals.length > 0) {
    add("ABUSE_HISTORY", "high", "Abuse history detected", "Reputation providers reported abuse or fraud signals.", { maliciousSignals: evidence.reputation.maliciousSignals, score: evidence.reputation.score }, ["Quarantine proxy and review provider reports before reuse."], "reputation");
  }
  if (evidence.rotation?.exitIpChanged === true) {
    add("UNSTABLE_EXIT_IP", "medium", "Exit IP changed", "Proxy returned different exit addresses across observations.", { distinctIpsObserved: evidence.rotation.distinctIpsObserved, changesObserved: evidence.rotation.changesObserved }, ["Use sticky sessions or a proxy with stable egress identity."], "reliability");
  }
  if (evidence.dns?.dnsLeakDetected === true) {
    add("DNS_LEAK", "high", "DNS leak detected", "DNS resolution escaped expected proxy path.", { dnsLeakDetected: true, resolverAsn: evidence.dns.resolverAsn }, ["Use remote DNS resolution and verify resolver ownership."], "privacy");
  }
  if (evidence.network?.isDatacenter === true) {
    add("DATACENTER_EXIT", "low", "Datacenter exit", "Exit address belongs to a datacenter network.", { isDatacenter: true, asn: evidence.network.asn }, ["Use residential or mobile egress when target policy requires it."], "privacy");
  }
  if (evidence.network?.isVpn === true) {
    add("VPN_EXIT", "info", "VPN exit network", "Exit address belongs to a VPN network.", { isVpn: true, asn: evidence.network.asn }, ["Confirm VPN egress is permitted for this use case."], "privacy");
  }
  if (evidence.exitIp?.matchesDeclared === false) {
    add("EXIT_IP_MISMATCH", "low", "Exit IP mismatch", "Observed exit location or identity differs from declaration.", { ip: evidence.exitIp.ip, matchesDeclared: false }, ["Confirm proxy inventory and declared egress metadata."], "privacy");
  }

  const measured = [evidence.tls, evidence.dns, evidence.headerLeak, evidence.contentIntegrity, evidence.reputation, evidence.stability].filter(Boolean).length;
  if (measured < 6) {
    add("INSUFFICIENT_EVIDENCE", "low", "Incomplete audit evidence", "One or more required probes did not return measurements.", { measuredProbeGroups: measured, requiredProbeGroups: 6 }, ["Run missing probes before relying on this verdict."], "audit");
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
