import type { AuditVerdict, ProxyAuditResult, RiskFactor } from "../types.js";
import type { BulkRecord } from "./bulk.js";

const CREDENTIAL_URL_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/@\s]+)@/g;
const FORMULA_TRIGGER_CHARS: Record<string, true> = {
  "=": true,
  "+": true,
  "-": true,
  "@": true,
  "\t": true,
  "\r": true,
};

export function sanitizeCredentials(text: string): string {
  return text.replace(CREDENTIAL_URL_PATTERN, (_match, prefix: string, userinfo: string) => {
    const colonIndex = userinfo.indexOf(":");
    if (colonIndex === -1) {
      return `${prefix}${userinfo}:********@`;
    }
    const username = userinfo.slice(0, colonIndex);
    return `${prefix}${username}:********@`;
  });
}

export function sanitizeResult(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "string" ? sanitizeCredentials(value) : value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeResult(entry));
  }

  const output: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(value)) {
    if (key.toLowerCase().includes("password")) {
      continue;
    }
    output[key] = sanitizeResult(prop);
  }
  return output;
}

function formatScore(score: number | null | undefined): string {
  return score === null || score === undefined ? "Unknown" : `${score}/100`;
}

function formatRisk(risk: RiskFactor): string {
  const code = risk.code ? ` (${risk.code})` : "";
  return `  * [${risk.severity.toUpperCase()}] ${risk.title}${code}: ${sanitizeCredentials(risk.description || risk.message || "")}`;
}

export function formatHumanResult(result: ProxyAuditResult): string {
  const sanitized = sanitizeResult(result) as ProxyAuditResult;
  const proxyTarget = sanitized.proxy.username
    ? `${sanitized.proxy.protocol}://${sanitized.proxy.username}@${sanitized.proxy.host}:${sanitized.proxy.port}`
    : `${sanitized.proxy.protocol}://${sanitized.proxy.host}:${sanitized.proxy.port}`;

  const lines: string[] = [
    `Proxy safety audit: ${proxyTarget}`,
    `Verdict: ${sanitized.verdict}`,
    "",
    "Component scores:",
    `  * Overall safety:    ${formatScore(sanitized.scores?.overallSafety)}`,
    `  * Transport security: ${formatScore(sanitized.scores?.transportSecurity)}`,
    `  * Privacy:           ${formatScore(sanitized.scores?.privacy)}`,
    `  * Reputation:        ${formatScore(sanitized.scores?.reputation)}`,
    `  * Reliability:       ${formatScore(sanitized.scores?.reliability)}`,
    "",
    "Exit & Network:",
    `  * Exit IP:           ${sanitized.exitIp?.ip ?? "Unknown"}`,
    `  * Country:           ${sanitized.exitIp?.country ?? "Unknown"}`,
    `  * ASN:               ${sanitized.network?.asn ?? "Unknown"}`,
    `  * Organization/ISP:  ${sanitized.network?.organization ?? "Unknown"}`,
    `  * Datacenter:        ${sanitized.network?.isDatacenter === undefined ? "Unknown" : sanitized.network.isDatacenter ? "Yes" : "No"}`,
    `  * Residential:       ${sanitized.network?.isResidential === undefined ? "Unknown" : sanitized.network.isResidential ? "Yes" : "No"}`,
    `  * Tor / VPN:         ${sanitized.network?.isTor ? "Tor" : sanitized.network?.isVpn ? "VPN" : "No"}`,
    "",
    "Security & Transport:",
    `  * TLS Secure:        ${sanitized.tls?.secure === undefined ? "Unknown" : sanitized.tls.secure ? "Yes" : "No"}`,
    `  * TLS Protocol:      ${sanitized.tls?.protocol ?? "Unknown"}`,
    `  * Cert Valid:        ${sanitized.tls?.certificateValid === undefined ? "Unknown" : sanitized.tls.certificateValid ? "Yes" : "No"}`,
    `  * Origin IP Leak:    ${sanitized.headerLeak?.detected === undefined ? "Unknown" : sanitized.headerLeak.detected ? "Detected" : "Clean"}`,
    `  * DNS Leak:          ${sanitized.dns?.dnsLeakDetected === undefined || sanitized.dns?.dnsLeakDetected === null ? "Unknown" : sanitized.dns.dnsLeakDetected ? "Detected" : "Clean"}`,
    `  * Content Intact:    ${sanitized.contentIntegrity?.intact === undefined ? "Unknown" : sanitized.contentIntegrity.intact ? "Yes" : "Tampered"}`,
    "",
    "Reputation:",
    `  * Reputation Score:  ${sanitized.reputation?.score === null || sanitized.reputation?.score === undefined ? "Unknown" : `${sanitized.reputation.score}/100`}`,
    `  * Fraud Score:       ${sanitized.reputation?.fraudScore === undefined ? "Unknown" : sanitized.reputation.fraudScore}`,
    `  * Spam Score:        ${sanitized.reputation?.spamScore === undefined ? "Unknown" : sanitized.reputation.spamScore}`,
    `  * Blacklists:        ${sanitized.reputation?.blacklists ? `${sanitized.reputation.blacklists.filter((b) => b.listed).length} listed` : "Unknown"}`,
    "",
    "Reliability:",
    `  * Reachable:         ${sanitized.connectivity?.reachable === undefined ? "Unknown" : sanitized.connectivity.reachable ? "Yes" : "No"}`,
    `  * Latency:           ${sanitized.connectivity?.latencyMs === undefined ? "Unknown" : `${sanitized.connectivity.latencyMs}ms`}`,
    `  * Packet Loss:       ${sanitized.stability?.packetLossPercent === undefined ? "Unknown" : `${sanitized.stability.packetLossPercent}%`}`,
    `  * Jitter:            ${sanitized.stability?.jitterMs === undefined ? "Unknown" : `${sanitized.stability.jitterMs}ms`}`,
    `  * Rotation Observed: ${sanitized.rotation?.exitIpChanged === undefined ? "Unknown" : sanitized.rotation.exitIpChanged ? "Yes" : "No"}`,
  ];

  lines.push("", "Risk factors:");
  if (sanitized.riskFactors && sanitized.riskFactors.length > 0) {
    for (const risk of sanitized.riskFactors) {
      lines.push(formatRisk(risk));
    }
  } else {
    lines.push("  (none)");
  }

  lines.push("", "Recommendations:");
  if (sanitized.recommendations && sanitized.recommendations.length > 0) {
    for (const rec of sanitized.recommendations) {
      lines.push(`  * ${sanitizeCredentials(rec)}`);
    }
  } else {
    lines.push("  (none)");
  }

  return lines.join("\n");
}

export function escapeCsvCell(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const sanitizedCredentials = sanitizeCredentials(raw);
  const formulaProtected = sanitizedCredentials.length > 0 && FORMULA_TRIGGER_CHARS[sanitizedCredentials[0]]
    ? `'${sanitizedCredentials}`
    : sanitizedCredentials;

  if (formulaProtected.includes(",") || formulaProtected.includes("\"") || formulaProtected.includes("\n") || formulaProtected.includes("\r")) {
    return `"${formulaProtected.replaceAll("\"", "\"\"")}"`;
  }
  return formulaProtected;
}

function resolveNetworkType(network?: ProxyAuditResult["network"]): string {
  if (!network) {
    return "";
  }
  if (network.isResidential) {
    return "residential";
  }
  if (network.isDatacenter) {
    return "datacenter";
  }
  if (network.isMobile) {
    return "mobile";
  }
  if (network.isTor) {
    return "tor";
  }
  if (network.isVpn) {
    return "vpn";
  }
  return "";
}

export function formatCsvRecords(records: BulkRecord[]): string {
  const headers = [
    "line",
    "status",
    "proxy",
    "protocol",
    "host",
    "port",
    "verdict",
    "exit_ip",
    "asn",
    "isp",
    "country",
    "network_type",
    "tls_ok",
    "origin_ip_leak",
    "dns_leak",
    "fraud_score",
    "abuse_confidence",
    "success_rate",
    "p50_latency",
    "p95_latency",
    "exit_ip_changes",
    "warnings",
    "overall_score",
    "transport_score",
    "privacy_score",
    "reputation_score",
    "reliability_score",
    "risks",
    "recommendations",
    "error",
  ];

  const lines: string[] = [headers.join(",")];
  for (const record of records) {
    if (record.status === "ok") {
      const { result } = record;
      const sanitized = sanitizeResult(result) as ProxyAuditResult;
      const proxyTarget = sanitized.proxy.username
        ? `${sanitized.proxy.protocol}://${sanitized.proxy.username}@${sanitized.proxy.host}:${sanitized.proxy.port}`
        : `${sanitized.proxy.protocol}://${sanitized.proxy.host}:${sanitized.proxy.port}`;
      const risks = (sanitized.riskFactors || []).map((risk) => `${risk.severity}:${risk.title}`).join("; ");
      const warnings = (sanitized.riskFactors || [])
        .filter((risk) => risk.severity === "medium" || risk.severity === "low" || risk.severity === "info")
        .map((risk) => risk.title)
        .join("; ");
      const recs = (sanitized.recommendations || []).join("; ");

      const exitIp = sanitized.exitIp?.ip ?? "";
      const asn = sanitized.network?.asn ?? "";
      const isp = sanitized.network?.organization ?? "";
      const country = sanitized.exitIp?.country ?? "";
      const networkType = resolveNetworkType(sanitized.network);
      const tlsOk = sanitized.tls?.secure !== undefined ? String(sanitized.tls.secure) : "";
      const originIpLeak = sanitized.headerLeak?.detected !== undefined ? String(sanitized.headerLeak.detected) : "";
      const dnsLeak = sanitized.dns?.dnsLeakDetected !== undefined && sanitized.dns?.dnsLeakDetected !== null ? String(sanitized.dns.dnsLeakDetected) : "";
      const fraudScore = sanitized.reputation?.fraudScore ?? "";
      const abuseConfidence = typeof sanitized.reputation?.spamScore === "number" ? sanitized.reputation.spamScore : "";
      const samplesAttempted = sanitized.stability?.samplesAttempted;
      const samplesSucceeded = sanitized.stability?.samplesSucceeded;
      const successRate = typeof samplesAttempted === "number" && samplesAttempted > 0 && typeof samplesSucceeded === "number"
        ? (samplesSucceeded / samplesAttempted) * 100
        : "";
      const p50Latency = typeof sanitized.baseline?.latencyMs === "number" ? sanitized.baseline.latencyMs : (sanitized.connectivity?.latencyMs ?? "");
      const p95Latency = typeof sanitized.connectivity?.latencyMs === "number" ? sanitized.connectivity.latencyMs : "";
      const exitIpChanges = sanitized.rotation?.exitIpChanged !== undefined ? String(sanitized.rotation.exitIpChanged) : "";

      lines.push([
        escapeCsvCell(record.line),
        escapeCsvCell(record.status),
        escapeCsvCell(proxyTarget),
        escapeCsvCell(sanitized.proxy.protocol),
        escapeCsvCell(sanitized.proxy.host),
        escapeCsvCell(sanitized.proxy.port),
        escapeCsvCell(sanitized.verdict),
        escapeCsvCell(exitIp),
        escapeCsvCell(asn),
        escapeCsvCell(isp),
        escapeCsvCell(country),
        escapeCsvCell(networkType),
        escapeCsvCell(tlsOk),
        escapeCsvCell(originIpLeak),
        escapeCsvCell(dnsLeak),
        escapeCsvCell(fraudScore),
        escapeCsvCell(abuseConfidence),
        escapeCsvCell(successRate),
        escapeCsvCell(p50Latency),
        escapeCsvCell(p95Latency),
        escapeCsvCell(exitIpChanges),
        escapeCsvCell(warnings),
        escapeCsvCell(sanitized.scores?.overallSafety ?? ""),
        escapeCsvCell(sanitized.scores?.transportSecurity ?? ""),
        escapeCsvCell(sanitized.scores?.privacy ?? ""),
        escapeCsvCell(sanitized.scores?.reputation ?? ""),
        escapeCsvCell(sanitized.scores?.reliability ?? ""),
        escapeCsvCell(risks),
        escapeCsvCell(recs),
        escapeCsvCell(""),
      ].join(","));
    } else {
      lines.push([
        escapeCsvCell(record.line),
        escapeCsvCell(record.status),
        escapeCsvCell(""),
        escapeCsvCell(""),
        escapeCsvCell(""),
        escapeCsvCell(""),
        escapeCsvCell("FAIL" as AuditVerdict),
        escapeCsvCell(""),
        escapeCsvCell(""),
        escapeCsvCell(""),
        escapeCsvCell(""),
        escapeCsvCell(""),
        escapeCsvCell(""),
        escapeCsvCell(""),
        escapeCsvCell(""),
        escapeCsvCell(""),
        escapeCsvCell(""),
        escapeCsvCell(""),
        escapeCsvCell(""),
        escapeCsvCell(""),
        escapeCsvCell(""),
        escapeCsvCell(""),
        escapeCsvCell(""),
        escapeCsvCell(""),
        escapeCsvCell(""),
        escapeCsvCell(""),
        escapeCsvCell(""),
        escapeCsvCell(""),
        escapeCsvCell(""),
        escapeCsvCell(record.error),
      ].join(","));
    }
  }

  return `${lines.join("\r\n")}\r\n`;
}
