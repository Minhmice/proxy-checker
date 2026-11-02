import test from "node:test";
import assert from "node:assert/strict";
import { createApiApp } from "../src/server/api/app.js";
import type { ApiDependencies } from "../src/server/api/types.js";

function createMockDeps(): ApiDependencies {
  return {
    verifyControlPassword: () => true,
    proxyIntelligenceRepo: {} as unknown as ApiDependencies["proxyIntelligenceRepo"],
    poolRanker: {} as unknown as ApiDependencies["poolRanker"],
    antigravityRotator: {} as unknown as ApiDependencies["antigravityRotator"],
    unifiedSyncCoordinator: {} as unknown as ApiDependencies["unifiedSyncCoordinator"],
    handleProxyCheck: async () => false,
    router: {} as unknown as ApiDependencies["router"],
    settings: {} as unknown as ApiDependencies["settings"],
    legacyHandlers: {
      handleNineRouter: async () => {},
      handleAntigravity: async () => {},
      handleSettings: async () => {},
      handleIntelligence: async () => {},
      handleProxiesUnified: async () => {},
    },
  };
}

test("bind-pool contract: separate account activation from poolId binding", async (t) => {
  const originalFetch = globalThis.fetch;
  let latestRequestBody: Record<string, unknown> = {};
  let requestCount = 0;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(input);
    if (urlStr.includes("/api/auth/login")) {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Set-Cookie": "auth_token=mock-token; Path=/" },
      });
    }

    const parsed = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    latestRequestBody = parsed;
    requestCount++;
    return new Response(JSON.stringify({ connection: { id: "conn-1", ...parsed } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const app = createApiApp(createMockDeps());

  // Test 1: Binding pool only
  requestCount = 0;
  const resPool = await app.request(
    "/api/ninerouter/nodes/server-lan/connections/conn-1/bind-pool?password=test",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ poolId: "pool-alpha" }),
    },
  );
  assert.equal(resPool.status, 200);
  assert.equal(requestCount, 1);
  const body1 = { ...latestRequestBody };
  assert.deepEqual(body1, {
    providerSpecificData: { proxyPoolId: "pool-alpha" },
  });
  assert.equal(Object.hasOwn(body1, "isActive"), false);

  // Test 2: Toggling isActive only (must NOT touch proxyPoolId or set it to null)
  requestCount = 0;
  const resActive = await app.request(
    "/api/ninerouter/nodes/server-lan/connections/conn-1/bind-pool?password=test",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: false }),
    },
  );
  assert.equal(resActive.status, 200);
  assert.equal(requestCount, 1);
  const body2 = { ...latestRequestBody };
  assert.equal(body2["isActive"], false);
  assert.equal(
    Object.hasOwn(body2, "providerSpecificData"),
    false,
    "isActive update must NOT include providerSpecificData",
  );

  // Test 3: Unbinding pool explicitly
  requestCount = 0;
  const resUnbind = await app.request(
    "/api/ninerouter/nodes/server-lan/connections/conn-1/bind-pool?password=test",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ poolId: null }),
    },
  );
  assert.equal(resUnbind.status, 200);
  assert.equal(requestCount, 1);
  const body3 = { ...latestRequestBody };
  assert.deepEqual(body3, {
    providerSpecificData: { proxyPoolId: null },
  });
  assert.equal(Object.hasOwn(body3, "isActive"), false);

  // Test 4: Missing both poolId and isActive returns 400
  const resEmpty = await app.request(
    "/api/ninerouter/nodes/server-lan/connections/conn-1/bind-pool?password=test",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ randomField: 123 }),
    },
  );
  assert.equal(resEmpty.status, 400);
});
