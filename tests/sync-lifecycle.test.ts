import "../src/server/load-env.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PoolRecord } from "../src/lib/types.js";
import { initAppConfig } from "../src/server/app-config.js";
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
    })
  );

  const testCalls: string[] = [];
  const deactivated: string[] = [];
  const deletedRemotes: string[] = [];

  const ranker = createPoolRanker(
    { dataDir },
    {
      listPools: async () => [
        { id: "remote-local-a", name: poolA.name, proxyUrl: poolA.proxyUrl, type: "http", isActive: true },
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
    } as unknown as Partial<PoolRankerDeps>
  );

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

test("sync renames usable pools by ascending latency and keeps going after one rename fails", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-auto-rank-"));
  const remotePools = [
    { id: "remote-b", name: "Imported B", proxyUrl: "http://127.0.0.1:8002", type: "http", isActive: true },
    { id: "remote-a", name: "Imported A", proxyUrl: "http://127.0.0.1:8001", type: "http", isActive: true },
    { id: "remote-c", name: "Imported C", proxyUrl: "http://127.0.0.1:8003", type: "http", isActive: true },
  ];
  const updates: Array<{ id: string; name: string }> = [];
  const ranker = createPoolRanker(
    { dataDir },
    {
      listPools: async () => remotePools,
      testPool: async (id: string) => {
        const elapsedMs = id === "remote-c" ? 539 : id === "remote-b" ? 489 : 470;
        return { ok: true, elapsedMs };
      },
      bulkSetActive: async (items: Array<{ id: string; isActive: boolean }>) => items.map((item) => ({ ...item, ok: true })),
      updatePool: async (id: string, patch: { name?: string; isActive?: boolean }) => {
        updates.push({ id, name: patch.name ?? "" });
        if (id === "remote-b") throw new Error("rename unavailable");
        return {};
      },
      checkProxy: async () => {
        throw new Error("local checker must not be called");
      },
    } as unknown as Partial<PoolRankerDeps>
  );

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
