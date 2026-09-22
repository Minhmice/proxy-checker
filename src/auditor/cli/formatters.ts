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
  return text.replace(CREDENTIAL_URL_PATTERN, "$1[REDACTED]@");
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

function formatRisk(risk: RiskFactor): string {
  const code = risk.code ? ` (${risk.code})` : "";
  return `  * [${risk.severity.toUpperCase()}] ${risk.title}${code}: ${sanitizeCredentials(risk.description || risk.message || "")}`;
}

export function formatHumanResult(result: ProxyAuditResult): string {
  const sanitized = sanitizeResult(result) as ProxyAuditResult;
  const proxyTarget = `${sanitized.proxy.protocol}://${sanitized.proxy.host}:${sanitized.proxy.port}`;
  const lines: string[] = [
    `Proxy safety audit: ${proxyTarget}`,
    `Verdict: ${sanitized.verdict}`,
    "",
    "Component scores:",
    `  * Overall safety:    ${sanitized.scores?.overallSafety === null || sanitized.scores?.overallSafety === undefined ? "Unknown" : `${sanitized.scores.overallSafety}/100`}`,
    `  * Transport security: ${sanitized.scores?.transportSecurity === null || sanitized.scores?.transportSecurity === undefined ? "Unknown" : `${sanitized.scores.transportSecurity}/100`}`,
    `  * Privacy:           ${sanitized.scores?.privacy === null || sanitized.scores?.privacy === undefined ? "Unknown" : `${sanitized.scores.privacy}/100`}`,
    `  * Reputation:        ${sanitized.scores?.reputation === null || sanitized.scores?.reputation === undefined ? "Unknown" : `${sanitized.scores.reputation}/100`}`,
    `  * Reliability:       ${sanitized.scores?.reliability === null || sanitized.scores?.reliability === undefined ? "Unknown" : `${sanitized.scores.reliability}/100`}`,
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

export function formatCsvRecords(records: BulkRecord[]): string {
  const headers = [
    "line",
    "status",
    "proxy",
    "protocol",
    "host",
    "port",
    "verdict",
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
      const proxyTarget = `${sanitized.proxy.protocol}://${sanitized.proxy.host}:${sanitized.proxy.port}`;
      const risks = (sanitized.riskFactors || []).map((risk) => `${risk.severity}:${risk.title}`).join("; ");
      const recs = (sanitized.recommendations || []).join("; ");
      lines.push([
        escapeCsvCell(record.line),
        escapeCsvCell(record.status),
        escapeCsvCell(proxyTarget),
        escapeCsvCell(sanitized.proxy.protocol),
        escapeCsvCell(sanitized.proxy.host),
        escapeCsvCell(sanitized.proxy.port),
        escapeCsvCell(sanitized.verdict),
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
        escapeCsvCell(record.error),
      ].join(","));
    }
  }

  return `${lines.join("\r\n")}\r\n`;
}
