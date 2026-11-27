export const ROTATION_POLICY = {
  thresholdMin: 5,
  thresholdMax: 10,
  standbyQuotaExclusive: 20,
} as const;

export type RotationProvider = "antigravity" | "codex" | "claude";

export const PROVIDER_LABEL: Record<RotationProvider, string> = {
  antigravity: "Antigravity",
  codex: "Codex",
  claude: "Claude Code",
};

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

export interface AppSettingsPublic {
  nineRouterUrl: string;
  nineRouterUrls?: string[];
  controlPasswordSet: boolean;
  nineRouterPasswordSet: boolean;
  nineRouterApiKeySet: boolean;
  antigravityRotatorEnabled: boolean;
  antigravityRotateMinutes: number;
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
  antigravityRotatorEnabled?: boolean;
  antigravityRotateMinutes?: number;
}

export interface AntigravityAccountState {
  id: string;
  provider?: RotationProvider;
  email: string;
  name: string;
  isActive: boolean;
  sessionPercentage: number;
  weeklyPercentage: number;
  resetAt: string | null;
  thresholdPercentage: number | null;
  quotaAvailable: boolean;
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
  lastRotationAt?: number | null;
  running: boolean;
  totalAccounts: number;
  activeCount: number;
  totalSessionQuotaPercentage: number;
  maxPossiblePercentage: number;
  accounts: AntigravityAccountState[];
  groups?: Array<{ provider: RotationProvider; activeCount: number; totalAccounts: number }>;
  endpoints?: AntigravityRotatorEndpointSummary[];
  degraded?: boolean;
  error?: string | null;
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

export interface RecentRequest {
  nodeId: string;
  timestamp: string;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  status: string;
}

export interface RecentRequestsResponse {
  requests: RecentRequest[];
}

export type SpotifyStatus = "unconfigured" | "disconnected" | "idle" | "ready" | "error";
export type SpotifyAction = "play" | "pause" | "next" | "previous";

export interface SpotifyNow {
  status: SpotifyStatus;
  playing: boolean;
  trackId: string | null;
  title: string;
  artist: string;
  album: string;
  art: string | null;
  /** Link back to the track on Spotify, as the platform terms require. */
  url: string | null;
  progressMs: number;
  durationMs: number;
  device: string | null;
  canControl: boolean;
  error?: string;
}
