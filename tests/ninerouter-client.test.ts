import test from "node:test";
import assert from "node:assert/strict";
import { listPools, testPool, clearNineRouterSession } from "../src/server/nine-router-client.js";

const originalFetch = globalThis.fetch;

test("listPools preserves remote metadata and testPool parses structured error on HTTP 500", async () => {
  clearNineRouterSession();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/auth/login")) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": "auth_token=mock-token; Path=/" },
      });
    }
    if (url.endsWith("/api/proxy-pools?includeUsage=true")) {
      return new Response(
        JSON.stringify({
          proxyPools: [
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
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.includes("/api/proxy-pools/remote-1/test")) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Proxy test timed out",
          elapsedMs: 6000,
        }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const pools = await listPools();
    assert.equal(pools.length, 1);
    assert.equal(pools[0].id, "remote-1");
    assert.equal(pools[0].isActive, false);
    assert.equal(pools[0].testStatus, "failed");
    assert.equal(pools[0].lastError, "timeout");
    assert.equal(pools[0].lastTestedAt, "2026-09-24T09:00:00.000Z");

    const testRes = await testPool("remote-1");
    assert.deepEqual(testRes, {
      ok: false,
      error: "Proxy test timed out",
      elapsedMs: 6000,
    });
  } finally {
    globalThis.fetch = originalFetch;
    clearNineRouterSession();
  }
});
