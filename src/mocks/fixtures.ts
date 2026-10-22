export const mockSessionAuthenticated = {
  authenticated: true,
};

export const mockSessionUnauthenticated = {
  authenticated: false,
};

export const mockLoginSuccess = {
  authenticated: true,
  expiresAt: Date.now() + 86400000,
};

export const mockHealth = {
  ok: true,
};

export const mockNineRouterStatus = {
  status: "connected",
  pools: {
    "pool-1": {
      id: "pool-1",
      name: "Fast-1",
      proxyUrl: "http://192.168.1.1:8080",
      tier: "active",
      isActiveOnRouter: true,
      latency_ms: 45,
    },
  },
  accounts: [],
  accountMetrics: {
    activeAccounts: 1,
    totalAccounts: 2,
    totalSessionQuotaRemaining: 180,
    maxPossibleQuota: 200,
    accountPoolUtilizationPercentage: 90,
  },
  activeLimit: 3,
};

export const mockSettings = {
  settings: {
    nineRouterUrl: "http://127.0.0.1:20128",
    controlPasswordSet: true,
    nineRouterPasswordSet: true,
    nineRouterApiKeySet: false,
    nineRouterAutoSync: true,
    activePoolLimit: 20,
    nineRouterSyncMinutes: 60,
    checkConcurrency: 10,
    checkTimeoutMs: 5000,
    proxyTtlMinutes: 15,
    antigravityRotatorEnabled: true,
    antigravityActiveLimit: 3,
    antigravityRotateMinutes: 60,
    antigravitySessionThreshold: 20,
    fleetWireguard: null,
  },
  meta: {
    restartRequired: [],
    source: "settings" as const,
  },
};

export const mockProxiesList = {
  items: [
    {
      proxyKey: "http://127.0.0.1:8080",
      endpoint: "127.0.0.1:8080",
      protocol: "http",
      host: "127.0.0.1",
      port: 8080,
      status: "usable",
      hasAuth: false,
      source: "mock",
      lifecycleState: "working",
      latencyMs: 35,
      exitIp: "127.0.0.1",
      successes: 10,
      failures: 0,
      lastError: null,
      checkedAt: Date.now(),
      createdAt: Date.now() - 3600000,
      updatedAt: Date.now(),
      latestVerdict: "PASS",
      latestScore: 95,
      latestAuditAt: Date.now(),
      isPinned: false,
      tags: ["fast"],
      routerState: "active",
      removedAt: null,
      lastLatencyMs: 35,
    },
  ],
  page: 1,
  pageSize: 20,
  total: 1,
};
