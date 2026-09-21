import "../src/server/load-env.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CheckResult, PoolRecord } from "../src/lib/types.js";
import { initAppConfig } from "../src/server/app-config.js";
import { createPoolRanker } from "../src/server/pool-ranker.js";

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
    isActiveOnRouter: false,
    successes: 1,
    failures: 0,
  };
}

test("sync executes one-retry and remote delete on confirmed dead pool", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-lifecycle-"));
  const poolA = record("local-a", 8001);
  fs.writeFileSync(
    path.join(dataDir, "pool-state.json"),
    JSON.stringify({
      pools: { [poolA.localId]: poolA },
      lastSyncAt: null,
      stats: { total: 1, active: 0, reserve: 1, dead: 0 },
      lastError: "",
    })
  );

  let checkCalls = 0;
  const deletedRemotes: string[] = [];
  const ranker = createPoolRanker(
    { dataDir },
    {
      listPools: async () => [{ id: "remote-local-a", name: poolA.name, proxyUrl: poolA.proxyUrl, type: "http" }],
      deletePool: async (id) => {
        deletedRemotes.push(id);
      },
      bulkSetActive: async () => [],
      checkProxy: async () => {
        checkCalls++;
        return {
          endpoint: "127.0.0.1:8001",
          protocol: "http",
          status: "dead",
          exit_ip: null,
          latency_ms: 5,
          checked_at: Date.now(),
          successes: 0,
          failures: 1,
          last_error: `failure-${checkCalls}`,
        };
      },
    }
  );

  await ranker.syncPools();
  const state = ranker.readState();
  assert.equal(checkCalls, 2);
  assert.deepEqual(deletedRemotes, ["remote-local-a"]);
  assert.equal(state.pools["local-a"].remoteState, "removed");
  assert.equal(state.pools["local-a"].remoteId, null);
  assert.ok(state.pools["local-a"].checked_at > 0, "checked_at must be populated on failure");
  assert.equal(state.pools["local-a"].latency_ms, 5);
});