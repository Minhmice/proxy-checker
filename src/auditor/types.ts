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
      protocol: string;
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

export interface SecurityRisk {
  id: string;
  level: "low" | "medium" | "high" | "critical";
  title: string;
  detail: string;
}

export interface ProbeResult<T = unknown> {
  name: string;
  status: "pass" | "warn" | "fail" | "skip";
  latencyMs: number;
  data?: T;
  error?: string;
}

export interface ProxyAuditResult {
  id: string;
  target: RedactedProxyInfo;
  verdict: AuditVerdict;
  scores: SecurityScore;
  risks: SecurityRisk[];
  probes: ProbeResult[];
  checkedAt: number;
}
