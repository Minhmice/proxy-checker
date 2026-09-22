import "../src/server/load-env.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CheckResult, PoolRecord } from "../src/lib/types.js";
import { initAppConfig } from "../src/server/app-config.js";
import { clearActivity, getActivitySnapshot } from "../src/server/activity-log.js";
import { createPoolRanker, PoolConflictError, type PoolRanker } from "../src/server/pool-ranker.js";

initAppConfig();

function record(localId: string, remoteState: PoolRecord["remoteState"] = "linked"): PoolRecord {
  return {
    localId,
    remoteId: remoteState === "removed" || remoteState === "revived" ? null : `remote-${localId}`,
    remoteState,
    testState: "idle",
    name: `Pool ${localId}`,
    proxyUrl: `http://127.0.0.1:${8000 + Number(localId.replace(/\D/g, "") || 0)}`,
    type: "http",
    status: "dead",
    tier: remoteState === "linked" ? "reserve" : "removed",
    healthStatus: "done",
    latency_ms: null,
    exit_ip: null,
    checked_at: 0,
    isActiveOnRouter: false,
    successes: 0,
    failures: 0,
  };
}

function harness(records: PoolRecord[], overrides: Record<string, unknown> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-lifecycle-"));
  fs.writeFileSync(
    path.join(dataDir, "pool-state.json"),
    JSON.stringify({
      pools: Object.fromEntries(records.map((pool) => [pool.localId, pool])),
      lastSyncAt: null,
      stats: { total: records.length, active: 0, reserve: records.length, dead: 0 },
      lastError: "",
    })
  );
  const usable: CheckResult = {
    endpoint: "127.0.0.1:8001",
    protocol: "http",
    status: "usable",
    exit_ip: "203.0.113.1",
    latency_ms: 10,
    checked_at: Date.now(),
    successes: 1,
    failures: 0,
    last_error: "",
  };
  const ranker = createPoolRanker(
    { dataDir },
    {
      listPools: async () => [],
      setPoolActive: async () => ({}),
      bulkSetActive: async () => [],
      deletePool: async () => {},
      createPool: async (input) => ({ id: "created", ...input }),
      updatePool: async () => ({}),
      checkProxy: async () => usable,
      ...overrides,
    }
  );
  return { ranker, dataDir };
}

async function waitForIdle(ranker: PoolRanker, localId: string, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (ranker.readState().pools[localId]?.testState !== "idle") {
    if (Date.now() >= deadline) throw new Error(`Timeout waiting for pool ${localId} to reach idle`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("manual tests return immediately before deferred checker completes", async () => {
  const { promise: checkerGate, resolve: releaseChecker } = Promise.withResolvers<void>();

  const { ranker } = harness([record("1")], {
    checkProxy: async () => {
      await checkerGate;
      return {
        endpoint: "127.0.0.1:8001",
        protocol: "http",
        status: "usable",
        exit_ip: "203.0.113.1",
        latency_ms: 10,
        checked_at: Date.now(),
        successes: 1,
        failures: 0,
        last_error: "",
      };
    },
  });

  const response = await ranker.testPools(["1"]);
  assert.deepEqual(response, { accepted: ["1"], busy: [] });
  // Overlapping request while checkerGate is pending must report busy immediately
  assert.deepEqual(await ranker.testPools(["1"]), { accepted: [], busy: ["1"] });

  releaseChecker();
  await waitForIdle(ranker, "1");
  assert.equal(ranker.readState().pools["1"].testState, "idle");
  assert.equal(ranker.readState().pools["1"].status, "usable");
});

test("restore accepts only revived pools", async () => {
  const { ranker } = harness([record("1", "removed")]);
  await assert.rejects(ranker.restorePool("1"), /Cannot restore pool in removed state/);
});

test("delete_failed rename updates upstream first and throws conflict on 404", async () => {
  const updates: string[] = [];
  const { ranker } = harness([record("1", "delete_failed")], {
    updatePool: async (id: string) => {
      updates.push(id);
      const error = new Error("missing") as Error & { status?: number };
      error.status = 404;
      throw error;
    },
    listPools: async () => [],
  });

  await assert.rejects(ranker.renamePool("1", "New name"), PoolConflictError);
  assert.deepEqual(updates, ["remote-1"]);
  assert.equal(ranker.readState().pools["1"].name, "Pool 1");
});

test("promoting a verified diagnostic creates and activates missing router pool", async () => {
  const created: Array<{ name: string; proxyUrl: string; isActive: boolean }> = [];
  const { ranker } = harness([], {
    createPool: async (input: { name: string; proxyUrl: string; type: string; isActive: boolean }) => {
      created.push(input);
      return { id: "remote-created", ...input };
    },
    setPoolActive: async () => ({}),
  });
  const result = await ranker.promoteDiagnostics([{
    id: "diagnostic-1",
    endpoint: "127.0.0.1:8123",
    protocol: "http",
    status: "SUCCESS",
    statusCode: 200,
    latencyMs: 120,
    exitIp: "203.0.113.7",
    country: "US",
    isp: "Test ISP",
    isProxyOrHosting: false,
    headerLeakage: false,
    leakedHeaders: [],
    checkedAt: Date.now(),
  }]);
  assert.equal(result.promoted, 1);
  assert.equal(result.skipped, 0);
  assert.deepEqual(created, [{ name: "Diagnostic 127.0.0.1:8123", proxyUrl: "http://127.0.0.1:8123", type: "http", isActive: false }]);
  const pool = ranker.readState().pools["remote-created"];
  assert.equal(pool.remoteState, "linked");
  assert.equal(pool.isActiveOnRouter, true);
});
