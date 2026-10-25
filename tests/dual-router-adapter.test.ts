import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRouterAdapter } from "../src/server/dual-router/adapter.js";
import { clearNineRouterSession } from "../src/server/nine-router-client.js";
import { poolKey, accountKey } from "../src/server/dual-router/identity.js";
import type { Operation, UsageWrite } from "../src/server/dual-router/types.js";

interface MockServerContext {
  server: http.Server;
  url: string;
  requests: Array<{
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body?: unknown;
  }>;
}

async function startMockServer(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    context: { requests: MockServerContext["requests"]; body?: unknown },
  ) => void,
): Promise<MockServerContext> {
  const requests: MockServerContext["requests"] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let body: unknown;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      requests.push({
        method: req.method || "GET",
        url: req.url || "/",
        headers: req.headers,
        body,
      });
      handler(req, res, { requests, body });
    });
  });

  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => resolve());
  await promise;

  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;
  return { server, url, requests };
}

async function closeMockServer(ctx: MockServerContext): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  ctx.server.close(() => resolve());
  await promise;
}

test("capabilities: returns capabilities matching verified 9router capability report", async () => {
  const adapter = createRouterAdapter({
    routerId: "test-router",
    url: "http://127.0.0.1:12345",
  });
  const caps = await adapter.capabilities();

  const byResource = new Map(caps.map((c) => [c.resource, c]));
  assert.equal(byResource.get("pool")?.read, true);
  assert.equal(byResource.get("pool")?.write, true);
  assert.equal(byResource.get("account")?.read, true);
  assert.equal(byResource.get("account")?.write, true);
  assert.equal(byResource.get("usage")?.read, true);
  assert.equal(byResource.get("usage")?.write, false);
  assert.equal(byResource.get("role")?.read, false);
  assert.equal(byResource.get("settings")?.read, false);
  assert.equal(byResource.get("history")?.read, false);
});

test("readState: normalizes pools and accounts into entities with keys", async () => {
  const mock = await startMockServer((req, res) => {
    if (req.url === "/api/proxy-pools?includeUsage=true") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          proxyPools: [
            {
              id: "remote-p1",
              name: "Pool 1",
              proxyUrl: "http://10.0.0.1:8080",
              isActive: true,
              type: "http",
            },
          ],
        }),
      );
      return;
    }

    if (req.url?.startsWith("/api/providers/client")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          connections: [
            {
              id: "conn-1",
              provider: "antigravity",
              name: "User One",
              email: "UserOne@Gmail.Com",
              isActive: true,
              providerSpecificData: {
                proxyPoolId: "remote-p1",
              },
            },
          ],
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  try {
    const adapter = createRouterAdapter({
      routerId: "router-a",
      url: mock.url,
      apiKey: "test-key",
    });

    const snapshot = await adapter.readState();
    assert.equal(snapshot.routerId, "router-a");

    // Pools
    const poolScope = snapshot.scopes.pool;
    assert.equal(poolScope.complete, true);
    assert.equal(poolScope.entities.length, 1);
    assert.equal(poolScope.entities[0].localId, "remote-p1");
    assert.equal(poolScope.entities[0].key, poolKey("http://10.0.0.1:8080"));
    assert.equal(poolScope.entities[0].fields.name, "Pool 1");
    assert.equal(poolScope.entities[0].fields.isActive, true);

    // Accounts
    const accScope = snapshot.scopes.account;
    assert.equal(accScope.complete, true);
    assert.equal(accScope.entities.length, 1);
    assert.equal(accScope.entities[0].localId, "conn-1");
    assert.equal(accScope.entities[0].key, accountKey("antigravity", null, "userone@gmail.com"));
    assert.equal(accScope.entities[0].fields.isActive, true);
    assert.equal(accScope.entities[0].fields.proxyPoolId, "remote-p1");
  } finally {
    await closeMockServer(mock);
  }
});

test("apply: handles pool CRUD and returns appropriate receipts", async () => {
  const createdPoolId = "created-p1";
  const poolState = {
    id: "existing-p1",
    name: "Existing Pool",
    proxyUrl: "http://10.0.0.2:8080",
    isActive: false,
    type: "http",
  };
  let poolDeleted = false;

  const mock = await startMockServer((req, res, { body }) => {
    if (req.url === "/api/proxy-pools?includeUsage=true" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          proxyPools: poolDeleted ? [] : [poolState],
        }),
      );
      return;
    }

    if (req.url === "/api/proxy-pools" && req.method === "POST") {
      const payload = body as Record<string, unknown>;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          proxyPool: {
            id: createdPoolId,
            name: payload?.name,
            proxyUrl: payload?.proxyUrl,
            type: payload?.type,
          },
        }),
      );
      return;
    }

    if (req.url?.startsWith("/api/proxy-pools/") && req.method === "PUT") {
      const payload = body as Record<string, unknown>;
      if (payload?.name !== undefined) poolState.name = String(payload.name);
      if (payload?.isActive !== undefined) poolState.isActive = Boolean(payload.isActive);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ proxyPool: poolState }));
      return;
    }

    if (req.url?.startsWith("/api/proxy-pools/") && req.method === "DELETE") {
      poolDeleted = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  try {
    const adapter = createRouterAdapter({
      routerId: "router-a",
      url: mock.url,
      apiKey: "test-key",
    });

    // 1. Create pool
    const createOp: Operation = {
      id: "op-create-1",
      routerId: "router-a",
      resource: "pool",
      key: poolKey("http://10.0.0.99:8080"),
      field: null,
      kind: "create",
      expected: null,
      expectedRevision: null,
      desired: { name: "New Pool", proxyUrl: "http://10.0.0.99:8080", isActive: false },
      dependsOn: [],
    };
    const createReceipt = await adapter.apply(createOp);
    assert.equal(createReceipt.outcome, "applied");
    assert.equal(createReceipt.boundary, createdPoolId);

    // Verify readReceipt caches receipt
    const cachedReceipt = await adapter.readReceipt("op-create-1");
    assert.deepEqual(cachedReceipt, createReceipt);

    // 2. Update pool - success
    const updateOp: Operation = {
      id: "op-update-1",
      routerId: "router-a",
      resource: "pool",
      key: poolKey("http://10.0.0.2:8080"),
      field: "name",
      kind: "update",
      expected: "Existing Pool",
      expectedRevision: null,
      desired: "Renamed Pool",
      dependsOn: [],
    };
    const updateReceipt = await adapter.apply(updateOp);
    assert.equal(updateReceipt.outcome, "applied");
    assert.equal(poolState.name, "Renamed Pool");

    // 3. Update pool - conflict on expected value
    const conflictOp: Operation = {
      id: "op-update-conflict",
      routerId: "router-a",
      resource: "pool",
      key: poolKey("http://10.0.0.2:8080"),
      field: "name",
      kind: "update",
      expected: "Old Stale Name",
      expectedRevision: null,
      desired: "Won't Apply",
      dependsOn: [],
    };
    const conflictReceipt = await adapter.apply(conflictOp);
    assert.equal(conflictReceipt.outcome, "conflicted");

    // 4. Delete pool - success
    const deleteOp: Operation = {
      id: "op-delete-1",
      routerId: "router-a",
      resource: "pool",
      key: poolKey("http://10.0.0.2:8080"),
      field: null,
      kind: "delete",
      expected: null,
      expectedRevision: null,
      desired: null,
      dependsOn: [],
    };
    const deleteReceipt = await adapter.apply(deleteOp);
    assert.equal(deleteReceipt.outcome, "applied");
    assert.equal(poolDeleted, true);
  } finally {
    await closeMockServer(mock);
  }
});

test("auth isolation: cookie sessions do not leak across distinct adapter URLs", async () => {
  clearNineRouterSession();

  let server1AuthHeader: string | undefined;
  let server2AuthHeader: string | undefined;

  const mock1 = await startMockServer((req, res) => {
    if (req.url === "/api/auth/login") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": "auth_token=token-for-router1; Path=/",
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url?.startsWith("/api/proxy-pools")) {
      server1AuthHeader = req.headers.cookie;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ proxyPools: [] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const mock2 = await startMockServer((req, res) => {
    if (req.url === "/api/auth/login") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": "auth_token=token-for-router2; Path=/",
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url?.startsWith("/api/proxy-pools")) {
      server2AuthHeader = req.headers.cookie;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ proxyPools: [] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    const adapter1 = createRouterAdapter({
      routerId: "router-1",
      url: mock1.url,
      password: "pass1",
    });

    const adapter2 = createRouterAdapter({
      routerId: "router-2",
      url: mock2.url,
      password: "pass2",
    });

    await adapter1.readState();
    await adapter2.readState();

    assert.equal(server1AuthHeader, "auth_token=token-for-router1");
    assert.equal(server2AuthHeader, "auth_token=token-for-router2");
  } finally {
    await closeMockServer(mock1);
    await closeMockServer(mock2);
  }
});

test("usage: readUsage retrieves quotas and writeUsage returns unsupported", async () => {
  const mock = await startMockServer((req, res) => {
    if (req.url?.startsWith("/api/providers/client")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          connections: [
            {
              id: "conn-usage-1",
              provider: "antigravity",
              email: "test@example.com",
            },
          ],
        }),
      );
      return;
    }

    if (req.url?.startsWith("/api/usage/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          quotas: {
            gemini_session: {
              remainingPercentage: 85,
              used: 15,
              resetAt: "2026-10-23T15:00:00Z",
            },
          },
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  try {
    const adapter = createRouterAdapter({
      routerId: "router-usage",
      url: mock.url,
      apiKey: "test-key",
    });

    const events = await adapter.readUsage();
    assert.equal(events.length, 1);
    assert.equal(events[0].amount, "85");
    assert.equal(events[0].scope.metric, "gemini_session");
    assert.equal(events[0].generation, "2026-10-23T15:00:00Z");

    const write: UsageWrite = {
      operationId: "write-op-1",
      routerId: "router-usage",
      scope: events[0].scope,
      ledgerRevision: 1,
      strategy: "absolute",
      amount: "80",
      expectedBoundary: "100",
    };

    const receipt = await adapter.writeUsage(write);
    assert.equal(receipt.outcome, "unsupported");
  } finally {
    await closeMockServer(mock);
  }
});

test("apply: handles account updates and rejects create/delete as unsupported", async () => {
  const connState = {
    id: "conn-acc-1",
    provider: "antigravity",
    email: "user@example.com",
    isActive: true,
    providerSpecificData: {
      proxyPoolId: "pool-old",
    },
  };

  const mock = await startMockServer((req, res, { body }) => {
    if (req.url?.startsWith("/api/providers/client") && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ connections: [connState] }));
      return;
    }

    if (req.url?.startsWith("/api/providers/") && req.method === "PUT") {
      const payload = body as Record<string, unknown>;
      if (payload?.isActive !== undefined) connState.isActive = Boolean(payload.isActive);
      if (payload?.providerSpecificData !== undefined) {
        connState.providerSpecificData = payload.providerSpecificData as { proxyPoolId: string };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ connection: connState }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  try {
    const adapter = createRouterAdapter({
      routerId: "router-acc",
      url: mock.url,
      apiKey: "test-key",
    });

    const accKey = accountKey("antigravity", null, "user@example.com");

    // 1. Account create should be unsupported
    const createReceipt = await adapter.apply({
      id: "acc-create-1",
      routerId: "router-acc",
      resource: "account",
      key: accKey,
      field: null,
      kind: "create",
      expected: null,
      expectedRevision: null,
      desired: { isActive: true },
      dependsOn: [],
    });
    assert.equal(createReceipt.outcome, "unsupported");

    // 2. Account delete should be unsupported
    const deleteReceipt = await adapter.apply({
      id: "acc-delete-1",
      routerId: "router-acc",
      resource: "account",
      key: accKey,
      field: null,
      kind: "delete",
      expected: null,
      expectedRevision: null,
      desired: null,
      dependsOn: [],
    });
    assert.equal(deleteReceipt.outcome, "unsupported");

    // 3. Account update isActive - success
    const updateActiveReceipt = await adapter.apply({
      id: "acc-update-active",
      routerId: "router-acc",
      resource: "account",
      key: accKey,
      field: "isActive",
      kind: "update",
      expected: true,
      expectedRevision: null,
      desired: false,
      dependsOn: [],
    });
    assert.equal(updateActiveReceipt.outcome, "applied");
    assert.equal(connState.isActive, false);

    // 4. Account update proxyPoolId - success
    const updateProxyReceipt = await adapter.apply({
      id: "acc-update-proxy",
      routerId: "router-acc",
      resource: "account",
      key: accKey,
      field: "proxyPoolId",
      kind: "update",
      expected: "pool-old",
      expectedRevision: null,
      desired: "pool-new",
      dependsOn: [],
    });
    assert.equal(updateProxyReceipt.outcome, "applied");
    assert.equal(connState.providerSpecificData.proxyPoolId, "pool-new");

    // 5. Account update expected mismatch - conflicted
    const conflictReceipt = await adapter.apply({
      id: "acc-update-conflict",
      routerId: "router-acc",
      resource: "account",
      key: accKey,
      field: "proxyPoolId",
      kind: "update",
      expected: "pool-stale",
      expectedRevision: null,
      desired: "pool-different",
      dependsOn: [],
    });
    assert.equal(conflictReceipt.outcome, "conflicted");
  } finally {
    await closeMockServer(mock);
  }
});

test("apply: returns unsupported for role, settings, and history resources", async () => {
  const adapter = createRouterAdapter({
    routerId: "router-unsupported",
    url: "http://127.0.0.1:12345",
  });

  for (const resource of ["role", "settings", "history"] as const) {
    const receipt = await adapter.apply({
      id: `op-${resource}`,
      routerId: "router-unsupported",
      resource,
      key: "key-1",
      field: "foo",
      kind: "update",
      expected: "a",
      expectedRevision: null,
      desired: "b",
      dependsOn: [],
    });
    assert.equal(receipt.outcome, "unsupported");
  }
});
