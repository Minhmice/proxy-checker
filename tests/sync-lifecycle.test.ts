import "../src/server/load-env.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PoolRecord } from "../src/lib/types.js";
import { initAppConfig, updateSettings } from "../src/server/app-config.js";
import { createPoolRanker, type PoolRankerDeps } from "../src/server/pool-ranker.js";

initAppConfig();

function record(localId: string, proxyPort: number): PoolRecord {
  return {
    localId,
    remoteId: `remote-${localId}`,
    remoteState: "linked",
    testState: "idle",
    name: `Pool ${localId}`,
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    type: "http",
    status: "usable",
    tier: "reserve",
    healthStatus: "done",
    latency_ms: 10,
    exit_ip: "203.0.113.1",
    checked_at: Date.now(),
    isActiveOnRouter: true,
    successes: 1,
    failures: 0,
  };
}

test("sync uses 9Router testPool, deactivates then deletes on explicit failure, and ignores checkProxy", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-lifecycle-"));
  const poolA = record("local-a", 8001);
  fs.writeFileSync(
    path.join(dataDir, "pool-state.json"),
    JSON.stringify({
      pools: { [poolA.localId]: poolA },
      lastSyncAt: null,
      stats: { total: 1, active: 1, reserve: 0, dead: 0 },
      lastError: "",
    }),
  );

  const testCalls: string[] = [];
  const deactivated: string[] = [];
  const deletedRemotes: string[] = [];

  const ranker = createPoolRanker({ dataDir }, {
    listPools: async () => [
      {
        id: "remote-local-a",
        name: poolA.name,
        proxyUrl: poolA.proxyUrl,
        type: "http",
        isActive: true,
      },
    ],
    testPool: async (id: string) => {
      testCalls.push(id);
      return { ok: false, error: "Proxy test timed out", elapsedMs: 6000 };
    },
    setPoolActive: async (id: string, isActive: boolean) => {
      if (!isActive) deactivated.push(id);
      return {};
    },
    deletePool: async (id: string) => {
      deletedRemotes.push(id);
    },
    bulkSetActive: async () => [],
    checkProxy: async () => {
      throw new Error("local checker must not be called during sync");
    },
  } as unknown as Partial<PoolRankerDeps>);

  await ranker.syncPools({ force: true });
  const state = ranker.readState();
  assert.deepEqual(testCalls, ["remote-local-a"]);
  assert.deepEqual(deactivated, ["remote-local-a"]);
  assert.deepEqual(deletedRemotes, ["remote-local-a"]);
  assert.equal(state.pools["local-a"].remoteState, "removed");
  assert.equal(state.pools["local-a"].remoteId, null);
  assert.equal(state.pools["local-a"].tier, "removed");
  assert.equal(state.pools["local-a"].isActiveOnRouter, false);
});

test("sync preserves remote pool and active truth on reported 9Router transport failure", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-transport-failure-"));
  const pool = record("local-transport", 8002);
  fs.writeFileSync(
    path.join(dataDir, "pool-state.json"),
    JSON.stringify({
      pools: { [pool.localId]: pool },
      lastSyncAt: null,
      stats: { total: 1, active: 1, reserve: 0, dead: 0 },
      lastError: "",
    }),
  );
  const deleted: string[] = [];
  const deactivated: string[] = [];
  const ranker = createPoolRanker({ dataDir }, {
    listPools: async () => [
      {
        id: pool.remoteId!,
        name: pool.name,
        proxyUrl: pool.proxyUrl,
        type: "http",
        isActive: true,
      },
    ],
    testPool: async () => ({
      ok: false,
      failureKind: "transport",
      error:
        "fetch failed: Client network socket disconnected before secure TLS connection established (ECONNRESET)",
    }),
    setPoolActive: async (id: string, active: boolean) => {
      if (!active) deactivated.push(id);
      return {};
    },
    deletePool: async (id: string) => {
      deleted.push(id);
    },
    bulkSetActive: async () => [],
    checkProxy: async () => {
      throw new Error("local checker must not be called during sync");
    },
  } as unknown as Partial<PoolRankerDeps>);

  await ranker.syncPools({ force: true });
  const state = ranker.readState().pools[pool.localId];
  assert.deepEqual(deleted, []);
  assert.deepEqual(deactivated, []);
  assert.equal(state.remoteId, pool.remoteId);
  assert.equal(state.remoteState, "linked");
  assert.equal(state.isActiveOnRouter, true);
  assert.equal(state.status, "usable");
});

test("sync unbinds accounts before retrying a pool delete blocked by usage", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-unbind-delete-"));
  const pool = record("local-bound", 8003);
  fs.writeFileSync(
    path.join(dataDir, "pool-state.json"),
    JSON.stringify({
      pools: { [pool.localId]: pool },
      lastSyncAt: null,
      stats: { total: 1, active: 1, reserve: 0, dead: 0 },
      lastError: "",
    }),
  );
  let deleteAttempts = 0;
  const unbound: string[] = [];
  const ranker = createPoolRanker({ dataDir }, {
    listPools: async () => [
      {
        id: pool.remoteId!,
        name: pool.name,
        proxyUrl: pool.proxyUrl,
        type: "http",
        isActive: true,
      },
    ],
    testPool: async () => ({ ok: false, error: "Proxy test timed out" }),
    setPoolActive: async () => ({}),
    deletePool: async () => {
      deleteAttempts += 1;
      if (deleteAttempts === 1)
        throw Object.assign(new Error("Proxy pool is currently in use"), { status: 409 });
    },
    unbindConnectionsFromPool: async (remoteId: string) => {
      unbound.push(remoteId);
    },
    bulkSetActive: async () => [],
    checkProxy: async () => {
      throw new Error("local checker must not be called during sync");
    },
  } as unknown as Partial<PoolRankerDeps>);

  await ranker.syncPools({ force: true });
  const state = ranker.readState().pools[pool.localId];
  assert.equal(deleteAttempts, 2);
  assert.deepEqual(unbound, [pool.remoteId]);
  assert.equal(state.remoteState, "removed");
  assert.equal(state.remoteId, null);
});

test("sync renames usable pools by ascending latency and keeps going after one rename fails", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-auto-rank-"));
  const remotePools = [
    {
      id: "remote-b",
      name: "Imported B",
      proxyUrl: "http://127.0.0.1:8002",
      type: "http",
      isActive: true,
    },
    {
      id: "remote-a",
      name: "Imported A",
      proxyUrl: "http://127.0.0.1:8001",
      type: "http",
      isActive: true,
    },
    {
      id: "remote-c",
      name: "Imported C",
      proxyUrl: "http://127.0.0.1:8003",
      type: "http",
      isActive: true,
    },
  ];
  const updates: Array<{ id: string; name: string }> = [];
  const ranker = createPoolRanker({ dataDir }, {
    listPools: async () => remotePools,
    testPool: async (id: string) => {
      const elapsedMs = id === "remote-c" ? 539 : id === "remote-b" ? 489 : 470;
      return { ok: true, elapsedMs };
    },
    bulkSetActive: async (items: Array<{ id: string; isActive: boolean }>) =>
      items.map((item) => ({ ...item, ok: true })),
    updatePool: async (id: string, patch: { name?: string; isActive?: boolean }) => {
      updates.push({ id, name: patch.name ?? "" });
      if (id === "remote-b") throw new Error("rename unavailable");
      return {};
    },
    checkProxy: async () => {
      throw new Error("local checker must not be called");
    },
  } as unknown as Partial<PoolRankerDeps>);

  await ranker.syncPools({ force: true });

  const state = ranker.readState();
  assert.deepEqual(updates, [
    { id: "remote-c", name: "3" },
    { id: "remote-b", name: "2" },
    { id: "remote-a", name: "1" },
  ]);
  assert.equal(state.pools["remote-a"].name, "1");
  assert.equal(state.pools["remote-b"].name, "Imported B");
  assert.equal(state.pools["remote-c"].name, "3");
});

test("sync reconciles tier to remote truth on activation failure and renames highest rank to 1", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-activation-fail-"));
  const remotePools = [
    {
      id: "remote-a",
      name: "Imported A",
      proxyUrl: "http://127.0.0.1:8001",
      type: "http",
      isActive: false,
    },
    {
      id: "remote-b",
      name: "Imported B",
      proxyUrl: "http://127.0.0.1:8002",
      type: "http",
      isActive: false,
    },
    {
      id: "remote-c",
      name: "Imported C",
      proxyUrl: "http://127.0.0.1:8003",
      type: "http",
      isActive: false,
    },
  ];
  const renameCalls: Array<{ id: string; name: string }> = [];

  const ranker = createPoolRanker({ dataDir }, {
    listPools: async () => remotePools,
    testPool: async (id: string) => {
      const elapsedMs = id === "remote-a" ? 100 : id === "remote-b" ? 200 : 300;
      return { ok: true, elapsedMs };
    },
    bulkSetActive: async (items: Array<{ id: string; isActive: boolean }>) =>
      items.map((item) =>
        item.id === "remote-b"
          ? { ...item, ok: false, error: "remote update refused" }
          : { ...item, ok: true },
      ),
    updatePool: async (id: string, patch: { name?: string; isActive?: boolean }) => {
      renameCalls.push({ id, name: patch.name ?? "" });
      return {};
    },
    checkProxy: async () => {
      throw new Error("local checker must not be called");
    },
  } as unknown as Partial<PoolRankerDeps>);

  await ranker.syncPools({ force: true });
  const state = ranker.readState();

  assert.equal(state.pools["remote-b"].isActiveOnRouter, false);
  assert.equal(state.pools["remote-b"].tier, "reserve");
  assert.match(state.pools["remote-b"].last_error ?? "", /remote update refused/);

  assert.deepEqual(renameCalls, [
    { id: "remote-c", name: "3" },
    { id: "remote-b", name: "2" },
    { id: "remote-a", name: "1" },
  ]);
});

test("startSyncIfStale respects nineRouterAutoSync false and does not run sync", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-lifecycle-disabled-"));
  fs.writeFileSync(
    path.join(dataDir, "pool-state.json"),
    JSON.stringify({
      pools: {},
      lastSyncAt: 0,
      stats: { total: 0, active: 0, reserve: 0, dead: 0 },
      lastError: "",
    }),
  );

  updateSettings({ nineRouterAutoSync: false });

  let calledList = false;
  const ranker = createPoolRanker({ dataDir }, {
    listPools: async () => {
      calledList = true;
      return [];
    },
  } as unknown as Partial<PoolRankerDeps>);

  try {
    const result = await ranker.startSyncIfStale();
    assert.equal(result.started, false);
    assert.equal(result.stale, false);
    assert.equal(calledList, false);
  } finally {
    updateSettings({ nineRouterAutoSync: true });
  }
});
