import "../src/server/load-env.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CheckResult, PoolRecord, RemoteState } from "../src/lib/types.js";
import { createPoolRanker } from "../src/server/pool-ranker.js";

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

async function waitForIdle(ranker: ReturnType<typeof createPoolRanker>, localId: string, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (ranker.readState().pools[localId]?.testState !== "idle") {
    if (Date.now() >= deadline) throw new Error(`Timeout waiting for pool ${localId} to reach idle`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("retry success keeps the remote pool and records a transient failure", async () => {
  const harness = createHarness({ checks: [dead("timeout"), usable()] });
  await harness.ranker.testPools([harness.localId]);
  await waitForIdle(harness.ranker, harness.localId);
  const pool = harness.ranker.listByTier("all")[0];
  assert.equal(harness.deleted.length, 0);
  assert.equal(pool.remoteState, "linked");
  assert.equal(pool.status, "usable");
  assert.equal(pool.firstFailure, "timeout");
  assert.equal(pool.failures, 1);
  assert.equal(pool.successes, 2);
});

test("two failures remove remotely and retain the local record", async () => {
  const harness = createHarness({ checks: [dead("timeout"), dead("timeout")] });
  await harness.ranker.testPools([harness.localId]);
  await waitForIdle(harness.ranker, harness.localId);
  const pool = harness.ranker.listByTier("removed")[0];
  assert.deepEqual(harness.deleted, ["remote-1"]);
  assert.equal(pool.remoteId, null);
  assert.equal(pool.remoteState, "removed");
  assert.equal(pool.proxyUrl, "http://127.0.0.1:8080");
  assert.equal(pool.failures, 2);
});

test("delete failure keeps remote identity and exposes delete_failed", async () => {
  const harness = createHarness({ checks: [dead("timeout"), dead("timeout")], deleteError: new Error("upstream unavailable") });
  await harness.ranker.testPools([harness.localId]);
  await waitForIdle(harness.ranker, harness.localId);
  const pool = harness.ranker.listByTier("removed")[0];
  assert.equal(pool.remoteId, "remote-1");
  assert.equal(pool.remoteState, "delete_failed");
  assert.match(pool.last_error ?? "", /upstream unavailable/);
});

test("DELETE 404 is idempotent success", async () => {
  const error = Object.assign(new Error("missing"), { status: 404 });
  const harness = createHarness({ checks: [dead("timeout"), dead("timeout")], deleteError: error });
  await harness.ranker.testPools([harness.localId]);
  await waitForIdle(harness.ranker, harness.localId);
  const pool = harness.ranker.listByTier("removed")[0];
  assert.equal(pool.remoteId, null);
  assert.equal(pool.remoteState, "removed");
});

test("a removed proxy becomes revived without remote creation", async () => {
  const harness = createHarness({ remoteState: "removed", remoteId: null, checks: [usable()] });
  await harness.ranker.testPools([harness.localId]);
  await waitForIdle(harness.ranker, harness.localId);
  assert.equal(harness.created.length, 0);
  assert.equal(harness.ranker.listByTier("removed")[0].remoteState, "revived");
});

test("restore creates an inactive remote pool and stores its new id", async () => {
  const harness = createHarness({ remoteState: "revived", remoteId: null, remotePools: [] });
  const pool = await harness.ranker.restorePool(harness.localId);
  assert.equal(harness.created[0].isActive, false);
  assert.equal(pool.remoteId, "remote-restored");
  assert.equal(pool.remoteState, "linked");
  assert.equal(pool.tier, "reserve");
});

test("restore reconciles an endpoint already present remotely for revived pool", async () => {
  const harness = createHarness({ remoteState: "revived", remoteId: null, remotePools: [{ id: "existing", name: "Remote", proxyUrl: "http://127.0.0.1:8080", type: "http" }] });
  const pool = await harness.ranker.restorePool(harness.localId);
  assert.equal(harness.created.length, 0);
  assert.equal(pool.remoteId, "existing");
  assert.equal(pool.remoteState, "linked");
});

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
  await assert.rejects(() => harness.ranker.restorePool("missing"), /not found/);
});

test("manual tests dedupe duplicate and busy IDs", async () => {
  const harness = createHarness();
  const result = await harness.ranker.testPools([harness.localId, harness.localId, "unknown"]);
  assert.deepEqual(result, { accepted: [harness.localId], busy: [] });
  await waitForIdle(harness.ranker, harness.localId);
});

test("legacy id records normalize to localId", () => {
  const harness = createHarness({ legacy: true });
  const pool = harness.ranker.listByTier("all")[0];
  assert.equal(pool.localId, "local-1");
});
