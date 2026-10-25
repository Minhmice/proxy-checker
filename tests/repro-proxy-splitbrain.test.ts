import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAntigravityRotator } from "../src/server/antigravity-rotator.js";
import type { AntigravityRotationHistory } from "../src/server/antigravity-rotation-history.js";

function createMockHistory(): AntigravityRotationHistory {
  return {
    get: () => ({ accountId: "mock", turnCount: 0, lastActivatedAt: null }),
    recordActivation: (accountId: string) => ({
      accountId,
      turnCount: 1,
      lastActivatedAt: Date.now(),
    }),
    close: () => {},
  };
}

test("reproduction: multi-target proxy collision violates mutual exclusion constraint", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-splitbrain-collision-"));
  const url1 = "http://192.168.1.54:20128";
  const url2 = "https://9router.minhmice.com";

  // Single usable proxy in the entire pool
  const usableProxies = [{ remoteId: "pool-p1", name: "Shared Proxy Pool 1" }];

  // State on router 1 and router 2
  const connectionsByUrl: Record<
    string,
    Array<{
      id: string;
      email: string;
      isActive: boolean;
      providerSpecificData?: { proxyPoolId?: string };
    }>
  > = {
    [url1]: [
      {
        id: "url1-acc1",
        email: "user1@router1.com",
        isActive: false,
        providerSpecificData: {}, // Needs proxy assignment
      },
    ],
    [url2]: [
      {
        id: "url2-acc1",
        email: "user2@router2.com",
        isActive: false,
        providerSpecificData: {}, // Needs proxy assignment
      },
    ],
  };

  const rotator = createAntigravityRotator({
    dataDir: tmpDir,
    history: createMockHistory(),
    getRouterUrls: () => [url1, url2],
    getUsableProxies: () => usableProxies,
    getSettings: () => ({
      controlPassword: "pass",
      nineRouterUrl: `${url1}, ${url2}`,
      nineRouterPassword: "pass",
      nineRouterApiKey: "",
      nineRouterAutoSync: true,
      activePoolLimit: 20,
      nineRouterSyncMinutes: 60,
      checkConcurrency: 10,
      checkTimeoutMs: 5000,
      proxyTtlMinutes: 15,
      antigravityRotatorEnabled: true,
      antigravityActiveLimit: 3,
      antigravityRotateMinutes: 10,
      antigravitySessionThreshold: 20,
      fleetWireguard: null,
    }),
    listConnections: async (overrides) => {
      const url = overrides?.url || "";
      return (connectionsByUrl[url] || []).map((c) => ({
        ...c,
        name: c.email,
        provider: "antigravity",
      }));
    },
    getUsage: async () => ({
      quotas: {
        gemini_session: { remainingPercentage: 90, resetAt: "2026-10-23T05:00:00Z" },
      },
    }),
    updateConnection: async (id, patch, overrides) => {
      const url = overrides?.url || "";
      const list = connectionsByUrl[url] || [];
      const conn = list.find((c) => c.id === id);
      if (conn) {
        if (patch.isActive !== undefined) conn.isActive = patch.isActive;
        if (patch.providerSpecificData) {
          conn.providerSpecificData = {
            ...conn.providerSpecificData,
            ...patch.providerSpecificData,
          };
        }
      }
      return { connection: { id, ...patch } };
    },
  });

  try {
    const snapshot = await rotator.runRotation({ force: true });

    const activeAccounts = snapshot.accounts.filter((a) => a.isActive);
    const activeWithPoolP1 = activeAccounts.filter((a) => a.proxyPoolId === "pool-p1");

    console.log(
      `[Collision Observation] Total active: ${activeAccounts.length}, Active with pool-p1: ${activeWithPoolP1.length} (` +
        activeWithPoolP1.map((a) => `${a.id}@${a.routerUrl}`).join(", ") +
        ")",
    );

    // INVARIANT: "2 accounts sharing same proxy must NEVER be active simultaneously"
    // Since only 1 proxy 'pool-p1' exists, at most 1 account can be active across the entire system.
    assert.equal(
      activeWithPoolP1.length,
      1,
      `STRICT CONSTRAINT VIOLATED: ${activeWithPoolP1.length} accounts are simultaneously active sharing proxy 'pool-p1' across routers!`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("reproduction: multi-target rotation breaches antigravityActiveLimit ceiling", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-splitbrain-limit-"));
  const url1 = "http://192.168.1.54:20128";
  const url2 = "https://9router.minhmice.com";

  // Provide ample distinct proxies so proxy limits don't constrain activation
  const usableProxies = Array.from({ length: 10 }, (_, i) => ({
    remoteId: `pool-p${i + 1}`,
    name: `Proxy ${i + 1}`,
  }));

  // URL 1 has 5 standby accounts, URL 2 has 5 standby accounts
  const connectionsByUrl: Record<
    string,
    Array<{
      id: string;
      email: string;
      isActive: boolean;
      providerSpecificData?: { proxyPoolId?: string };
    }>
  > = {
    [url1]: Array.from({ length: 5 }, (_, i) => ({
      id: `url1-acc${i + 1}`,
      email: `u1-${i + 1}@router1.com`,
      isActive: false,
      providerSpecificData: { proxyPoolId: `pool-p${i + 1}` },
    })),
    [url2]: Array.from({ length: 5 }, (_, i) => ({
      id: `url2-acc${i + 1}`,
      email: `u2-${i + 1}@router2.com`,
      isActive: false,
      providerSpecificData: { proxyPoolId: `pool-p${i + 6}` },
    })),
  };

  const configuredActiveLimit = 3;

  const rotator = createAntigravityRotator({
    dataDir: tmpDir,
    history: createMockHistory(),
    getRouterUrls: () => [url1, url2],
    getUsableProxies: () => usableProxies,
    getSettings: () => ({
      controlPassword: "pass",
      nineRouterUrl: `${url1}, ${url2}`,
      nineRouterPassword: "pass",
      nineRouterApiKey: "",
      nineRouterAutoSync: true,
      activePoolLimit: 20,
      nineRouterSyncMinutes: 60,
      checkConcurrency: 10,
      checkTimeoutMs: 5000,
      proxyTtlMinutes: 15,
      antigravityRotatorEnabled: true,
      antigravityActiveLimit: configuredActiveLimit,
      antigravityRotateMinutes: 10,
      antigravitySessionThreshold: 20,
      fleetWireguard: null,
    }),
    listConnections: async (overrides) => {
      const url = overrides?.url || "";
      return (connectionsByUrl[url] || []).map((c) => ({
        ...c,
        name: c.email,
        provider: "antigravity",
      }));
    },
    getUsage: async () => ({
      quotas: {
        gemini_session: { remainingPercentage: 90, resetAt: "2026-10-23T05:00:00Z" },
      },
    }),
    updateConnection: async (id, patch, overrides) => {
      const url = overrides?.url || "";
      const list = connectionsByUrl[url] || [];
      const conn = list.find((c) => c.id === id);
      if (conn) {
        if (patch.isActive !== undefined) conn.isActive = patch.isActive;
        if (patch.providerSpecificData) {
          conn.providerSpecificData = {
            ...conn.providerSpecificData,
            ...patch.providerSpecificData,
          };
        }
      }
      return { connection: { id, ...patch } };
    },
  });

  try {
    const snapshot = await rotator.runRotation({ force: true });

    const activeAccounts = snapshot.accounts.filter((a) => a.isActive);

    console.log(
      `[Limit Breach Observation] Configured limit: ${configuredActiveLimit}, Snapshot activeCount: ${snapshot.activeCount}, Actual active in accounts: ${activeAccounts.length}`,
    );

    // INVARIANT: Total active accounts across the entire system must not exceed antigravityActiveLimit (3)
    assert.ok(
      activeAccounts.length <= configuredActiveLimit,
      `ACTIVE LIMIT BREACHED: Expected at most ${configuredActiveLimit} active accounts across all routers, but found ${activeAccounts.length} (snapshot.activeCount=${snapshot.activeCount})!`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
