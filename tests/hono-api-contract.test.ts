import test from "node:test";
import http from "node:http";
import { getRequestListener } from "@hono/node-server";
import assert from "node:assert/strict";
import { createApiApp } from "../src/server/api/app.js";
import type { ApiDependencies } from "../src/server/api/types.js";
import { SESSION_COOKIE_NAME } from "../src/server/session-auth.js";

function createMockDeps(): ApiDependencies {
  return {
    verifyControlPassword: (candidate) => candidate === "test-control-pass-123",
    antigravityRotator: {} as unknown as ApiDependencies["antigravityRotator"],
    unifiedSyncCoordinator: {} as unknown as ApiDependencies["unifiedSyncCoordinator"],
    router: {} as unknown as ApiDependencies["router"],
    settings: {} as unknown as ApiDependencies["settings"],
    legacyHandlers: {
      handleNineRouter: async () => {},
      handleAntigravity: async () => {},
      handleSettings: async (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ settings: { autoSync: true } }));
      },
    },
  };
}

test("hono contract: health check returns ok: true", async () => {
  const app = createApiApp(createMockDeps());
  const res = await app.request("/api/health");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data, { ok: true });
});

test("hono contract: session endpoint returns unauthenticated by default", async () => {
  const app = createApiApp(createMockDeps());
  const res = await app.request("/api/auth/session");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data, { authenticated: false });
});

test("hono contract: login rejects invalid password with 401", async () => {
  const app = createApiApp(createMockDeps());
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "wrong-password" }),
  });
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.deepEqual(data, { error: "Invalid control password" });
});

test("hono contract: login succeeds with valid password and issues session cookie", async () => {
  const app = createApiApp(createMockDeps());
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "test-control-pass-123" }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as {
    authenticated: boolean;
    expiresAt: number;
  };
  assert.equal(data.authenticated, true);
  assert.equal(typeof data.expiresAt, "number");

  const setCookie = res.headers.get("Set-Cookie");
  assert.ok(setCookie);
  assert.ok(setCookie.includes(SESSION_COOKIE_NAME));

  // Extract session token and verify authenticated session
  const tokenMatch = setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  assert.ok(tokenMatch);
  const cookieValue = `${SESSION_COOKIE_NAME}=${tokenMatch[1]}`;

  const sessionRes = await app.request("/api/auth/session", {
    headers: { Cookie: cookieValue },
  });
  assert.equal(sessionRes.status, 200);
  const sessionData = await sessionRes.json();
  assert.deepEqual(sessionData, { authenticated: true });

  // Logout clears session
  const logoutRes = await app.request("/api/auth/logout", {
    method: "POST",
    headers: { Cookie: cookieValue },
  });
  assert.equal(logoutRes.status, 200);
  const logoutData = await logoutRes.json();
  assert.deepEqual(logoutData, { authenticated: false });
});

test("hono contract: protected routes reject unauthenticated requests with 401", async () => {
  const app = createApiApp(createMockDeps());
  const res = await app.request("/api/settings");
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.deepEqual(data, { error: "Unauthorized" });
});

test("hono contract: unknown api route returns 404 not found", async () => {
  const app = createApiApp(createMockDeps());
  const res = await app.request("/api/non-existent-route?password=test-control-pass-123");
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.deepEqual(data, { error: "not found" });
});

test("removed proxy routes return 404 without invoking proxy handlers", async () => {
  const deps = createMockDeps();
  let calls = 0;
  deps.legacyHandlers.handleNineRouter = async (_req, res) => {
    calls++;
    res.writeHead(404);
    res.end();
  };
  deps.legacyHandlers.handleAntigravity = async (_req, res) => {
    calls++;
    res.writeHead(404);
    res.end();
  };
  deps.legacyHandlers.handleSettings = async (_req, res) => {
    calls++;
    res.writeHead(404);
    res.end();
  };
  const app = createApiApp(deps);
  const server = http.createServer(getRequestListener(app.fetch));
  const { promise: listening, resolve: listeningResolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listeningResolve);
  await listening;
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  try {
    for (const [method, route] of [
      ["POST", "/api/antigravity/reset-proxies"],
      ["POST", "/api/antigravity/repair-route"],
      ["POST", "/api/antigravity/ownership/reserve"],
      ["POST", "/api/antigravity/optimize-by-speed"],
      ["GET", "/api/ninerouter/nodes/node/proxy-pools"],
      ["PUT", "/api/ninerouter/nodes/node/connections/account/bind-pool"],
      ["GET", "/api/settings/proxy-export"],
      ["GET", "/api/proxies/unified"],
      ["GET", "/api/intelligence/proxies"],
    ]) {
      const response = await fetch(
        `http://127.0.0.1:${port}${route}?password=test-control-pass-123`,
        { method },
      );
      assert.equal(response.status, 404, `${method} ${route}`);
    }
    assert.equal(calls, 7);
  } finally {
    const { promise: closed, resolve, reject } = Promise.withResolvers<void>();
    server.close((error) => (error ? reject(error) : resolve()));
    await closed;
  }
});

test("node account routes preserve account reads and update only active state", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/api/auth/login")) {
      return Response.json({ ok: true }, { headers: { "set-cookie": "auth_token=test; Path=/" } });
    }
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json({ connections: [{ id: "account-1", provider: "antigravity" }] });
  }) as typeof fetch;
  try {
    const app = createApiApp(createMockDeps());
    const base = "/api/ninerouter/nodes/server-lan/connections";
    const list = await app.request(`${base}?password=test-control-pass-123`);
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), {
      connections: [{ id: "account-1", provider: "antigravity" }],
    });
    const update = await app.request(`${base}/account-1?password=test-control-pass-123`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isActive: false, poolId: "ignored" }),
    });
    assert.equal(update.status, 200);
    assert.equal(requests[1].method, "PUT");
    assert.equal(new URL(requests[1].url).pathname, "/api/providers/account-1");
    assert.deepEqual(requests[1].body, { isActive: false });
    const invalid = await app.request(`${base}/account-1?password=test-control-pass-123`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ poolId: "ignored" }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(requests.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hono contract: login rejects payload exceeding 10 KB with 413", async () => {
  const app = createApiApp(createMockDeps());
  const oversizedPassword = "a".repeat(11_000);
  const body = JSON.stringify({ password: oversizedPassword });
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
    },
    body,
  });
  assert.equal(res.status, 413);
  const data = await res.json();
  assert.deepEqual(data, { error: "Payload too large" });
});

test("hono contract: getRequestListener handles legacy handlers writing directly to outgoing response", async () => {
  const deps = createMockDeps();
  deps.legacyHandlers.handleNineRouter = async (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ninerouterStatus: "ok" }));
  };
  deps.legacyHandlers.handleSettings = async (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ settings: { ok: true } }));
  };

  const app = createApiApp(deps);
  const listener = getRequestListener(app.fetch);
  const server = http.createServer((req, res) => {
    listener(req, res);
  });

  const { promise: listenPromise, resolve: listenResolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listenResolve());
  await listenPromise;
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const resStatus = await fetch(
      `${baseUrl}/api/ninerouter/status?password=test-control-pass-123`,
    );
    assert.equal(resStatus.status, 200);
    const statusData = await resStatus.json();
    assert.deepEqual(statusData, { ninerouterStatus: "ok" });

    const resSettings = await fetch(`${baseUrl}/api/settings?password=test-control-pass-123`);
    assert.equal(resSettings.status, 200);
    const settingsData = await resSettings.json();
    assert.deepEqual(settingsData, { settings: { ok: true } });
  } finally {
    const { promise: closePromise, resolve: closeResolve } = Promise.withResolvers<void>();
    server.close(() => closeResolve());
    await closePromise;
  }
});
