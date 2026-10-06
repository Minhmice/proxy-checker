import "../src/server/load-env.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CheckResult, PoolRecord, RemoteState } from "../src/lib/types.js";
import { createPoolRanker, type PoolRankerDeps } from "../src/server/pool-ranker.js";

function usable(ip = "203.0.113.4"): CheckResult {
  return { endpoint: "127.0.0.1:8080", protocol: "http", status: "usable", exit_ip: ip, latency_ms: 10, checked_at: Date.now(), successes: 1, failures: 0, last_error: "" };
}

function dead(message: string): CheckResult {
  return { endpoint: "127.0.0.1:8080", protocol: "http", status: "dead", exit_ip: null, latency_ms: 10, checked_at: Date.now(), successes: 0, failures: 1, last_error: message };
}

function createHarness(options: {
  remoteState?: RemoteState;
  remoteId?: string | null;
  checks?: CheckResult[];
  deleteError?: Error & { status?: number };
  updateError?: Error;
  remotePools?: Array<{ id: string; name: string; proxyUrl: string; type?: string }>;
  legacy?: boolean;
} = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-ranker-"));
  const localId = "local-1";
  const record = {
    ...(options.legacy ? { id: localId } : { localId }),
    remoteId: options.remoteId === undefined ? "remote-1" : options.remoteId,
    remoteState: options.remoteState ?? "linked",
    testState: "idle",
    name: "Original name",
    proxyUrl: "http://127.0.0.1:8080",
    type: "http",
    status: "usable",
    tier: "reserve",
    healthStatus: "done",
    latency_ms: 10,
    exit_ip: "203.0.113.4",
    checked_at: Date.now(),
    isActiveOnRouter: false,
    successes: 1,
    failures: 0,
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "pool-state.json"), JSON.stringify({ pools: { [localId]: record }, lastSyncAt: null, stats: { total: 1, active: 0, reserve: 1, dead: 0 }, lastError: "" }));
  const checks = [...(options.checks ?? [])];
  const deleted: string[] = [];
  const created: Array<{ name: string; proxyUrl: string; type: string; isActive: false }> = [];
  const updated: Array<{ id: string; patch: { name?: string; isActive?: boolean } }> = [];
  const remotePools = options.remotePools ?? [{ id: "remote-1", name: "Original name", proxyUrl: "http://127.0.0.1:8080", type: "http" }];
  const ranker = createPoolRanker({ dataDir }, {
    listPools: async () => remotePools,
    setPoolActive: async () => ({}),
    bulkSetActive: async (updates) => updates.map((item) => ({ ...item, ok: true })),
    deletePool: async (id) => { deleted.push(id); if (options.deleteError) throw options.deleteError; },
    createPool: async (input) => { created.push(input); return { id: "remote-restored", ...input }; },
    updatePool: async (id, patch) => { updated.push({ id, patch }); if (options.updateError) throw options.updateError; return {}; },
    checkProxy: async () => checks.shift() ?? usable(),
  });
  return { ranker, localId, deleted, created, updated };
}

test("linked rename updates 9Router before local state", async () => {
  const harness = createHarness({ updateError: new Error("rename refused") });
  await assert.rejects(() => harness.ranker.renamePool(harness.localId, "New name"), /rename refused/);
  assert.equal(harness.ranker.listByTier("all")[0].name, "Original name");
});

test("local-only rename trims and persists without remote update", async () => {
  const harness = createHarness({ remoteState: "removed", remoteId: null });
  const pool = await harness.ranker.renamePool(harness.localId, "  Trimmed Name  ");
  assert.equal(harness.updated.length, 0);
  assert.equal(pool.name, "Trimmed Name");
  assert.equal(harness.ranker.listByTier("removed")[0].name, "Trimmed Name");
});

test("rename rejects empty and over 100 code-point names", async () => {
  const harness = createHarness();
  await assert.rejects(() => harness.ranker.renamePool(harness.localId, "   "), /cannot be empty/);
  await assert.rejects(() => harness.ranker.renamePool(harness.localId, "a".repeat(101)), /cannot exceed 100/);
});

test("manual removal deletes remotely before updating local state", async () => {
  const harness = createHarness();
  const pool = await harness.ranker.removePool(harness.localId);
  assert.deepEqual(harness.deleted, ["remote-1"]);
  assert.equal(pool.remoteId, null);
  assert.equal(pool.remoteState, "removed");
  assert.equal(pool.tier, "removed");
});

test("unknown IDs reject lifecycle operations", async () => {
  const harness = createHarness();
  await assert.rejects(() => harness.ranker.renamePool("missing", "Name"), /not found/);
  await assert.rejects(() => harness.ranker.removePool("missing"), /not found/);
});


test("legacy id records normalize to localId", () => {
  const harness = createHarness({ legacy: true });
  const pool = harness.ranker.listByTier("all")[0];
  assert.equal(pool.localId, "local-1");
});
test("refreshRemoteTracking updates metadata, reconciles tier without health checks, and dedupes within 60s", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-ranker-track-"));
  const localId = "local-1";
  const record = {
    localId,
    remoteId: "remote-1",
    remoteState: "linked" as const,
    testState: "idle" as const,
    name: "Original name",
    proxyUrl: "http://127.0.0.1:8080",
    type: "http",
    status: "usable" as const,
    tier: "active" as const,
    healthStatus: "done" as const,
    latency_ms: 10,
    exit_ip: "203.0.113.4",
    checked_at: Date.now(),
    isActiveOnRouter: true,
    successes: 1,
    failures: 0,
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "pool-state.json"),
    JSON.stringify({ pools: { [localId]: record }, lastSyncAt: 123456, stats: { total: 1, active: 1, reserve: 0, dead: 0 }, lastError: "" })
  );

  let listCalls = 0;
  let testCalls = 0;
  let deleteCalls = 0;
  let updateCalls = 0;

  const ranker = createPoolRanker(
    { dataDir },
    {
      listPools: async () => {
        listCalls++;
        return [
          {
            id: "remote-1",
            name: "1",
            proxyUrl: "http://127.0.0.1:8080",
            type: "http",
            isActive: false,
            testStatus: "failed",
            lastError: "timeout",
            lastTestedAt: "2026-09-24T09:00:00.000Z",
          },
        ];
      },
      testPool: async () => {
        testCalls++;
        return { ok: false };
      },
      deletePool: async () => {
        deleteCalls++;
      },
      updatePool: async () => {
        updateCalls++;
        return {};
      },
      checkProxy: async () => {
        throw new Error("checkProxy must not be called during tracking");
      },
    } as unknown as Partial<PoolRankerDeps>
  );

  const beforeSync = ranker.readState().lastSyncAt;
  const first = await (ranker as unknown as { refreshRemoteTracking: () => Promise<{ refreshed: boolean; skipped: boolean }> }).refreshRemoteTracking();
  assert.equal(first.refreshed, true);

  const state = ranker.readState();
  const pool = state.pools[localId];
  assert.equal(pool.isActiveOnRouter, false);
  assert.equal(pool.tier, "reserve");
  assert.equal(pool.remoteTestStatus, "failed");
  assert.equal(pool.remoteLastError, "timeout");
  assert.equal(pool.remoteLastTestedAt, new Date("2026-09-24T09:00:00.000Z").getTime());
  assert.equal(state.lastSyncAt, beforeSync);
  assert.equal(testCalls, 0);
  assert.equal(deleteCalls, 0);
  assert.equal(updateCalls, 0);
  assert.equal(listCalls, 1);

  // Second call within 60 seconds is deduped
  const second = await (ranker as unknown as { refreshRemoteTracking: () => Promise<{ refreshed: boolean; skipped: boolean }> }).refreshRemoteTracking();
  assert.equal(second.skipped, true);
  assert.equal(listCalls, 1);
});

test("refreshRemoteTracking marks missing remote linked pool as removed locally", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-ranker-missing-"));
  const localId = "local-gone";
  const record = {
    localId,
    remoteId: "remote-gone",
    remoteState: "linked" as const,
    testState: "idle" as const,
    name: "Gone name",
    proxyUrl: "http://127.0.0.1:8081",
    type: "http",
    status: "usable" as const,
    tier: "active" as const,
    healthStatus: "done" as const,
    latency_ms: 20,
    exit_ip: "203.0.113.5",
    checked_at: Date.now(),
    isActiveOnRouter: true,
    successes: 1,
    failures: 0,
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "pool-state.json"),
    JSON.stringify({ pools: { [localId]: record }, lastSyncAt: null, stats: { total: 1, active: 1, reserve: 0, dead: 0 }, lastError: "" })
  );

  const ranker = createPoolRanker(
    { dataDir },
    {
      listPools: async () => [],
    } as unknown as Partial<PoolRankerDeps>
  );

  await (ranker as unknown as { refreshRemoteTracking: () => Promise<{ refreshed: boolean; skipped: boolean }> }).refreshRemoteTracking();
  const pool = ranker.readState().pools[localId];
  assert.equal(pool.remoteId, null);
  assert.equal(pool.remoteState, "removed");
  assert.equal(pool.tier, "removed");
  assert.equal(pool.isActiveOnRouter, false);
});

test("exportActiveProxies formats active proxies as txt and csv with credentials toggled", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-ranker-export-"));
  const pool1: PoolRecord = {
    localId: "p1",
    remoteId: "p1",
    remoteState: "linked",
    testState: "idle",
    name: "1",
    proxyUrl: "socks5://user:pass@127.0.0.1:1080",
    type: "http",
    status: "usable",
    tier: "active",
    healthStatus: "done",
    latency_ms: 10,
    exit_ip: "203.0.113.1",
    checked_at: Date.now(),
    isActiveOnRouter: true,
    successes: 1,
    failures: 0,
  };
  const pool2: PoolRecord = {
    localId: "p2",
    remoteId: "p2",
    remoteState: "linked",
    testState: "idle",
    name: "2",
    proxyUrl: "http://127.0.0.1:8080",
    type: "http",
    status: "usable",
    tier: "reserve",
    healthStatus: "done",
    latency_ms: 20,
    exit_ip: "203.0.113.2",
    checked_at: Date.now(),
    isActiveOnRouter: false,
    successes: 1,
    failures: 0,
  };
  fs.writeFileSync(
    path.join(dataDir, "pool-state.json"),
    JSON.stringify({ pools: { p1: pool1, p2: pool2 }, lastSyncAt: null, stats: { total: 2, active: 1, reserve: 1, dead: 0 }, lastError: "" })
  );

  const ranker = createPoolRanker({ dataDir }, {} as unknown as Partial<PoolRankerDeps>);

  const txtWithCreds = ranker.exportActiveProxies({ format: "txt", includeCredentials: true });
  assert.equal(txtWithCreds.count, 1);
  assert.equal(txtWithCreds.body, "socks5://user:pass@127.0.0.1:1080");

  const txtNoCreds = ranker.exportActiveProxies({ format: "txt", includeCredentials: false });
  assert.equal(txtNoCreds.count, 1);
  assert.equal(txtNoCreds.body, "socks5://127.0.0.1:1080");

  const csvWithCreds = ranker.exportActiveProxies({ format: "csv", includeCredentials: true });
  assert.equal(csvWithCreds.count, 1);
  assert.match(csvWithCreds.body, /"socks5","127\.0\.0\.1",1080,"user","pass"/);

  const usableTxt = ranker.exportActiveProxies({ format: "txt", scope: "usable" });
  assert.equal(usableTxt.count, 2);
});
