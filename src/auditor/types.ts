export type ProxyProtocol = "http" | "https" | "socks4" | "socks5";

export interface ParsedProxyInput {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface RedactedProxyInfo {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: undefined;
}

export type ProxyInput =
  | string
  | {
      protocol: ProxyProtocol;
      host: string;
      port: number;
      username?: string;
      password?: string;
    };

export type AuditVerdict = "PASS" | "WARN" | "FAIL" | "UNKNOWN";

export interface SecurityScore {
  overallSafety: number | null;
  transportSecurity: number | null;
  privacy: number | null;
  reputation: number | null;
  reliability: number | null;
}

export interface RiskFactor {
  id: string;
  code?: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  title: string;
  description: string;
  message?: string;
  category?: string;
  evidence?: Record<string, unknown>;
}

export interface SecurityAuditResult {
  inputValidation: {
    valid: boolean;
    reason?: string;
  };
  ssrfProtection: {
    passed: boolean;
    resolvedIps: string[];
    reason?: string;
    allowPrivateTargets?: boolean;
  };
}

export interface ConnectivityResult {
  reachable: boolean;
  latencyMs?: number;
  error?: string;
  [key: string]: unknown;
}

export interface BaselineResult {
  established: boolean;
  statusCode?: number;
  ip?: string;
  latencyMs?: number;
  error?: string;
  [key: string]: unknown;
}

export interface ExitIpResult {
  ip?: string;
  country?: string;
  region?: string;
  city?: string;
  timezone?: string;
  matchesDeclared?: boolean;
  [key: string]: unknown;
}

export interface NetworkResult {
  asn?: string;
  organization?: string;
  isDatacenter?: boolean;
  isResidential?: boolean;
  isMobile?: boolean;
  isTor?: boolean;
  isVpn?: boolean;
  isProxy?: boolean;
  [key: string]: unknown;
}

export interface TlsResult {
  secure?: boolean;
  protocol?: string;
  cipher?: string;
  certificateValid?: boolean;
  alpn?: string;
  error?: string;
  [key: string]: unknown;
}

export interface DnsResult {
  resolved?: boolean;
  addresses?: string[];
  dnsLeakDetected?: boolean | null;
  resolverAsn?: string;
  error?: string;
  [key: string]: unknown;
}

export interface HeaderLeakResult {
  detected?: boolean;
  headers?: Array<{
    name: string;
    value: string;
    revealsRealIp?: boolean;
  }>;
  viaPresent?: boolean;
  xForwardedForPresent?: boolean;
  [key: string]: unknown;
}

export interface ContentIntegrityResult {
  intact?: boolean;
  injectedScripts?: string[];
  modifiedHeaders?: string[];
  tlsStripping?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface ReputationResult {
  score?: number | null;
  blacklists?: Array<{
    name: string;
    listed: boolean;
    details?: string;
  }>;
  spamScore?: number;
  fraudScore?: number;
  [key: string]: unknown;
}

export interface StabilityResult {
  stable?: boolean;
  samplesAttempted?: number;
  samplesSucceeded?: number;
  jitterMs?: number;
  packetLossPercent?: number;
  [key: string]: unknown;
}

export interface RotationResult {
  supported?: boolean;
  exitIpChanged?: boolean;
  distinctIpsObserved?: string[];
  rotationIntervalSeconds?: number;
  [key: string]: unknown;
}

export interface BrowserAuditResult {
  supported?: boolean;
  navigationSucceeded?: boolean;
  webrtcLeakDetected?: boolean;
  timezoneMismatch?: boolean;
  canvasFingerprintConsistent?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface AuditMetadata {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  version: string;
  toolVersion: string;
  schemaVersion: string;
}

export interface ProxyAuditResult {
  proxy: RedactedProxyInfo;
  verdict: AuditVerdict;
  scores: SecurityScore;
  security: SecurityAuditResult;
  connectivity?: ConnectivityResult;
  baseline?: BaselineResult;
  exitIp?: ExitIpResult;
  network?: NetworkResult;
  tls?: TlsResult;
  dns?: DnsResult;
  headerLeak?: HeaderLeakResult;
  contentIntegrity?: ContentIntegrityResult;
  reputation?: ReputationResult;
  stability?: StabilityResult;
  rotation?: RotationResult;
  browserAudit?: BrowserAuditResult;
  riskFactors: RiskFactor[];
  recommendations: string[];
  metadata: AuditMetadata;
}
