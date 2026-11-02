import test from "node:test";
import assert from "node:assert/strict";
import {
  isAccountForbidden,
  computeRotationPlan,
  createAntigravityRotator,
} from "../src/server/antigravity-rotator.js";
import type { NineRouterConnectionItem } from "../src/server/nine-router-client.js";
import type { getSettingsSecrets } from "../src/server/app-config.js";

type SettingsSecrets = ReturnType<typeof getSettingsSecrets>;

// ---------------------------------------------------------------------------
// Probe 1: isAccountForbidden edge cases and false positives/negatives
// ---------------------------------------------------------------------------
test("probe 1a: isAccountForbidden handles null, undefined, or non-string lastError safely without crashing", () => {
  // Should not throw TypeError
  assert.equal(isAccountForbidden(null as unknown as { lastError?: string | null }), false);
  assert.equal(isAccountForbidden(undefined as unknown as { lastError?: string | null }), false);
  assert.equal(isAccountForbidden({ lastError: undefined }), false);
  assert.equal(isAccountForbidden({ lastError: null }), false);
  assert.equal(
    isAccountForbidden({
      lastError: { code: 403, message: "Forbidden" } as unknown as string,
    }),
    true,
  );
  assert.equal(
    isAccountForbidden({
      lastError: new Error("HTTP 403 Forbidden") as unknown as string,
    }),
    true,
  );
  assert.equal(isAccountForbidden({ lastError: 12345 as unknown as string }), false);
});

test("probe 1b: isAccountForbidden should NOT false positive on IP addresses or ports containing 403", () => {
  // IP address with 403 octet or port 4030 must not be flagged as account forbidden
  const ipError = "connect ECONNREFUSED 10.0.403.1:8080";
  assert.equal(isAccountForbidden({ lastError: ipError }), false);

  const portError = "connect ETIMEDOUT 192.168.1.50:4030";
  assert.equal(isAccountForbidden({ lastError: portError }), false);
});

test("probe 1c: isAccountForbidden should NOT false positive on quota disclaimer warnings", () => {
  // Quota scraper denial is not account ban / proxy forbidden
  const quotaWarning = "Antigravity quota API access forbidden. Chat may still work.";
  assert.equal(isAccountForbidden({ lastError: quotaWarning }), false);
});

test("probe 1d: isAccountForbidden should detect Google Cloud Code project/billing/scope blocks", () => {
  assert.equal(isAccountForbidden({ lastError: "Google API Error: USER_PROJECT_DENIED" }), true);
  assert.equal(
    isAccountForbidden({ lastError: "BILLING_DISABLED: Cloud Code service blocked" }),
    true,
  );
  assert.equal(isAccountForbidden({ lastError: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }), true);
});

// ---------------------------------------------------------------------------
// Probe 2: Proxy capacity enforcement when candidate alternatives are full
// ---------------------------------------------------------------------------
test("probe 2: computeRotationPlan never exceeds 2-account capacity even if other candidate is at capacity", () => {
  // Two usable proxies: P1 has 2 accounts, P2 has 1 account.
  // Account A4 is on P2 and encounters 403 error.
  // Reassigning A4 must NOT put A4 on P1 (which would make P1 have 3 accounts).
  const accounts = [
    {
      id: "A1",
      isActive: false,
      proxyPoolId: "P1",
      sessionPercentage: 50,
      weeklyPercentage: 50,
      resetAt: null,
    },
    {
      id: "A2",
      isActive: false,
      proxyPoolId: "P1",
      sessionPercentage: 50,
      weeklyPercentage: 50,
      resetAt: null,
    },
    {
      id: "A3",
      isActive: false,
      proxyPoolId: "P2",
      sessionPercentage: 50,
      weeklyPercentage: 50,
      resetAt: null,
    },
    {
      id: "A4",
      isActive: false,
      proxyPoolId: "P2",
      sessionPercentage: 0,
      weeklyPercentage: 0,
      resetAt: null,
      lastError: "403 Forbidden",
    },
  ];
  const usable = [{ remoteId: "P1" }, { remoteId: "P2" }];

  const plan = computeRotationPlan(accounts, usable, { reassignForbidden: true });
  // If P1 is chosen, P1 will have A1, A2, A4 (3 accounts > 2 capacity!).
  // If no proxy has capacity < 2, it should not assign to P1.
  const p1Count = accounts.filter(
    (a) => (plan.proxyReassignments[a.id] ?? a.proxyPoolId) === "P1",
  ).length;
  assert.ok(p1Count <= 2, `Proxy P1 was allocated ${p1Count} accounts (max allowed is 2)`);
});

// ---------------------------------------------------------------------------
// Probe 3: resetProxies concurrency guard and global multi-endpoint planning
// ---------------------------------------------------------------------------
test("probe 3a: resetProxies coalesces concurrent calls using an in-flight guard", async () => {
  let listCalls = 0;
  const gate = Promise.withResolvers<void>();
  const rotator = createAntigravityRotator({
    getRouterUrls: () => ["http://mock-node:9999"],
    getUsableProxies: () => [{ remoteId: "P1" }, { remoteId: "P2" }],
    listConnections: async () => {
      listCalls++;
      await gate.promise;
      return [
        {
          id: "c1",
          provider: "antigravity",
          isActive: false,
          providerSpecificData: { proxyPoolId: "P1" },
        },
      ];
    },
    updateConnection: async () => ({ connection: {} }),
    getUsage: async () => ({ sessionPercentage: 80, quotaAvailable: true }),
    getSettings: () =>
      ({
        antigravityRotatorEnabled: true,
        antigravityActiveLimit: 3,
        antigravitySessionThreshold: 20,
      }) as unknown as SettingsSecrets,
  });

  // Call resetProxies twice concurrently
  const p1 = rotator.resetProxies();
  const p2 = rotator.resetProxies();

  // Release the barrier
  gate.resolve();

  const [res1, res2] = await Promise.all([p1, p2]);

  assert.equal(res1.ok, true);
  assert.equal(res2.ok, true);
  // With an in-flight guard, duplicate concurrent calls share the active work or wait instead of executing duplicate parallel fetch passes
  assert.equal(listCalls, 2); // 1 for fetchEndpointAccounts, 1 for runRotation
});

test("probe 3b: resetProxies plans globally across multiple endpoints to prevent cross-node proxy collision", async () => {
  const nodeConnections: Record<string, NineRouterConnectionItem[]> = {
    "http://node1:9999": [
      {
        id: "n1-a1",
        provider: "antigravity",
        isActive: false,
        providerSpecificData: { proxyPoolId: "P1" },
      },
      {
        id: "n1-a2",
        provider: "antigravity",
        isActive: false,
        providerSpecificData: { proxyPoolId: "P2" },
      },
    ],
    "http://node2:9999": [
      {
        id: "n2-a1",
        provider: "antigravity",
        isActive: false,
        providerSpecificData: { proxyPoolId: "P1" },
      },
      {
        id: "n2-a2",
        provider: "antigravity",
        isActive: false,
        providerSpecificData: { proxyPoolId: "P2" },
      },
    ],
  };

  const updatedByNode: Record<string, Record<string, string>> = {
    "http://node1:9999": {},
    "http://node2:9999": {},
  };

  const rotator = createAntigravityRotator({
    getRouterUrls: () => ["http://node1:9999", "http://node2:9999"],
    getUsableProxies: () => [{ remoteId: "P1" }, { remoteId: "P2" }],
    listConnections: async (overrides) => {
      const url = overrides?.url || "http://node1:9999";
      return nodeConnections[url] || [];
    },
    updateConnection: async (id, patch, overrides) => {
      const url = overrides?.url || "http://node1:9999";
      const proxyId = patch.providerSpecificData?.proxyPoolId;
      if (typeof proxyId === "string") {
        updatedByNode[url][id] = proxyId;
      }
      return { connection: {} };
    },
    getUsage: async () => ({ sessionPercentage: 80, quotaAvailable: true }),
    getSettings: () =>
      ({
        antigravityRotatorEnabled: true,
        antigravityActiveLimit: 3,
        antigravitySessionThreshold: 20,
      }) as unknown as SettingsSecrets,
  });

  const res = await rotator.resetProxies({ forceAll: true });
  assert.equal(res.ok, true);

  // Across the entire fleet, count total assignments per proxy
  const globalCounts: Record<string, number> = { P1: 0, P2: 0 };
  for (const url of Object.keys(updatedByNode)) {
    for (const [_, proxyId] of Object.entries(updatedByNode[url])) {
      globalCounts[proxyId] = (globalCounts[proxyId] || 0) + 1;
    }
  }

  // Invariant 1: No proxy should have more than 2 accounts assigned across the whole fleet
  assert.ok(
    globalCounts.P1 <= 2,
    `P1 assigned to ${globalCounts.P1} accounts across fleet (max allowed is 2)`,
  );
  assert.ok(
    globalCounts.P2 <= 2,
    `P2 assigned to ${globalCounts.P2} accounts across fleet (max allowed is 2)`,
  );
});
