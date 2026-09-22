import type {
  BaselineResult,
  BrowserAuditResult,
  ConnectivityResult,
  ContentIntegrityResult,
  DnsResult,
  ExitIpResult,
  HeaderLeakResult,
  NetworkResult,
  ReputationResult,
  RotationResult,
  SecurityAuditResult,
  SecurityScore,
  StabilityResult,
  TlsResult,
} from "../types.js";

export interface AuditEvidence {
  security: SecurityAuditResult;
  connectivity?: ConnectivityResult;
  baseline?: BaselineResult;
  exitIp?: ExitIpResult;
  network?: NetworkResult;
  tls?: TlsResult & { possibleMitm?: boolean; spkiSha256?: string; certDifference?: boolean };
  dns?: DnsResult;
  headerLeak?: HeaderLeakResult & { originIpExposed?: boolean };
  contentIntegrity?: ContentIntegrityResult & { spkiValid?: boolean; bodyMatches?: boolean };
  reputation?: ReputationResult & { privacySignals?: string[]; maliciousSignals?: string[] };
  stability?: StabilityResult & { successRate?: number; p95LatencyMs?: number };
  rotation?: RotationResult & { changesObserved?: number };
  browserAudit?: BrowserAuditResult;
}

export type ScoresResult = SecurityScore;

export const SCORE_WEIGHTS = {
  transportSecurity: 0.35,
  privacy: 0.3,
  reputation: 0.2,
  reliability: 0.15,
} as const;

function round(value: number): number {
  return Math.round(value);
}

function bounded(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function transportScore(evidence: AuditEvidence): number | null {
  const tls = evidence.tls;
  const integrity = evidence.contentIntegrity;
  if (!tls || typeof tls.secure !== "boolean" || typeof tls.certificateValid !== "boolean") return null;
  if (!integrity || typeof integrity.intact !== "boolean") return null;
  const tlsScore = tls.secure && tls.certificateValid ? 100 : 0;
  const integrityScore = integrity.intact ? 100 : 0;
  return Math.min(tlsScore, integrityScore);
}

function privacyScore(evidence: AuditEvidence): number | null {
  const dns = evidence.dns;
  const headers = evidence.headerLeak;
  const exitIp = evidence.exitIp;
  if (!dns || typeof dns.dnsLeakDetected !== "boolean") return null;
  if (!headers || typeof headers.detected !== "boolean") return null;
  if (!exitIp || typeof exitIp.ip !== "string") return null;

  let score = dns.dnsLeakDetected ? 50 : 100;
  if (headers.originIpExposed === true) score = 0;
  else if (headers.detected) score = Math.min(score, 70);
  if (exitIp.matchesDeclared === false) score = Math.min(score, 70);
  if (evidence.browserAudit?.webrtcLeakDetected === true) score = 0;
  return score;
}

function reputationScore(evidence: AuditEvidence): number | null {
  const score = evidence.reputation?.score;
  return typeof score === "number" ? bounded(100 - score) : null;
}

function reliabilityScore(evidence: AuditEvidence): number | null {
  const connectivity = evidence.connectivity;
  const stability = evidence.stability;
  if (!connectivity || typeof connectivity.reachable !== "boolean") return null;
  if (!stability || typeof stability.stable !== "boolean") return null;
  if (typeof stability.successRate === "number") return bounded(stability.successRate);
  return connectivity.reachable ? 100 : 0;
}

export function calculateScores(evidence: AuditEvidence): ScoresResult {
  const transportSecurity = transportScore(evidence);
  const privacy = privacyScore(evidence);
  const reputation = reputationScore(evidence);
  const reliability = reliabilityScore(evidence);
  const values = [transportSecurity, privacy, reputation, reliability];
  const overallSafety = values.every((value): value is number => value !== null)
    ? round(
        transportSecurity! * SCORE_WEIGHTS.transportSecurity +
          privacy! * SCORE_WEIGHTS.privacy +
          reputation! * SCORE_WEIGHTS.reputation +
          reliability! * SCORE_WEIGHTS.reliability,
      )
    : null;

  return { overallSafety, transportSecurity, privacy, reputation, reliability };
}
