import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  createAntigravityRotator,
  extractAntigravityUsage,
} from "../src/server/antigravity-rotator.js";
import { openAntigravityRotationHistory } from "../src/server/antigravity-rotation-history.js";
import { getSettingsSecrets } from "../src/server/app-config.js";
import type { NineRouterConnectionItem } from "../src/server/nine-router-client.js";

const url = "https://router.test";
const key = (id: string, endpoint = url) => `${endpoint}:::${id}`;

function fixture(t: TestContext) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-turns-"));
  const history = openAntigravityRotationHistory(dataDir);
  t.after(() => {
    history.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const endpoints = new Map<string, NineRouterConnectionItem[]>([
    [
      url,
      [
        { id: "a", provider: "antigravity", isActive: true },
        { id: "b", provider: "antigravity", isActive: false },
        { id: "c", provider: "antigravity", isActive: false },
      ],
    ],
  ]);
  const quotas = new Map<string, number>([
    [key("a"), 100],
    [key("b"), 100],
    [key("c"), 100],
  ]);
  const resets = new Map<string, string>();
  const events: string[] = [];
  const unread = new Set<string>();
  const unavailable = new Set<string>();
  const accountErrors = new Map<string, string>();
  const failedWrites = new Set<string>();
  const uncertainWrites = new Set<string>();
  const samples = [15, 20, 10, 15];
  let sampleCount = 0;
  const deps = {
    dataDir,
    history,
    getSettings: getSettingsSecrets,
    getRouterUrls: () => [...endpoints.keys()],
    sampleThreshold: () => samples[sampleCount++] ?? 15,
    listConnections: async (overrides?: { url?: string }) => {
      const endpoint = overrides?.url ?? url;
      events.push(`read:${endpoint}`);
      if (unread.has(endpoint)) throw new Error("endpoint unavailable");
      return structuredClone(endpoints.get(endpoint) ?? []);
    },
    getUsage: async (
      id: string,
      overrides?: { url?: string },
    ): Promise<Record<string, unknown>> => {
      const idKey = key(id, overrides?.url);
      if (unavailable.has(idKey)) throw new Error("usage transport unavailable");
      const error = accountErrors.get(idKey);
      return error
        ? { error, quotas: {} }
        : {
            quotas: {
              gemini_session: {
                remainingPercentage: quotas.get(idKey),
                resetAt: resets.get(idKey),
              },
            },
          };
    },
    updateConnection: async (
      id: string,
      patch: { isActive?: boolean },
      overrides?: { url?: string },
    ) => {
      const endpoint = overrides?.url ?? url;
      const mutation = `${patch.isActive ? "on" : "off"}:${key(id, endpoint)}`;
      events.push(mutation);
      if (failedWrites.has(mutation)) throw new Error("write rejected");
      const connection = endpoints.get(endpoint)!.find((item) => item.id === id)!;
      connection.isActive = patch.isActive;
      if (uncertainWrites.has(mutation)) throw new Error("write outcome unknown");
      return { connection: structuredClone(connection) };
    },
  };
  return {
    dataDir,
    history,
    endpoints,
    quotas,
    resets,
    events,
    unread,
    unavailable,
    accountErrors,
    failedWrites,
    uncertainWrites,
    deps,
    sampleCount: () => sampleCount,
  };
}

const active = (f: { endpoints: Map<string, NineRouterConnectionItem[]> }, endpoint = url) =>
  f.endpoints
    .get(endpoint)!
    .filter((connection) => connection.isActive)
    .map((connection) => connection.id);

test("history persists pending threshold across reopen and confirms activation once", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-history-"));
  const first = openAntigravityRotationHistory(dataDir);
  assert.equal(first.prepareActivation(key("a"), 10).thresholdPercentage, 10);
  assert.equal(first.prepareActivation(key("a"), 20).thresholdPercentage, 10);
  first.close();
  const second = openAntigravityRotationHistory(dataDir);
  t.after(() => {
    second.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  assert.equal(second.get(key("a"))?.thresholdPercentage, 10);
  assert.equal(second.confirmActivation(key("a"), 123).turnCount, 1);
  assert.equal(second.confirmActivation(key("a"), 456).turnCount, 1);
  assert.equal(second.get(key("a"))?.lastActivatedAt, 123);
  second.confirmDeactivation(key("a"));
  assert.equal(second.get(key("a"))?.thresholdPercentage, null);
  assert.equal(second.prepareActivation(key("a"), 20).thresholdPercentage, 20);
  assert.equal(second.confirmActivation(key("a"), 789).turnCount, 2);
});

test("legacy rows upgrade additively and invalid thresholds normalize once", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-legacy-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const databasePath = path.join(dataDir, "antigravity-rotation.sqlite3");
  const legacy = new Database(databasePath);
  legacy.exec(
    "CREATE TABLE antigravity_account_turns (account_id TEXT PRIMARY KEY, turn_count INTEGER NOT NULL DEFAULT 0, last_activated_at INTEGER); INSERT INTO antigravity_account_turns VALUES ('legacy', 4, 123)",
  );
  legacy.close();
  const history = openAntigravityRotationHistory(dataDir);
  const upgraded = history.get("legacy")!;
  assert.equal(upgraded.turnCount, 4);
  assert.equal(upgraded.lastActivatedAt, 123);
  assert.equal(upgraded.thresholdPercentage, null);
  history.adoptActive("legacy", 10);
  history.close();
  const db = new Database(databasePath);
  db.prepare(
    "UPDATE antigravity_account_turns SET threshold_percentage = 25 WHERE account_id = ?",
  ).run("legacy");
  db.close();
  const reopened = openAntigravityRotationHistory(dataDir);
  try {
    assert.equal(reopened.adoptActive("legacy", 20).thresholdPercentage, 20);
    assert.equal(reopened.adoptActive("legacy", 10).thresholdPercentage, 20);
    assert.equal(reopened.get("legacy")?.turnCount, 4);
  } finally {
    reopened.close();
  }
});

test("threshold persistence failure prevents activation", async (t) => {
  const f = fixture(t);
  f.quotas.set(key("a"), 10);
  const history = {
    ...f.history,
    prepareActivation: () => {
      throw new Error("disk full");
    },
  };
  const snapshot = await createAntigravityRotator({ ...f.deps, history }).runRotation({
    force: true,
  });
  assert.deepEqual(active(f), ["a"]);
  assert.ok(!f.events.some((event) => event.startsWith("on:") || event.startsWith("off:")));
  assert.equal(snapshot.degraded, true);
  assert.match(snapshot.error ?? "", /disk full/);
});

test("failed activation confirmation does not deactivate incumbent", async (t) => {
  const f = fixture(t);
  f.quotas.set(key("a"), 10);
  const update = f.deps.updateConnection;
  f.deps.updateConnection = async (id, patch, overrides) => {
    const result = await update(id, patch, overrides);
    if (id === "b" && patch.isActive) f.unread.add(url);
    return result;
  };
  const snapshot = await createAntigravityRotator(f.deps).runRotation({ force: true });
  assert.deepEqual(active(f), ["a", "b"]);
  assert.ok(!f.events.includes(`off:${key("a")}`));
  assert.equal(snapshot.degraded, true);
});

test("startup confirms retained active account before pruning extras", async (t) => {
  const f = fixture(t);
  f.endpoints.get(url)![1].isActive = true;
  f.resets.set(key("a"), "2099-01-02T00:00:00Z");
  f.resets.set(key("b"), "2099-01-01T00:00:00Z");
  await createAntigravityRotator(f.deps).runRotation({ force: true });
  const off = f.events.indexOf(`off:${key("a")}`);
  assert.ok(off > 0);
  assert.equal(f.events.slice(0, off).filter((event) => event === `read:${url}`).length, 2);
  assert.deepEqual(active(f), ["b"]);
});

test("adopting an already active account does not invent a turn", (t) => {
  const f = fixture(t);
  const turn = f.history.adoptActive(key("a"), 15);
  assert.equal(turn.turnCount, 0);
  assert.equal(turn.thresholdPercentage, 15);
  assert.equal(f.history.adoptActive(key("a"), 20).thresholdPercentage, 15);
});

test("quota-only denial is unavailable telemetry, not fresh account failure", async (t) => {
  const f = fixture(t);
  f.accountErrors.set(key("a"), "quota API access forbidden; chat may still work");
  const snapshot = await createAntigravityRotator(f.deps).runRotation({ force: true });
  assert.deepEqual(active(f), ["a"]);
  assert.equal(snapshot.accounts.find((account) => account.id === "a")?.quotaAvailable, false);
  assert.ok(!f.events.some((event) => event.startsWith("on:") || event.startsWith("off:")));
});

test("stale connection error blocks promotion without forcing incumbent handoff", async (t) => {
  const f = fixture(t);
  f.endpoints.get(url)![0].lastError = "stale failure";
  f.endpoints.get(url)![1].lastError = "stale failure";
  let snapshot = await createAntigravityRotator(f.deps).runRotation({ force: true });
  assert.deepEqual(active(f), ["a"]);
  f.endpoints.get(url)![0].isActive = false;
  f.quotas.set(key("c"), 0);
  snapshot = await createAntigravityRotator(f.deps).runRotation({ force: true });
  assert.deepEqual(active(f), []);
  assert.match(snapshot.error ?? "", /No eligible account/);
});

test("zero Gemini session quota is available; missing session remains unavailable", () => {
  const zero = extractAntigravityUsage({ quotas: { gemini_session: { remainingPercentage: 0 } } });
  const missing = extractAntigravityUsage({ quotas: {} });
  assert.equal(zero.sessionPercentage, 0);
  assert.equal(zero.quotaAvailable, true);
  assert.equal(missing.quotaAvailable, false);
});

test("keeps threshold through force, restart and no successor, resampling after confirmed off", async (t) => {
  const f = fixture(t);
  f.quotas.set(key("a"), 15);
  f.quotas.set(key("b"), 20);
  f.quotas.set(key("c"), 0);
  const first = createAntigravityRotator(f.deps);
  let snapshot = await first.runRotation({ force: true });
  assert.deepEqual(active(f), ["a"]);
  assert.equal(snapshot.accounts.find((a) => a.id === "a")?.thresholdPercentage, 15);
  snapshot = await createAntigravityRotator(f.deps).runRotation({ force: true });
  assert.equal(snapshot.accounts.find((a) => a.id === "a")?.thresholdPercentage, 15);
  assert.equal(f.sampleCount(), 1);
  f.quotas.set(key("b"), 100);
  await first.runRotation({ force: true });
  assert.deepEqual(active(f), ["b"]);
  assert.equal(f.history.get(key("b"))?.thresholdPercentage, 20);
  f.quotas.set(key("b"), 20);
  f.quotas.set(key("a"), 100);
  await first.runRotation({ force: true });
  assert.deepEqual(active(f), ["a"]);
  assert.equal(f.history.get(key("a"))?.thresholdPercentage, 10);
  assert.equal(f.sampleCount(), 3);
});

test("confirms successor enabled before deactivating incumbent", async (t) => {
  const f = fixture(t);
  f.quotas.set(key("a"), 10);
  const snapshot = await createAntigravityRotator(f.deps).runRotation({ force: true });
  const on = f.events.indexOf(`on:${key("b")}`);
  const off = f.events.indexOf(`off:${key("a")}`);
  assert.ok(on >= 0 && off > on);
  assert.ok(f.events.slice(on + 1, off).includes(`read:${url}`));
  assert.deepEqual(active(f), ["b"]);
  assert.equal(snapshot.degraded, false);
});

test("activation failure keeps incumbent and pending threshold", async (t) => {
  const f = fixture(t);
  f.quotas.set(key("a"), 10);
  f.failedWrites.add(`on:${key("b")}`);
  const snapshot = await createAntigravityRotator(f.deps).runRotation({ force: true });
  assert.deepEqual(active(f), ["a"]);
  assert.ok(!f.events.includes(`off:${key("a")}`));
  assert.equal(f.history.get(key("b"))?.thresholdPercentage, 20);
  assert.equal(snapshot.degraded, true);
});

test("unknown activation outcome is reconciled before another activation", async (t) => {
  const f = fixture(t);
  f.quotas.set(key("a"), 10);
  f.uncertainWrites.add(`on:${key("b")}`);
  const rotator = createAntigravityRotator(f.deps);
  const snapshot = await rotator.runRotation({ force: true });
  assert.deepEqual(active(f), ["a", "b"]);
  assert.equal(snapshot.degraded, true);
  f.uncertainWrites.clear();
  await rotator.runRotation({ force: true });
  assert.deepEqual(active(f), ["b"]);
  assert.equal(f.history.get(key("b"))?.turnCount, 1);
  assert.equal(f.events.filter((event) => event.startsWith("on:")).length, 1);
});

test("failed deactivation reports degraded and preserves both confirmed actives", async (t) => {
  const f = fixture(t);
  f.quotas.set(key("a"), 10);
  f.failedWrites.add(`off:${key("a")}`);
  const snapshot = await createAntigravityRotator(f.deps).runRotation({ force: true });
  assert.deepEqual(active(f), ["a", "b"]);
  assert.equal(snapshot.activeCount, 2);
  assert.equal(snapshot.degraded, true);
  assert.equal(f.history.get(key("a"))?.thresholdPercentage, 15);
});

test("failed usage transport retains incumbent without treating it as account error", async (t) => {
  const f = fixture(t);
  f.unavailable.add(key("a"));
  const snapshot = await createAntigravityRotator(f.deps).runRotation({ force: true });
  assert.deepEqual(active(f), ["a"]);
  assert.equal(snapshot.accounts.find((a) => a.id === "a")?.quotaAvailable, false);
  assert.ok(!f.events.some((event) => event.startsWith("on:") || event.startsWith("off:")));
});

test("fresh account error triggers replacement", async (t) => {
  const f = fixture(t);
  f.accountErrors.set(key("a"), "account disabled");
  await createAntigravityRotator(f.deps).runRotation({ force: true });
  assert.deepEqual(active(f), ["b"]);
});

test("unread endpoint blocks activation and reports degraded", async (t) => {
  const f = fixture(t);
  f.endpoints.get(url)![0].isActive = false;
  f.endpoints.set("https://other.test", []);
  f.unread.add("https://other.test");
  const snapshot = await createAntigravityRotator(f.deps).runRotation({ force: true });
  assert.deepEqual(active(f), []);
  assert.equal(snapshot.degraded, true);
  assert.equal(
    snapshot.endpoints?.find((endpoint) => endpoint.url === "https://other.test")?.ok,
    false,
  );
  assert.ok(!f.events.some((event) => event.startsWith("on:")));
});

test("duplicate raw IDs remain endpoint-qualified in history and updates", async (t) => {
  const f = fixture(t);
  f.endpoints.get(url)!.splice(1);
  const second = "https://second.test";
  f.endpoints.set(second, [{ id: "a", provider: "antigravity", isActive: false }]);
  f.quotas.set(key("a"), 10);
  f.quotas.set(key("a", second), 100);
  await createAntigravityRotator(f.deps).runRotation({ force: true });
  assert.deepEqual(active(f), []);
  assert.deepEqual(active(f, second), ["a"]);
  assert.equal(f.history.get(key("a"))?.thresholdPercentage, null);
  assert.equal(f.history.get(key("a", second))?.thresholdPercentage, 20);
  assert.ok(f.events.includes(`on:${key("a", second)}`));
  assert.ok(f.events.includes(`off:${key("a")}`));
});

test("overlapping calls queue a fresh single-flight cycle", async (t) => {
  const f = fixture(t);
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const list = f.deps.listConnections;
  let reads = 0;
  f.deps.listConnections = async (overrides) => {
    reads++;
    if (reads === 1) await gate;
    return list(overrides);
  };
  const rotator = createAntigravityRotator(f.deps);
  const first = rotator.runRotation({ force: true });
  const second = rotator.runRotation({ force: true });
  release();
  const results = await Promise.all([first, second]);
  assert.ok(reads >= 2);
  assert.ok(results.every((snapshot) => snapshot.activeCount === 1));
  assert.equal(f.sampleCount(), 1);
});

test("forced refresh still runs after disabled scheduled call", async (t) => {
  const f = fixture(t);
  f.deps.getSettings = () => ({ ...getSettingsSecrets(), antigravityRotatorEnabled: false });
  const rotator = createAntigravityRotator(f.deps);
  await rotator.runRotation();
  const snapshot = await rotator.runRotation({ force: true });
  assert.equal(snapshot.activeCount, 1);
  assert.ok(f.events.includes(`read:${url}`));
});

test("usage parser rejects nonfinite Gemini session data", () => {
  const usage = extractAntigravityUsage({
    quotas: { gemini_session: { remainingPercentage: Number.NaN } },
  });
  assert.equal(usage.quotaAvailable, false);
});
