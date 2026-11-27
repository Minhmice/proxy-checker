import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  createAntigravityRotator,
  extractAntigravityUsage,
  extractClaudeUsage,
  extractCodexUsage,
} from "../src/server/antigravity-rotator.js";
import { openAntigravityRotationHistory } from "../src/server/antigravity-rotation-history.js";
import { getSettingsSecrets } from "../src/server/app-config.js";
import type { NineRouterConnectionItem } from "../src/server/nine-router-client.js";
import type { RotationProvider } from "../src/lib/types.js";

test("manual disable writes only the chosen account and publishes confirmed state", async (t) => {
  const f = fixture(t);
  const rotator = createAntigravityRotator(f.deps);
  await rotator.runRotation({ force: true });
  f.events.length = 0;
  await rotator.setAccountActive("a", url, false);
  assert.equal(
    rotator.getSnapshot().accounts.find((account) => account.id === "a")?.isActive,
    false,
  );
  assert.deepEqual(
    f.events.filter((event) => event.startsWith("on:") || event.startsWith("off:")),
    [`off:${key("a")}`],
  );
});

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
  const weeklyQuotas = new Map<string, number>();
  const resets = new Map<string, string>();
  const events: string[] = [];
  const unread = new Set<string>();
  const unavailable = new Set<string>();
  const accountErrors = new Map<string, string>();
  const failedWrites = new Set<string>();
  const uncertainWrites = new Set<string>();
  const samples = [10, 8, 6, 10];
  let sampleCount = 0;
  const deps = {
    dataDir,
    providers: ["antigravity"] as RotationProvider[],
    history,
    getSettings: getSettingsSecrets,
    getRouterUrls: () => [...endpoints.keys()],
    sampleThreshold: () => samples[sampleCount++] ?? 10,
    listConnections: async (overrides?: { url?: string; provider?: RotationProvider }) => {
      const endpoint = overrides?.url ?? url;
      events.push(`read:${endpoint}`);
      if (unread.has(endpoint)) throw new Error("endpoint unavailable");
      return structuredClone(
        (endpoints.get(endpoint) ?? []).filter(
          (account) => !overrides?.provider || account.provider === overrides.provider,
        ),
      );
    },
    getUsage: async (
      id: string,
      overrides?: { url?: string },
    ): Promise<Record<string, unknown>> => {
      const idKey = key(id, overrides?.url);
      if (unavailable.has(idKey)) throw new Error("usage transport unavailable");
      const error = accountErrors.get(idKey);
      const provider = endpoints
        .get(overrides?.url ?? url)
        ?.find((item) => item.id === id)?.provider;
      if (!error && provider === "claude") {
        const remaining = quotas.get(idKey);
        return {
          quotas: {
            "session (5h)": {
              used: remaining === undefined ? undefined : 100 - remaining,
              total: 100,
              remaining,
              remainingPercentage: remaining,
              resetAt: resets.get(idKey),
            },
            "weekly (7d)": { remainingPercentage: weeklyQuotas.get(idKey) ?? 0 },
          },
        };
      }
      if (!error && provider === "codex") {
        const remaining = quotas.get(idKey);
        return {
          quotas: {
            session: {
              used: remaining === undefined ? undefined : 100 - remaining,
              total: 100,
              remaining,
              resetAt: resets.get(idKey),
            },
            weekly: {
              used: 100 - (weeklyQuotas.get(idKey) ?? 0),
              total: 100,
              remaining: weeklyQuotas.get(idKey) ?? 0,
            },
          },
        };
      }
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
    weeklyQuotas,
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
  assert.equal(first.prepareActivation(key("a"), 5).thresholdPercentage, 5);
  assert.equal(first.prepareActivation(key("a"), 10).thresholdPercentage, 5);
  first.close();
  const second = openAntigravityRotationHistory(dataDir);
  t.after(() => {
    second.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  assert.equal(second.get(key("a"))?.thresholdPercentage, 5);
  assert.equal(second.confirmActivation(key("a"), 123).turnCount, 1);
  assert.equal(second.confirmActivation(key("a"), 456).turnCount, 1);
  assert.equal(second.get(key("a"))?.lastActivatedAt, 123);
  second.confirmDeactivation(key("a"));
  assert.equal(second.get(key("a"))?.thresholdPercentage, null);
  assert.equal(second.prepareActivation(key("a"), 10).thresholdPercentage, 10);
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
    assert.equal(reopened.adoptActive("legacy", 8).thresholdPercentage, 8);
    assert.equal(reopened.adoptActive("legacy", 10).thresholdPercentage, 8);
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
  f.endpoints.get(url)![2].isActive = true;
  f.resets.set(key("c"), "2099-01-01T12:00:00Z");
  f.resets.set(key("a"), "2099-01-02T00:00:00Z");
  f.resets.set(key("b"), "2099-01-01T00:00:00Z");
  await createAntigravityRotator(f.deps).runRotation({ force: true });
  const off = f.events.indexOf(`off:${key("a")}`);
  assert.ok(off > 0);
  assert.equal(f.events.slice(0, off).filter((event) => event === `read:${url}`).length, 3);
  assert.deepEqual(active(f), ["b", "c"]);
});

test("adopting an already active account does not invent a turn", (t) => {
  const f = fixture(t);
  const turn = f.history.adoptActive(key("a"), 5);
  assert.equal(turn.turnCount, 0);
  assert.equal(turn.thresholdPercentage, 5);
  assert.equal(f.history.adoptActive(key("a"), 10).thresholdPercentage, 5);
});

test("quota-only denial is unavailable telemetry, not fresh account failure", async (t) => {
  const f = fixture(t);
  f.accountErrors.set(key("a"), "quota API access forbidden; chat may still work");
  const snapshot = await createAntigravityRotator(f.deps).runRotation({ force: true });
  assert.deepEqual(active(f), ["a", "b"]);
  assert.equal(snapshot.accounts.find((account) => account.id === "a")?.quotaAvailable, false);
  assert.ok(!f.events.some((event) => event.startsWith("off:")));
});

test("stale connection error blocks promotion without forcing incumbent handoff", async (t) => {
  const f = fixture(t);
  f.endpoints.get(url)![0].lastError = "stale failure";
  f.endpoints.get(url)![1].lastError = "stale failure";
  let snapshot = await createAntigravityRotator(f.deps).runRotation({ force: true });
  assert.deepEqual(active(f), ["a", "c"]);
  f.endpoints.get(url)![0].isActive = false;
  f.endpoints.get(url)![2].isActive = false;
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

test("out-of-range Gemini session percentage uses valid counters or remains unavailable", () => {
  for (const remainingPercentage of [-1, 101]) {
    const missing = extractAntigravityUsage({
      quotas: { gemini_session: { remainingPercentage } },
    });
    assert.equal(missing.quotaAvailable, false);
    assert.equal(missing.sessionPercentage, 0);

    const fallback = extractAntigravityUsage({
      quotas: { gemini_session: { remainingPercentage, total: 100, used: 25 } },
    });
    assert.equal(fallback.quotaAvailable, true);
    assert.equal(fallback.sessionPercentage, 75);

    const invalidCounters = extractAntigravityUsage({
      quotas: { gemini_session: { remainingPercentage, total: 100, used: -1 } },
    });
    assert.equal(invalidCounters.quotaAvailable, false);
  }
});

test("Gemini session preserves zero and exhausted counter fallback", () => {
  const zero = extractAntigravityUsage({
    quotas: { gemini_session: { remainingPercentage: 0, total: 100, used: 25 } },
  });
  assert.equal(zero.quotaAvailable, true);
  assert.equal(zero.sessionPercentage, 0);

  const exhausted = extractAntigravityUsage({
    quotas: { gemini_session: { remainingPercentage: 101, total: 100, used: 125 } },
  });
  assert.equal(exhausted.quotaAvailable, true);
  assert.equal(exhausted.sessionPercentage, 0);
});

test("keeps threshold through force, restart and no successor, resampling after confirmed off", async (t) => {
  const f = fixture(t);
  f.quotas.set(key("a"), 10);
  f.quotas.set(key("b"), 20);
  f.quotas.set(key("c"), 0);
  const first = createAntigravityRotator(f.deps);
  let snapshot = await first.runRotation({ force: true });
  assert.deepEqual(active(f), ["a"]);
  assert.equal(snapshot.accounts.find((a) => a.id === "a")?.thresholdPercentage, 10);
  snapshot = await createAntigravityRotator(f.deps).runRotation({ force: true });
  assert.equal(snapshot.accounts.find((a) => a.id === "a")?.thresholdPercentage, 10);
  assert.equal(f.sampleCount(), 1);
  f.quotas.set(key("b"), 100);
  await first.runRotation({ force: true });
  assert.deepEqual(active(f), ["b"]);
  assert.equal(f.history.get(key("b"))?.thresholdPercentage, 8);
  f.quotas.set(key("b"), 8);
  f.quotas.set(key("a"), 100);
  await first.runRotation({ force: true });
  assert.deepEqual(active(f), ["a"]);
  assert.equal(f.history.get(key("a"))?.thresholdPercentage, 6);
  assert.equal(f.sampleCount(), 3);
});

test("publishes a rotation only after the incumbent is replaced, retaining it across no-op cycles", async (t) => {
  const f = fixture(t);
  const rotator = createAntigravityRotator(f.deps);
  const initial = await rotator.runRotation({ force: true });
  assert.equal(initial.lastRotationAt, null);

  f.quotas.set(key("a"), 10);
  const replaced = await rotator.runRotation({ force: true });
  const rotationAt = replaced.lastRotationAt;
  assert.ok(typeof rotationAt === "number" && rotationAt > 0);
  const unchanged = await rotator.runRotation({ force: true });
  assert.equal(unchanged.lastRotationAt, rotationAt);
  assert.equal(createAntigravityRotator(f.deps).getSnapshot().lastRotationAt, rotationAt);
});

test("confirms successor enabled before deactivating incumbent", async (t) => {
  const f = fixture(t);
  f.quotas.set(key("a"), 10);
  const snapshot = await createAntigravityRotator(f.deps).runRotation({ force: true });
  const on = f.events.indexOf(`on:${key("b")}`);
  const off = f.events.indexOf(`off:${key("a")}`);
  assert.ok(on >= 0 && off > on);
  assert.ok(f.events.slice(on + 1, off).includes(`read:${url}`));
  assert.deepEqual(active(f), ["b", "c"]);
  assert.equal(snapshot.degraded, false);
});

test("activation failure keeps incumbent and pending threshold", async (t) => {
  const f = fixture(t);
  f.quotas.set(key("a"), 10);
  f.failedWrites.add(`on:${key("b")}`);
  const snapshot = await createAntigravityRotator(f.deps).runRotation({ force: true });
  assert.deepEqual(active(f), ["a"]);
  assert.ok(!f.events.includes(`off:${key("a")}`));
  assert.equal(f.history.get(key("b"))?.thresholdPercentage, 8);
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
  assert.deepEqual(active(f), ["b", "c"]);
  assert.equal(f.history.get(key("b"))?.turnCount, 1);
  assert.equal(f.events.filter((event) => event === `on:${key("b")}`).length, 1);
});

test("failed deactivation reports degraded and preserves both confirmed actives", async (t) => {
  const f = fixture(t);
  f.quotas.set(key("a"), 10);
  f.failedWrites.add(`off:${key("a")}`);
  const snapshot = await createAntigravityRotator(f.deps).runRotation({ force: true });
  assert.deepEqual(active(f), ["a", "b"]);
  assert.equal(snapshot.activeCount, 2);
  assert.equal(snapshot.degraded, true);
  assert.equal(f.history.get(key("a"))?.thresholdPercentage, 10);
  assert.equal(snapshot.lastRotationAt, null);
});

test("failed usage transport retains incumbent without treating it as account error", async (t) => {
  const f = fixture(t);
  f.unavailable.add(key("a"));
  const snapshot = await createAntigravityRotator(f.deps).runRotation({ force: true });
  assert.deepEqual(active(f), ["a", "b"]);
  assert.equal(snapshot.accounts.find((a) => a.id === "a")?.quotaAvailable, false);
  assert.ok(!f.events.some((event) => event.startsWith("off:")));
});

test("fresh account error triggers replacement", async (t) => {
  const f = fixture(t);
  f.accountErrors.set(key("a"), "account disabled");
  await createAntigravityRotator(f.deps).runRotation({ force: true });
  assert.deepEqual(active(f), ["b", "c"]);
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
  assert.equal(f.history.get(key("a", second))?.thresholdPercentage, 8);
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
  assert.ok(results.every((snapshot) => snapshot.activeCount === 2));
  assert.equal(f.sampleCount(), 2);
});

test("forced refresh still runs after disabled scheduled call", async (t) => {
  const f = fixture(t);
  f.deps.getSettings = () => ({ ...getSettingsSecrets(), antigravityRotatorEnabled: false });
  const rotator = createAntigravityRotator(f.deps);
  await rotator.runRotation();
  const snapshot = await rotator.runRotation({ force: true });
  assert.equal(snapshot.activeCount, 2);
  assert.ok(f.events.includes(`read:${url}`));
});

test("usage parser rejects nonfinite Gemini session data", () => {
  const usage = extractAntigravityUsage({
    quotas: { gemini_session: { remainingPercentage: Number.NaN } },
  });
  assert.equal(usage.quotaAvailable, false);
});

test("replaces both exhausted slots sequentially without disabling healthy successors", async (t) => {
  const f = fixture(t);
  f.endpoints.get(url)![1].isActive = true;
  f.endpoints.get(url)!.push({ id: "d", provider: "antigravity", isActive: false });
  f.quotas.set(key("a"), 10);
  f.quotas.set(key("b"), 8);
  f.quotas.set(key("c"), 70);
  f.quotas.set(key("d"), 95);
  const snapshot = await createAntigravityRotator(f.deps).runRotation({ force: true });
  assert.deepEqual(active(f), ["c", "d"]);
  const writes = f.events.filter((event) => /^(on|off):/.test(event));
  assert.deepEqual(writes, [
    `on:${key("d")}`,
    `off:${key("a")}`,
    `on:${key("c")}`,
    `off:${key("b")}`,
  ]);
  assert.equal(snapshot.degraded, false);
});

test("Codex parser uses session remaining and session reset, not weekly quota", () => {
  const usage = extractCodexUsage({
    quotas: {
      session: { used: 34, total: 100, remaining: 66, resetAt: "2099-01-02T00:00:00Z" },
      weekly: { used: 100, total: 100, remaining: 0, resetAt: "2099-01-01T00:00:00Z" },
    },
  });
  assert.equal(usage.sessionPercentage, 66);
  assert.equal(usage.resetAt, "2099-01-02T00:00:00Z");
  assert.equal(usage.quotaAvailable, true);
  assert.equal(
    extractCodexUsage({ quotas: { session: { used: 34, total: 100 } } }).sessionPercentage,
    66,
  );
  assert.equal(
    extractCodexUsage({ quotas: { session: { used: 100, total: 100, remaining: 0 } } })
      .quotaAvailable,
    true,
  );
  assert.equal(
    extractCodexUsage({ quotas: { weekly: { total: 100, remaining: 100 } } }).quotaAvailable,
    false,
  );
  assert.equal(
    extractCodexUsage({ quotas: { session: { total: 100, remaining: Number.NaN } } })
      .quotaAvailable,
    false,
  );
});

test("provider groups independently fill two slots and rank by session quota then reset", async (t) => {
  const f = fixture(t);
  f.endpoints
    .get(url)!
    .push(
      { id: "d", provider: "codex", isActive: true },
      { id: "e", provider: "codex", isActive: true },
      { id: "f", provider: "codex", isActive: false },
      { id: "g", provider: "codex", isActive: false },
    );
  f.endpoints.get(url)!.push({ id: "h", provider: "codex", isActive: false });
  f.quotas.set(key("a"), 80);
  f.quotas.set(key("b"), 90);
  f.quotas.set(key("c"), 50);
  f.quotas.set(key("d"), 5);
  f.quotas.set(key("e"), 70);
  f.quotas.set(key("f"), 95);
  f.quotas.set(key("g"), 90);
  f.quotas.set(key("h"), 95);
  f.resets.set(key("f"), "2099-01-01T00:00:00Z");
  f.resets.set(key("g"), "2099-01-02T00:00:00Z");
  f.resets.set(key("h"), "2099-01-02T00:00:00Z");
  f.weeklyQuotas.set(key("f"), 0);
  f.weeklyQuotas.set(key("g"), 100);
  const rotator = createAntigravityRotator({ ...f.deps, providers: ["antigravity", "codex"] });
  const snapshot = await rotator.runRotation({ force: true });
  assert.deepEqual(active(f), ["a", "b", "e", "f"]);
  assert.deepEqual(snapshot.groups, [
    { provider: "antigravity", totalAccounts: 3, activeCount: 2 },
    { provider: "codex", totalAccounts: 5, activeCount: 2 },
  ]);
  assert.equal(snapshot.activeCount, 4);
  assert.equal(snapshot.totalAccounts, 8);
  assert.equal(snapshot.degraded, false);
  assert.equal(snapshot.accounts.find((account) => account.id === "f")?.provider, "codex");
  const on = f.events.indexOf(`on:${key("f")}`);
  const off = f.events.indexOf(`off:${key("d")}`);
  assert.ok(on >= 0 && off > on);
  assert.ok(f.events.slice(on + 1, off).includes(`read:${url}`));
  const restored = createAntigravityRotator({
    ...f.deps,
    providers: ["antigravity", "codex"],
  }).getSnapshot();
  assert.deepEqual(restored.groups, snapshot.groups);
  assert.equal(restored.accounts.find((account) => account.id === "f")?.provider, "codex");
});

test("failed Codex handoff preserves its incumbent without blocking Antigravity", async (t) => {
  const f = fixture(t);
  f.endpoints
    .get(url)!
    .push(
      { id: "d", provider: "codex", isActive: true },
      { id: "e", provider: "codex", isActive: true },
      { id: "f", provider: "codex", isActive: false },
    );
  f.quotas.set(key("d"), 5);
  f.quotas.set(key("e"), 90);
  f.quotas.set(key("f"), 99);
  f.failedWrites.add(`on:${key("f")}`);
  const snapshot = await createAntigravityRotator({
    ...f.deps,
    providers: ["antigravity", "codex"],
  }).runRotation({ force: true });
  assert.deepEqual(active(f), ["a", "b", "d", "e"]);
  assert.ok(!f.events.includes(`off:${key("d")}`));
  assert.equal(f.history.get(key("d"))?.tenureState, "active");
  assert.equal(snapshot.degraded, true);
  assert.match(snapshot.error ?? "", /Failed to activate/);
});

test("unread provider degrades its group without blocking other providers", async (t) => {
  const f = fixture(t);
  const list = f.deps.listConnections;
  f.deps.listConnections = async (overrides) => {
    if (overrides?.provider === "codex") throw new Error("Codex unavailable");
    return list(overrides);
  };
  const snapshot = await createAntigravityRotator({
    ...f.deps,
    providers: ["antigravity", "codex"],
  }).runRotation({ force: true });
  assert.deepEqual(active(f), ["a", "b"]);
  assert.equal(snapshot.degraded, true);
  assert.equal(snapshot.endpoints?.[0].ok, false);
  assert.match(snapshot.error ?? "", /codex.*Codex unavailable/i);
});

test("Codex threshold persists across refresh and restart until confirmed handoff", async (t) => {
  const f = fixture(t);
  f.endpoints
    .get(url)!
    .push(
      { id: "d", provider: "codex", isActive: true },
      { id: "e", provider: "codex", isActive: true },
      { id: "f", provider: "codex", isActive: false },
    );
  f.quotas.set(key("d"), 5);
  f.quotas.set(key("e"), 90);
  f.quotas.set(key("f"), 20);
  const deps = { ...f.deps, providers: ["antigravity", "codex"] as RotationProvider[] };
  const first = await createAntigravityRotator(deps).runRotation({ force: true });
  const threshold = first.accounts.find((account) => account.id === "d")?.thresholdPercentage;
  assert.ok(threshold !== null && threshold !== undefined && threshold >= 5 && threshold <= 10);
  assert.deepEqual(active(f), ["a", "b", "d", "e"]);
  const second = await createAntigravityRotator(deps).runRotation({ force: true });
  assert.equal(
    second.accounts.find((account) => account.id === "d")?.thresholdPercentage,
    threshold,
  );
  f.quotas.set(key("f"), 21);
  await createAntigravityRotator(deps).runRotation({ force: true });
  assert.deepEqual(active(f), ["a", "b", "e", "f"]);
  assert.equal(f.history.get(key("d"))?.thresholdPercentage, null);
  assert.equal(f.history.get(key("f"))?.tenureState, "active");
});

test("exhausted Codex session remains readable despite stored usage-limit error", async (t) => {
  const f = fixture(t);
  f.endpoints.get(url)!.push(
    { id: "d", provider: "codex", isActive: true },
    { id: "e", provider: "codex", isActive: true },
    {
      id: "empty",
      provider: "codex",
      isActive: false,
      lastError: "[429]: The usage limit has been reached",
    },
  );
  f.quotas.set(key("d"), 90);
  f.quotas.set(key("e"), 80);
  f.quotas.set(key("empty"), 0);
  const snapshot = await createAntigravityRotator({ ...f.deps, providers: ["codex"] }).runRotation({
    force: true,
  });
  const empty = snapshot.accounts.find((account) => account.id === "empty")!;
  assert.equal(empty.quotaAvailable, true);
  assert.equal(empty.sessionPercentage, 0);
  assert.equal(empty.lastError, null);
  assert.equal(empty.isActive, false);
  assert.equal(snapshot.degraded, false);
});

test("failed Antigravity write does not block Codex slot activation", async (t) => {
  const f = fixture(t);
  f.endpoints
    .get(url)!
    .push(
      { id: "d", provider: "codex", isActive: true },
      { id: "e", provider: "codex", isActive: false },
    );
  f.quotas.set(key("d"), 90);
  f.quotas.set(key("e"), 80);
  f.failedWrites.add(`on:${key("b")}`);
  const snapshot = await createAntigravityRotator({
    ...f.deps,
    providers: ["antigravity", "codex"],
  }).runRotation({ force: true });
  assert.deepEqual(active(f), ["a", "d", "e"]);
  assert.equal(snapshot.groups?.find((group) => group.provider === "codex")?.activeCount, 2);
  assert.equal(snapshot.degraded, true);
});

test("provider history uses endpoint-qualified identities", async (t) => {
  const f = fixture(t);
  f.endpoints.get(url)!.splice(1);
  const second = "https://codex.test";
  f.endpoints.set(second, [{ id: "a", provider: "codex", isActive: true }]);
  f.quotas.set(key("a", second), 80);
  await createAntigravityRotator({
    ...f.deps,
    providers: ["antigravity", "codex"],
  }).runRotation({ force: true });
  assert.equal(f.history.get(key("a"))?.thresholdPercentage, 10);
  assert.equal(f.history.get(key("a", second))?.thresholdPercentage, 8);
});

test("injected dependencies default to both provider groups", async (t) => {
  const f = fixture(t);
  f.endpoints
    .get(url)!
    .push(
      { id: "d", provider: "codex", isActive: true },
      { id: "e", provider: "codex", isActive: false },
    );
  f.quotas.set(key("d"), 75);
  f.quotas.set(key("e"), 80);
  const snapshot = await createAntigravityRotator({
    ...f.deps,
    providers: undefined,
  }).runRotation({ force: true });
  assert.deepEqual(active(f), ["a", "b", "d", "e"]);
  assert.deepEqual(snapshot.groups, [
    { provider: "antigravity", totalAccounts: 3, activeCount: 2 },
    { provider: "codex", totalAccounts: 2, activeCount: 2 },
    { provider: "claude", totalAccounts: 0, activeCount: 0 },
  ]);
});

test("Claude Code reads its 5h session and weekly windows", () => {
  const usage = extractClaudeUsage({
    quotas: {
      "session (5h)": { total: 100, used: 47, remaining: 53, resetAt: "2099-01-01T00:00:00Z" },
      "weekly (7d)": { remainingPercentage: 79 },
    },
  });
  assert.equal(usage.sessionPercentage, 53);
  assert.equal(usage.weeklyPercentage, 79);
  assert.equal(usage.quotaAvailable, true);
  assert.equal(usage.resetAt, "2099-01-01T00:00:00Z");
  assert.equal(extractClaudeUsage({ quotas: {} }).quotaAvailable, false);
});

test("Claude Code rotates its own two slots and tolerates the rate-limit 429 on an empty account", async (t) => {
  const f = fixture(t);
  const limit =
    '[429]: {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}';
  f.endpoints
    .get(url)!
    .push(
      { id: "x", provider: "claude", isActive: true },
      { id: "y", provider: "claude", isActive: true },
      { id: "z", provider: "claude", isActive: false, lastError: limit },
      { id: "w", provider: "claude", isActive: false },
    );
  f.quotas.set(key("x"), 5);
  f.quotas.set(key("y"), 80);
  f.quotas.set(key("z"), 0);
  f.quotas.set(key("w"), 60);
  const snapshot = await createAntigravityRotator({ ...f.deps, providers: ["claude"] }).runRotation(
    {
      force: true,
    },
  );
  assert.deepEqual([...active(f)].sort(), ["a", "w", "y"]);
  const empty = snapshot.accounts.find((account) => account.id === "z")!;
  assert.equal(empty.provider, "claude");
  assert.equal(empty.quotaAvailable, true);
  assert.equal(empty.lastError, null);
  assert.deepEqual(snapshot.groups, [{ provider: "claude", totalAccounts: 4, activeCount: 2 }]);
});
