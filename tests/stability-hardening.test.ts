import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireDataLease, LEASE_STALE_MS } from "../src/db/common/maintenance-lease.js";
import { createAntigravityRotator } from "../src/server/antigravity-rotator.js";
import type { AppSettings } from "../src/server/app-config.js";
import {
  clearNineRouterSession,
  listPools,
  updateConnection,
} from "../src/server/nine-router-client.js";

const settings = () =>
  ({
    antigravityRotatorEnabled: true,
    antigravityActiveLimit: 3,
    antigravitySessionThreshold: 20,
  }) as unknown as AppSettings;

function rotatorWith(repairStatus: "repaired" | "no_candidate") {
  const swaps: string[] = [];
  const repairs: string[] = [];
  // Fake router state: a successful repair rebinds the account and clears the error.
  const conn = {
    id: "bad",
    provider: "antigravity",
    isActive: false,
    lastError: "403 Forbidden" as string | null,
    providerSpecificData: { proxyPoolId: "P1" },
  };
  const rotator = createAntigravityRotator({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "rot-")),
    getRouterUrls: () => ["http://node1:9999"],
    getUsableProxies: () => [{ remoteId: "P1" }, { remoteId: "P2" }],
    listConnections: async () => [{ ...conn }],
    updateConnection: async (id, patch) => {
      if (patch.providerSpecificData?.proxyPoolId) swaps.push(id);
      return { connection: {} };
    },
    getUsage: async () => ({ sessionPercentage: 80, quotaAvailable: true }),
    getSettings: settings,
    repairRoute: async (accountId) => {
      repairs.push(accountId);
      if (repairStatus !== "repaired") return { status: "no_candidate" };
      conn.providerSpecificData = { proxyPoolId: "P2" };
      conn.lastError = null;
      const binding = { accountId, revision: 2, poolId: "P2", isActive: false };
      return { status: "repaired", binding };
    },
  });
  return { rotator, swaps, repairs };
}

test("resetProxies repairs forbidden route first and skips swap when repaired", async () => {
  const { rotator, swaps, repairs } = rotatorWith("repaired");
  const res = await rotator.resetProxies();
  assert.deepEqual(repairs, ["bad"]);
  assert.equal(res.repairedCount, 1);
  assert.deepEqual(swaps, []);
});

test("resetProxies falls back to swap only when repair cannot fix route", async () => {
  const { rotator, swaps, repairs } = rotatorWith("no_candidate");
  const res = await rotator.resetProxies();
  assert.deepEqual(repairs, ["bad"]);
  assert.equal(res.repairedCount, 0);
  assert.ok(swaps.includes("bad"));
});

test("9Router GET retries once on 502; mutations never replay", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  clearNineRouterSession();
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/auth/login")) {
      return new Response("{}", { status: 200, headers: { "set-cookie": "auth_token=t; Path=/" } });
    }
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (calls.length === 1 || url.includes("/connections")) {
      return new Response("bad gateway", { status: 502 });
    }
    return new Response(JSON.stringify({ proxyPools: [] }), { status: 200 });
  }) as typeof fetch;

  const pools = await listPools({ url: "http://pi:1", timeoutMs: 2000 });
  assert.deepEqual(pools, []);
  assert.equal(calls.filter((c) => c.startsWith("GET")).length, 2);

  calls.length = 0;
  await assert.rejects(updateConnection("x", { isActive: true }, { url: "http://pi:1" }));
  assert.equal(calls.length, 1);
});

test("lease left by crashed owner is reclaimed even if PID now belongs to a live node process", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lease-reuse-"));
  try {
    const owner = path.join(dir, ".proxy-checker.lease", "owner");
    fs.mkdirSync(path.dirname(owner));
    // Current PID is a live node process: simulates OS reusing the dead owner's PID.
    fs.writeFileSync(owner, `application\n${process.ppid}\n`);
    const old = new Date(Date.now() - LEASE_STALE_MS - 1000);
    fs.utimesSync(owner, old, old);
    const release = acquireDataLease(dir, "application");
    release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lease with fresh heartbeat from live owner still blocks a second instance", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lease-live-"));
  try {
    const owner = path.join(dir, ".proxy-checker.lease", "owner");
    fs.mkdirSync(path.dirname(owner));
    fs.writeFileSync(owner, `application\n${process.ppid}\n`);
    assert.throws(() => acquireDataLease(dir, "application"), /locked/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
