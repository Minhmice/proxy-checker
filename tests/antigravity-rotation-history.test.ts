import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AntigravityRotatorSnapshot } from "../src/lib/types.js";
import {
  computeRotationPlan,
  createAntigravityRotator,
  extractAntigravityUsage,
  type AntigravityAccountInput,
} from "../src/server/antigravity-rotator.js";
import { openAntigravityRotationHistory } from "../src/server/antigravity-rotation-history.js";
import { getSettingsSecrets } from "../src/server/app-config.js";
import type { NineRouterConnectionItem } from "../src/server/nine-router-client.js";

const account = (
  id: string,
  patch: Partial<AntigravityAccountInput> = {},
): AntigravityAccountInput => ({
  id,
  isActive: false,
  sessionPercentage: 100,
  weeklyPercentage: 80,
  resetAt: null,
  proxyPoolId: `px-${id}`,
  ...patch,
});
const proxies = ["a", "b", "c", "d"].map((id) => ({ remoteId: `px-${id}` }));

test("rotation ignores weekly quota and uses strict session threshold", () => {
  const plan = computeRotationPlan(
    [
      account("a", { isActive: true, weeklyPercentage: 0, sessionPercentage: 80 }),
      account("b", { weeklyPercentage: 0, sessionPercentage: 20.01 }),
      account("c", { isActive: true, sessionPercentage: 20 }),
      account("d", { sessionPercentage: 20 }),
    ],
    proxies,
    { activeLimit: 3 },
  );
  assert.deepEqual(plan.deactivations, ["c"]);
  assert.deepEqual(plan.activeIds, ["a", "b"]);
});

test("session quota is available without weekly but malformed session stays unknown", () => {
  const parsed = extractAntigravityUsage({
    quotas: { gemini_session: { remainingPercentage: 80 } },
  });
  assert.equal(parsed.quotaAvailable, true);
  assert.deepEqual(computeRotationPlan([account("a", parsed)], proxies).activations, ["a"]);
  for (const session of [{}, { remainingPercentage: NaN }, { total: Infinity, used: 0 }]) {
    const unknown = extractAntigravityUsage({ quotas: { gemini_session: session } });
    assert.equal(unknown.quotaAvailable, false);
    const plan = computeRotationPlan(
      [account("a", { isActive: true, ...unknown }), account("b", unknown)],
      proxies,
      { activeLimit: 2 },
    );
    assert.deepEqual(plan.activeIds, ["a"]);
    assert.deepEqual(plan.deactivations, []);
  }
});

function fixture(t: TestContext) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-turns-"));
  const history = openAntigravityRotationHistory(dataDir);
  t.after(() => {
    history.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const connections = ["a", "b", "c"].map((id) => ({
    id,
    provider: "antigravity",
    email: `${id}@example.test`,
    isActive: false,
    providerSpecificData: { proxyPoolId: `px-${id}` },
  })) as NineRouterConnectionItem[];
  const quota = new Map(connections.map((c) => [c.id, { session: 100, weekly: 80 }]));
  const failures = new Set<string>();
  const unavailable = new Set<string>();
  const deps = {
    dataDir,
    history,
    getSettings: () => ({
      ...getSettingsSecrets(),
      antigravityActiveLimit: 1,
      antigravitySessionThreshold: 20,
    }),
    getUsableProxies: () => proxies,
    listConnections: async () => structuredClone(connections),
    getUsage: async (id: string): Promise<Record<string, unknown>> => {
      if (unavailable.has(id)) throw new Error("quota transport unavailable");
      const q = quota.get(id)!;
      return {
        quotas: {
          gemini_session: { remainingPercentage: q.session },
          gemini_weekly: { remainingPercentage: q.weekly },
        },
      };
    },
    updateConnection: async (
      id: string,
      patch: { isActive?: boolean; providerSpecificData?: Record<string, unknown> },
    ) => {
      if (failures.has(id)) throw new Error("upstream rejected update");
      const conn = connections.find((c) => c.id === id)!;
      Object.assign(conn, patch);
      return { connection: structuredClone(conn) };
    },
  };
  return { deps, connections, quota, failures, unavailable };
}

function getActiveAccountIds(snapshot: AntigravityRotatorSnapshot): string[] {
  return snapshot.accounts.filter((a) => a.isActive).map((a) => a.id);
}

test("reserve priority follows reset time instead of activation history", () => {
  const plan = computeRotationPlan(
    [
      account("a", { resetAt: null, lastActivatedAt: null }),
      account("b", { resetAt: "2099-10-11T12:00:00Z", lastActivatedAt: 999, turnCount: 20 }),
      account("c", { resetAt: "2099-10-11T13:00:00Z", lastActivatedAt: 1, turnCount: 1 }),
      account("d", { resetAt: "not-a-date", lastActivatedAt: null }),
    ],
    proxies,
    { activeLimit: 3 },
  );
  assert.deepEqual(plan.activations, ["b", "c", "a"]);
});

test("failed OFF keeps its slot and cannot produce a false activation", async (t) => {
  const f = fixture(t);
  f.connections[0].isActive = true;
  f.quota.get("a")!.session = 20;
  f.failures.add("a");
  const snapshot = await createAntigravityRotator(f.deps).runRotation({ force: true });
  assert.deepEqual(getActiveAccountIds(snapshot), ["a"]);
  assert.equal(snapshot.activeCount, 1);
  assert.equal(f.connections[1].isActive, false);
});

test("failed ON does not count as a turn or appear active", async (t) => {
  const f = fixture(t);
  f.failures.add("a");
  const first = await createAntigravityRotator(f.deps).runRotation({ force: true });
  assert.equal(first.accounts.find((a) => a.id === "a")!.isActive, false);
  f.failures.clear();
  for (const c of f.connections) c.isActive = false;
  assert.deepEqual(
    getActiveAccountIds(await createAntigravityRotator(f.deps).runRotation({ force: true })),
    ["a"],
  );
});

test("temporary quota failure preserves running account and consumes its slot", async (t) => {
  const f = fixture(t);
  f.connections[0].isActive = true;
  f.unavailable.add("a");
  assert.deepEqual(
    getActiveAccountIds(await createAntigravityRotator(f.deps).runRotation({ force: true })),
    ["a"],
  );
});

test("overlapping cycle does not activate a second account", async (t) => {
  const f = fixture(t);
  const rotator = createAntigravityRotator(f.deps);
  await Promise.all([rotator.runRotation({ force: true }), rotator.runRotation({ force: true })]);
  assert.deepEqual(getActiveAccountIds(rotator.getSnapshot()), ["a"]);
});

test("failed proxy replacement keeps confirmed assignment and does not activate reserve", async (t) => {
  const f = fixture(t);
  f.connections[0].providerSpecificData!.proxyPoolId = "dead-proxy";
  f.failures.add("a");
  const snapshot = await createAntigravityRotator(f.deps).runRotation({ force: true });
  const state = snapshot.accounts.find((a) => a.id === "a")!;
  assert.equal(state.proxyPoolId, "dead-proxy");
  assert.equal(state.proxyHealthy, false);
  assert.equal(state.isActive, false);
  assert.equal(state.lastError, "upstream rejected update");
});

test("overlapping callers await completed rotation instead of cached snapshot", async (t) => {
  const f = fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const list = f.deps.listConnections;
  f.deps.listConnections = async () => {
    await gate;
    return list();
  };
  const rotator = createAntigravityRotator(f.deps);
  const first = rotator.runRotation({ force: true });
  const second = rotator.runRotation({ force: true });
  release();
  const snapshots = await Promise.all([first, second]);
  for (const snapshot of snapshots) assert.deepEqual(getActiveAccountIds(snapshot), ["a"]);
  assert.equal(f.deps.history.get("a")!.turnCount, 1);
});

test("limit change during rotation is applied before overlapping callers resolve", async (t) => {
  const f = fixture(t);
  let limit = 1;
  f.deps.getSettings = () => ({
    ...getSettingsSecrets(),
    antigravityActiveLimit: limit,
    antigravitySessionThreshold: 20,
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const usage = f.deps.getUsage;
  f.deps.getUsage = async (id) => {
    await gate;
    return usage(id);
  };
  const rotator = createAntigravityRotator(f.deps);
  const first = rotator.runRotation({ force: true });
  limit = 3;
  const changed = rotator.runRotation({ force: true });
  release();
  for (const snapshot of await Promise.all([first, changed])) {
    assert.deepEqual(getActiveAccountIds(snapshot), ["a", "b", "c"]);
    assert.equal(snapshot.activeCount, 3);
  }
});
