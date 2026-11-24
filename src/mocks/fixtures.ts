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
  accounts: [],
  accountMetrics: {
    activeAccounts: 1,
    totalAccounts: 2,
    totalSessionQuotaRemaining: 180,
    maxPossibleQuota: 200,
  },
};

export const mockSettings = {
  settings: {
    nineRouterUrl: "http://127.0.0.1:20128",
    controlPasswordSet: true,
    nineRouterPasswordSet: true,
    nineRouterApiKeySet: false,
    antigravityRotatorEnabled: true,
    antigravityRotateMinutes: 60,
  },
  meta: {
    restartRequired: [],
    source: "settings" as const,
  },
};

export const mockAntigravityStatus = {
  lastRunAt: Date.now(),
  running: false,
  totalAccounts: 2,
  activeCount: 1,
  totalSessionQuotaPercentage: 85,
  maxPossiblePercentage: 200,
  accounts: [
    {
      id: "acc-1",
      email: "acc1@example.com",
      name: "Account 1",
      isActive: true,
      sessionPercentage: 85,
      weeklyPercentage: 90,
      resetAt: new Date(Date.now() + 3600000).toISOString(),
      thresholdPercentage: 15,
      quotaAvailable: true,
      lastCheckedAt: Date.now(),
    },
    {
      id: "acc-2",
      email: "acc2@example.com",
      name: "Account 2",
      isActive: false,
      sessionPercentage: 100,
      weeklyPercentage: 100,
      resetAt: null,
      thresholdPercentage: null,
      quotaAvailable: true,
      lastCheckedAt: Date.now(),
    },
  ],
  degraded: false,
};
