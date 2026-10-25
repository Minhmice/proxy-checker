import type { FleetWireGuardSettings } from "../proxyfleet/wireguard.js";
export type AuditVerdict = "PASS" | "WARN" | "FAIL" | "UNKNOWN";
export type ProbeStatus =
  | "PASS"
  | "WARN"
  | "FAIL"
  | "UNKNOWN"
  | "UNSUPPORTED"
  | "SKIPPED"
  | "ERROR";

export interface AuditReason {
  code: string;
  severity: "critical" | "warn" | "info" | "warning";
  title?: string;
  summary?: string;
  message?: string;
  remediation?: string;
}

export interface AuditProbe {
  name: string;
  status: ProbeStatus;
  latencyMs?: number;
  message?: string;
  summary?: string;
}

export interface ProxyAuditDetail {
  proxyKey: string;
  verdict: AuditVerdict;
  scores?: {
    overallSafety?: number;
    transportSecurity?: number;
    privacy?: number;
    reputation?: number;
    reliability?: number;
  };
  exit?: {
    ip?: string;
    isp?: string;
    asn?: string;
    country?: string;
    city?: string;
  };
  checkedAt?: number;
  reasons?: AuditReason[];
  probes?: AuditProbe[];
}

export interface ProxyAuditResult {
  proxy?: { protocol: string; host: string; port: number; username?: string };
  verdict: AuditVerdict;
  overallScore?: number;
  scores?: {
    overallSafety?: number;
    transportSecurity?: number;
    privacy?: number;
    reputation?: number;
    reliability?: number;
  };
  security?: {
    inputValidation?: { valid: boolean };
    ssrfProtection?: { passed: boolean; resolvedIps?: string[] };
  };
  connectivity?: { reachable: boolean; latencyMs?: number };
  exitIp?: { ip: string; isp?: string };
  riskFactors?: Array<{
    code: string;
    severity: string;
    title?: string;
    description?: string;
    id?: string;
    message?: string;
  }>;
  recommendations?: string[];
  metadata?: Record<string, unknown>;
}

export type ProxyInput =
  | string
  | { protocol: string; host: string; port: number; username?: string; password?: string };
import type {
  ProxyLifecycleState,
  ProxyInventoryItem,
  ProxyInventoryDetail,
  ProxyInventoryFilter,
  ProxyInventoryPage,
  ProxyImportInput,
  ProxyImportSummary,
  ProxyImportPreview,
  PersistAuditSnapshotInput,
  UnifiedProxyItem,
  UnifiedProxyCounts,
  UnifiedProxyFilter,
  UnifiedProxyResponse,
} from "../server/proxy-intelligence-repository.js";

export type {
  ProxyLifecycleState,
  ProxyInventoryItem,
  ProxyInventoryDetail,
  ProxyInventoryFilter,
  ProxyInventoryPage,
  ProxyImportInput,
  ProxyImportSummary,
  ProxyImportPreview,
  PersistAuditSnapshotInput,
  UnifiedProxyItem,
  UnifiedProxyCounts,
  UnifiedProxyFilter,
  UnifiedProxyResponse,
};

export interface UnifiedProxyHistoryEntry {
  id: string;
  status: "passed" | "failed";
  exitIp: string | null;
  isp: string | null;
  udp: "Yes" | "No" | "Unknown";
  latencyMs: number | null;
  timestamp: number;
  errorMessage: string | null;
}

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
  remoteTestStatus?: string | null;
  remoteLastError?: string | null;
  remoteLastTestedAt?: number | null;
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
  autoSync?: boolean;
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
  nineRouterUrls?: string[];
  controlPasswordSet: boolean;
  nineRouterPasswordSet: boolean;
  nineRouterApiKeySet: boolean;
  nineRouterAutoSync: boolean;
  activePoolLimit: number;
  nineRouterSyncMinutes: number;
  checkConcurrency: number;
  checkTimeoutMs: number;
  proxyTtlMinutes: number;
  antigravityRotatorEnabled: boolean;
  antigravityActiveLimit: number;
  antigravityRotateMinutes: number;
  antigravitySessionThreshold: number;
  fleetWireguard?: FleetWireGuardSettings | null;
}

export interface SettingsMeta {
  restartRequired: string[];
  source: "settings" | "env";
}

export interface SettingsResponse {
  settings: AppSettingsPublic;
  meta: SettingsMeta;
}

export interface NineRouterTestResult {
  ok: boolean;
  poolCount?: number;
  error?: string;
  partial?: boolean;
  endpoints?: Array<{ url: string; ok: boolean; poolCount?: number; error?: string }>;
}

export interface SettingsUpdatePayload {
  controlPassword?: string;
  currentPassword?: string;
  nineRouterUrl?: string;
  nineRouterPassword?: string;
  nineRouterApiKey?: string;
  nineRouterAutoSync?: boolean;
  activePoolLimit?: number;
  nineRouterSyncMinutes?: number;
  checkConcurrency?: number;
  checkTimeoutMs?: number;
  proxyTtlMinutes?: number;
  antigravityRotatorEnabled?: boolean;
  antigravityActiveLimit?: number;
  antigravityRotateMinutes?: number;
  antigravitySessionThreshold?: number;
  fleetWireguard?: FleetWireGuardSettings | null;
}

export interface AntigravityAccountState {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  sessionPercentage: number;
  weeklyPercentage: number;
  resetAt: string | null;
  proxyPoolId: string | null;
  proxyName?: string | null;
  proxyHealthy: boolean;
  lastError?: string | null;
  lastCheckedAt: number;
  turnCount?: number;
  lastActivatedAt?: number | null;
  routerUrl?: string;
}

export interface AntigravityRotatorEndpointSummary {
  url: string;
  ok: boolean;
  totalAccounts?: number;
  activeCount?: number;
  error?: string;
}

export interface AntigravityRotatorSnapshot {
  lastRunAt: number | null;
  running: boolean;
  totalAccounts: number;
  activeCount: number;
  totalSessionQuotaPercentage: number;
  maxPossiblePercentage: number;
  accounts: AntigravityAccountState[];
  endpoints?: AntigravityRotatorEndpointSummary[];
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
  passedCount?: number;
  failedCount?: number;
  startedAt: number | null;
  finishedAt: number | null;
  results: DetailedDiagnosticResult[];
  error: string;
  running?: boolean;
}

export type AuditorJobStatus = "queued" | "running" | "cancelling" | "cancelled" | "done" | "error";
export type AuditorJobMode = "single" | "bulk";

export interface AuditorJobOptions {
  attempts: number;
  timeoutMs: number;
  concurrency: number;
  reputation: boolean;
  browser: boolean;
}

export interface AuditorJobResult {
  index: number;
  result?: ProxyAuditResult;
  error?: string;
  /** True when the source line failed to parse — never attempted, not a real FAIL. */
  malformed?: boolean;
}

export interface AuditorJob {
  id: string;
  mode: AuditorJobMode;
  status: AuditorJobStatus;
  sourceName: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Lines that failed to parse — isolated from failCount so FAIL stays honest. */
  invalidCount: number;
  duplicateCount: number;
  total: number;
  checked: number;
  passCount: number;
  warnCount: number;
  failCount: number;
  unknownCount: number;
  browserAudit: boolean;
  attempts: number;
  timeoutMs: number;
  concurrency: number;
  results: AuditorJobResult[];
  resultsCapped: boolean;
  persistenceWarning: string;
  error: string;
}

export type DualRouterValue =
  | null
  | boolean
  | number
  | string
  | DualRouterValue[]
  | { [key: string]: DualRouterValue };
export type DualRouterResource = "pool" | "account" | "settings" | "role" | "history";
export type DualRouterOutcome = "applied" | "rejected" | "conflicted" | "unsupported" | "unknown";
export type DualRouterRunStatus =
  | "verified"
  | "partial"
  | "conflicted"
  | "blocked"
  | "busy"
  | "idle"
  | "unconfigured";

export interface DualRouterConflict {
  id: string;
  resource: DualRouterResource;
  key: string;
  field: string | null;
  revision: number;
  reason: "divergent" | "delete-edit" | "identity" | "ownership" | "credential";
  base: DualRouterValue;
  a: DualRouterValue;
  b: DualRouterValue;
}

export interface DualRouterCapability {
  resource: DualRouterResource | "usage";
  read: boolean;
  export: boolean;
  write: boolean;
  conditional: boolean;
  evidence: string;
}

export interface DualRouterRunReport {
  id: string;
  status: "verified" | "partial" | "conflicted" | "blocked" | "busy";
  operations: Array<{ id: string; outcome: DualRouterOutcome }>;
  conflicts: DualRouterConflict[];
  unmetCapabilities: string[];
  verifiedAt: number | null;
}

export interface DualRouterSyncPolicy {
  enabled: boolean;
  usageWriteBackAuthorized: boolean;
  nextIncrementalAt: number;
  nextFullAt: number;
}

export interface DualRouterInfo {
  id: string;
  url: string;
  reachable?: boolean;
  latencyMs?: number | null;
  activePools?: number | null;
  totalPools?: number | null;
  activeAccounts?: number | null;
  error?: string | null;
}

export interface DualRouterStatusResponse {
  ok: boolean;
  status: DualRouterRunStatus;
  capabilities: Record<string, DualRouterCapability[]> | DualRouterCapability[];
  lastVerifiedRun: DualRouterRunReport | null;
  policy: DualRouterSyncPolicy;
  activeConflictsCount: number;
  routers?: DualRouterInfo[];
}

export interface DualRouterConflictResponse {
  ok: boolean;
  conflicts: DualRouterConflict[];
  total: number;
}

export interface DualRouterAuditResponse {
  ok: boolean;
  report: DualRouterRunReport;
}

export interface DualRouterReconcileResponse {
  ok: boolean;
  report: DualRouterRunReport;
}

export interface DualRouterResolveConflictResponse {
  ok: boolean;
  report: DualRouterRunReport;
}

export interface DualRouterUsageWriteBackResponse {
  ok: boolean;
  receipts: Array<{
    operationId: string;
    outcome: DualRouterOutcome;
    boundary: string | null;
    evidence: string | null;
  }>;
  errors?: string[];
}

export interface ModelUsageStats {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
  provider?: string;
}

export interface NodeUsageSummary {
  id: string;
  name: string;
  url: string;
  online: boolean;
  error?: string;
  totalTokens: number;
  requests: number;
}

export interface AggregatedTokenUsage {
  period: string;
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCachedTokens: number;
  totalTokens: number;
  totalCost: number;
  byModel: Record<string, ModelUsageStats>;
  nodes: NodeUsageSummary[];
}
