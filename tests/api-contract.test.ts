import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  removePool,
  renamePool,
  restorePool,
  runDiagnostics,
  testPools,
} from "../src/lib/api";
import type { PoolRecord } from "../src/lib/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function recordFetch(body: unknown, status = 200) {
  const request = { url: "", init: {} as RequestInit };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    request.url = String(input);
    request.init = init ?? {};
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return request;
}

const pool: PoolRecord = {
  localId: "local-1",
  remoteId: "remote-1",
  remoteState: "linked",
  testState: "idle",
  name: "Edge Paris",
  proxyUrl: "http://127.0.0.1:8080",
  type: "http",
  status: "usable",
  tier: "active",
  latency_ms: 42,
  exit_ip: "203.0.113.1",
  checked_at: 1,
  isActiveOnRouter: true,
  successes: 1,
  failures: 0,
};

const poolResponse = { pool };

test("testPools sends local ids to the lifecycle endpoint", async () => {
  const request = recordFetch({ accepted: ["local-1"], busy: [] });
  await testPools("secret", ["local-1"]);
  assert.equal(request.url, "/api/ninerouter/test");
  assert.equal(request.init.method, "POST");
  assert.deepEqual(JSON.parse(String(request.init.body)), { ids: ["local-1"] });
});

test("rename and restore target the encoded local identity", async () => {
  const rename = recordFetch(poolResponse);
  await renamePool("secret", "local/a", "  Edge Paris  ");
  assert.equal(rename.url, "/api/ninerouter/pools/local%2Fa");
  assert.equal(rename.init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(rename.init.body)), { name: "Edge Paris" });

  const restore = recordFetch(poolResponse);
  await restorePool("secret", "local/a");
  assert.equal(restore.url, "/api/ninerouter/pools/local%2Fa/restore");
  assert.equal(restore.init.method, "POST");
});

test("removePool uses DELETE with the encoded local identity", async () => {
  const request = recordFetch(poolResponse);
  await removePool("secret", "local/a");
  assert.equal(request.url, "/api/ninerouter/pools/local%2Fa");
  assert.equal(request.init.method, "DELETE");
});

test("diagnostics sends exactly the selected scope", async () => {
  const request = recordFetch({ started: true });
  await runDiagnostics("secret", { file: "sample.txt", sampleCount: 25 });
  assert.deepEqual(JSON.parse(String(request.init.body)), { file: "sample.txt", sampleCount: 25 });
});

test("lifecycle helpers propagate the server error text", async () => {
  recordFetch({ error: "Remote pool is busy" }, 409);
  await assert.rejects(testPools("secret", ["local-1"]), /Remote pool is busy/);
});
