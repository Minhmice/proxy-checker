import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  downloadProxyExport,
  removePool,
  renamePool,
  runDiagnostics,
  syncPools,
} from "../src/lib/api.js";
import type { PoolRecord } from "../src/lib/types.js";

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

test("syncPools sends POST with authentication headers and returns 202", async () => {
  const request = recordFetch({ started: true }, 202);
  const result = await syncPools("secret");
  assert.equal(request.url, "/api/ninerouter/sync");
  assert.equal(request.init.method, "POST");
  assert.equal((request.init.headers as Record<string, string>)["Authorization"], `Basic ${btoa("admin:secret")}`);
  assert.deepEqual(result, { started: true });
});

test("rename targets the encoded local identity", async () => {
  const rename = recordFetch(poolResponse);
  await renamePool("secret", "local/a", "  Edge Paris  ");
  assert.equal(rename.url, "/api/ninerouter/pools/local%2Fa");
  assert.equal(rename.init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(rename.init.body)), { name: "Edge Paris" });
});

test("removePool uses DELETE with the encoded local identity", async () => {
  const request = recordFetch(poolResponse);
  await removePool("secret", "local/a");
  assert.equal(request.url, "/api/ninerouter/pools/local%2Fa");
  assert.equal(request.init.method, "DELETE");
});

test("diagnostics sends exactly the selected scope", async () => {
  const request = recordFetch({ started: true }, 202);
  await runDiagnostics("secret", { file: "sample.txt", sampleCount: 25 });
  assert.deepEqual(JSON.parse(String(request.init.body)), { file: "sample.txt", sampleCount: 25 });
});

test("downloadProxyExport sends GET with auth headers and query params", async () => {
  const request = recordFetch("http://user:pass@1.1.1.1:8080");
  const result = await downloadProxyExport("secret", "txt", true);
  assert.equal(request.url, "/api/settings/proxy-export?format=txt&includeCredentials=true&confirmCredentials=yes");
  assert.equal((request.init.headers as Record<string, string>)["Authorization"], `Basic ${btoa("admin:secret")}`);
  assert.ok(result.blob);
});
