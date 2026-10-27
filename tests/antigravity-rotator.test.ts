import test from "node:test";
import assert from "node:assert/strict";
import {
  computeRotationPlan,
  extractAntigravityUsage,
  isAccountForbidden,
} from "../src/server/antigravity-rotator.js";
test("extractAntigravityUsage correctly parses gemini_session and weekly", () => {
  const sampleUsage = {
    quotas: {
      gemini_session: {
        remainingPercentage: 89.775,
        resetAt: "2026-10-04T11:12:44.000Z",
        used: 102,
        total: 1000,
      },
      gemini_weekly: {
        remainingPercentage: 74.345,
        resetAt: "2026-10-10T08:39:55.000Z",
        used: 257,
        total: 1000,
      },
    },
  };

  const parsed = extractAntigravityUsage(sampleUsage);
  assert.equal(Math.round(parsed.sessionPercentage), 90);
  assert.equal(Math.round(parsed.weeklyPercentage), 74);
  assert.equal(parsed.resetAt, "2026-10-04T11:12:44.000Z");
});
test("quota-only 403 preserves active chat and its existing proxy", () => {
  const parsed = extractAntigravityUsage({ message: "[403]: Forbidden", quotas: {} });
  assert.equal(parsed.quotaAvailable, false);
  const plan = computeRotationPlan(
    [
      {
        id: "running",
        isActive: true,
        ...parsed,
        proxyPoolId: "px1",
      },
    ],
    [{ remoteId: "px1" }, { remoteId: "px2" }],
  );
  assert.deepEqual(plan.deactivations, []);
  assert.deepEqual(plan.proxyReassignments, {});
  assert.deepEqual(plan.activeIds, ["running"]);
});

test("quota-only 403 cannot activate a reserve or blacklist a shared proxy", () => {
  const parsed = extractAntigravityUsage({ error: "HTTP 403: Service disabled", quotas: {} });
  const plan = computeRotationPlan(
    [
      { id: "reserve", isActive: false, ...parsed, proxyPoolId: "px1" },
      {
        id: "running",
        isActive: true,
        sessionPercentage: 80,
        weeklyPercentage: 20,
        resetAt: null,
        proxyPoolId: "px1",
      },
    ],
    [{ remoteId: "px1" }, { remoteId: "px2" }],
    { activeLimit: 2 },
  );
  assert.deepEqual(plan.proxyReassignments, {});
  assert.deepEqual(plan.activations, []);
  assert.deepEqual(plan.activeIds, ["running"]);
});

test("computeRotationPlan demotes <= 20% and promotes candidates with lowest resetAt avoiding proxy collision", () => {
  const accounts = [
    {
      id: "acc1",
      email: "a@x.com",
      isActive: true,
      sessionPercentage: 15,
      weeklyPercentage: 50,
      resetAt: "2026-10-04T12:00:00Z",
      proxyPoolId: "px1",
    },
    {
      id: "acc2",
      email: "b@x.com",
      isActive: true,
      sessionPercentage: 80,
      weeklyPercentage: 90,
      resetAt: "2026-10-04T14:00:00Z",
      proxyPoolId: "px2",
    },
    {
      id: "acc3",
      email: "c@x.com",
      isActive: false,
      sessionPercentage: 90,
      weeklyPercentage: 90,
      resetAt: "2026-10-04T11:00:00Z",
      proxyPoolId: "px2", // shares px2 with acc2 which is active!
    },
    {
      id: "acc4",
      email: "d@x.com",
      isActive: false,
      sessionPercentage: 85,
      weeklyPercentage: 85,
      resetAt: "2026-10-04T11:30:00Z",
      proxyPoolId: "px3",
    },
  ];
  const usableProxies = [
    { remoteId: "px1", name: "Proxy 1" },
    { remoteId: "px2", name: "Proxy 2" },
    { remoteId: "px3", name: "Proxy 3" },
  ];

  const plan = computeRotationPlan(accounts, usableProxies, {
    activeLimit: 2,
    sessionThreshold: 20,
  });

  // acc1 must be deactivated because 15% <= 20%
  assert.equal(plan.deactivations.includes("acc1"), true);

  // acc2 is kept active (80% > 20%)
  assert.equal(plan.activeIds.includes("acc2"), true);

  // acc3 has earliest resetAt (11:00), BUT shares px2 with active acc2.
  // Collision rule: cannot run concurrently on same proxy!
  assert.equal(plan.activations.includes("acc3"), false);

  // acc4 (resetAt 11:30, proxy px3) is selected to fill the 2nd slot.
  assert.equal(plan.activations.includes("acc4"), true);
  assert.equal(plan.activeIds.includes("acc4"), true);
  assert.equal(plan.activeIds.length, 2);
});

test("computeRotationPlan replaces dead proxy with usable proxy without exceeding 2 accounts per proxy", () => {
  const accounts = [
    {
      id: "acc1",
      email: "a@x.com",
      isActive: true,
      sessionPercentage: 80,
      weeklyPercentage: 80,
      resetAt: "2026-10-04T12:00:00Z",
      proxyPoolId: "px-dead", // dead proxy!
    },
    {
      id: "acc2",
      email: "b@x.com",
      isActive: false,
      sessionPercentage: 70,
      weeklyPercentage: 70,
      resetAt: "2026-10-04T13:00:00Z",
      proxyPoolId: "px1",
    },
    {
      id: "acc3",
      email: "c@x.com",
      isActive: false,
      sessionPercentage: 70,
      weeklyPercentage: 70,
      resetAt: "2026-10-04T13:00:00Z",
      proxyPoolId: "px1", // px1 already has 2 accounts (acc2, acc3)
    },
  ];
  const usableProxies = [
    { remoteId: "px1", name: "Proxy 1" },
    { remoteId: "px2", name: "Proxy 2" },
  ];

  const plan = computeRotationPlan(accounts, usableProxies, {
    activeLimit: 2,
    sessionThreshold: 20,
  });

  // acc1 had dead proxy. px1 is full (2 accounts). It must be assigned px2!
  assert.equal(plan.proxyReassignments["acc1"], "px2");
});

test("computeRotationPlan deduplicates surviving active accounts that share the same proxy", () => {
  const accounts = [
    {
      id: "acc1",
      email: "a@x.com",
      isActive: true,
      sessionPercentage: 80,
      weeklyPercentage: 80,
      resetAt: null,
      proxyPoolId: "px1",
    },
    {
      id: "acc2",
      email: "b@x.com",
      isActive: true,
      sessionPercentage: 70,
      weeklyPercentage: 70,
      resetAt: null,
      proxyPoolId: "px1",
    },
  ];
  const usableProxies = [{ remoteId: "px1", name: "Proxy 1" }];

  const plan = computeRotationPlan(accounts, usableProxies, {
    activeLimit: 2,
    sessionThreshold: 20,
  });

  assert.equal(plan.deactivations.includes("acc2"), true);
  assert.equal(plan.activeIds.includes("acc1"), true);
  assert.equal(plan.activeIds.includes("acc2"), false);
  assert.equal(plan.activeIds.length, 1);
});

test("isAccountForbidden detects 403, forbidden, self_signed_cert, and model locks", () => {
  assert.equal(isAccountForbidden({ lastError: "[403]: Forbidden" }), true);
  assert.equal(
    isAccountForbidden({ lastError: "URL: https://cloudcode-pa.googleapis.com [403]: Forbidden" }),
    true,
  );
  assert.equal(
    isAccountForbidden({ lastError: "TLS cert verification failed (SELF_SIGNED_CERT_IN_CHAIN)" }),
    true,
  );
  assert.equal(isAccountForbidden({ lastError: "Permission_denied by Google Cloud Code" }), true);
  assert.equal(
    isAccountForbidden({ lastError: "Account locked modelLock_gemini-3.8-flash-high for 120s" }),
    true,
  );
  assert.equal(
    isAccountForbidden({ lastError: "Account suspended: ToS violation (account_suspended)" }),
    true,
  );
  assert.equal(isAccountForbidden({ lastError: "User account_disabled by administrator" }), true);
  assert.equal(isAccountForbidden({ lastError: "API Error: 403 Forbidden" }), true);
  assert.equal(isAccountForbidden({ lastError: "Cloud Code Assist API error (403)" }), true);
  // Regression: Port numbers containing 403 should NOT trigger false positive
  assert.equal(isAccountForbidden({ lastError: "connect ETIMEDOUT 10.0.0.1:4030" }), false);
  assert.equal(
    isAccountForbidden({ lastError: "upstream proxy host 1.1.1.1:8403 refused" }),
    false,
  );
  assert.equal(isAccountForbidden({ lastError: "ECONNRESET connection reset" }), false);
  assert.equal(isAccountForbidden({ lastError: null }), false);
});

test("computeRotationPlan with reassignForbidden reassigns proxy for 403 forbidden account to clean pool", () => {
  const parsed = extractAntigravityUsage({ message: "[403]: Forbidden", quotas: {} });
  const plan = computeRotationPlan(
    [
      {
        id: "forbidden_acc",
        isActive: true,
        ...parsed,
        proxyPoolId: "px1",
      },
    ],
    [{ remoteId: "px1" }, { remoteId: "px2" }],
    { reassignForbidden: true },
  );
  assert.equal(plan.proxyReassignments["forbidden_acc"], "px2");
});
