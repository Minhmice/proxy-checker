export type ProxyProtocol = "http" | "socks5";

export interface ParsedProxy {
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  protocol: ProxyProtocol;
  endpoint: string;
}

export interface CheckResult {
  endpoint: string;
  protocol: ProxyProtocol;
  status: "usable" | "dead";
  exit_ip: string | null;
  latency_ms: number;
  checked_at: number;
  successes: number;
  failures: number;
  last_error: string;
}

export type PoolTier = "active" | "reserve" | "dead" | "removed";

export type RemoteState = "linked" | "removed" | "revived" | "delete_failed";

export type TestState = "idle" | "queued" | "checking" | "retrying";

export type HealthStatus = "pending" | "checking" | "done";

export interface PoolRecord {
  localId: string;
  remoteId: string | null;
  remoteState: RemoteState;
  testState: TestState;
  name: string;
  proxyUrl: string;
  type: string;
  status: "usable" | "dead";
  tier: PoolTier;
  healthStatus?: HealthStatus;
  latency_ms: number | null;
  exit_ip: string | null;
  checked_at: number;
  isActiveOnRouter: boolean;
  successes: number;
  failures: number;
  firstFailure?: string;
  last_error?: string;
}

export interface PoolStats {
  total: number;
  active: number;
  reserve: number;
  dead: number;
  pending?: number;
  checking?: number;
  skipped?: string[];
}

export interface ActivityEntry {
  id: string;
  at: number;
  level: "info" | "warn" | "error" | "success";
  message: string;
}

export interface SyncProgress {
  phase: "idle" | "login" | "fetch" | "check" | "rank" | "activate" | "done";
  checked: number;
  total: number;
  remoteTotal: number;
}

export interface PoolStatus {
  running: boolean;
  configured: boolean;
  authMode?: "password" | "api_key" | "none";
  lastSyncAt: number | null;
  lastError: string;
  stats: PoolStats;
  syncIntervalMinutes: number;
  activeLimit: number;
  activity?: ActivityEntry[];
  syncProgress?: SyncProgress;
}

export interface MetricsSnapshot {
  timestamp: number;
  active: number;
  reserve: number;
  dead: number;
  avgLatencyMs: number | null;
}

export interface MetricsHistory {
  snapshots: MetricsSnapshot[];
}

export interface AppSettingsPublic {
  nineRouterUrl: string;
  controlPasswordSet: boolean;
  nineRouterPasswordSet: boolean;
  nineRouterApiKeySet: boolean;
  activePoolLimit: number;
  nineRouterSyncMinutes: number;
  checkConcurrency: number;
  checkTimeoutMs: number;
  proxyTtlMinutes: number;
}

export interface SettingsMeta {
  restartRequired: string[];
  source: "settings" | "env";
}

export interface SettingsResponse {
  settings: AppSettingsPublic;
  meta: SettingsMeta;
}

export interface SettingsUpdatePayload {
  controlPassword?: string;
  currentPassword?: string;
  nineRouterUrl?: string;
  nineRouterPassword?: string;
  nineRouterApiKey?: string;
  activePoolLimit?: number;
  nineRouterSyncMinutes?: number;
  checkConcurrency?: number;
  checkTimeoutMs?: number;
  proxyTtlMinutes?: number;
}

export interface NineRouterTestResult {
  ok: boolean;
  poolCount?: number;
  error?: string;
}

export interface DetailedDiagnosticResult {
  id: string;
  endpoint: string;
  protocol: ProxyProtocol;
  status: "SUCCESS" | "FAILED";
  statusCode: number | null;
  latencyMs: number;
  exitIp: string | null;
  country: string | null;
  isp: string | null;
  isProxyOrHosting: boolean | null;
  headerLeakage: boolean | null;
  leakedHeaders: string[];
  checkedAt: number;
  error?: string;
}

export interface DiagnosticJob {
  status: "idle" | "running" | "done" | "error";
  sourceFile: string | null;
  samplePercent: number;
  sampleCount: number | null;
  eligible: number;
  total: number;
  checked: number;
  startedAt: number | null;
  finishedAt: number | null;
  results: DetailedDiagnosticResult[];
  error: string;
  running?: boolean;
}
