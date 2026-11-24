import test from "node:test";
import assert from "node:assert/strict";
import {
  clearNineRouterSession,
  getAccountUsage,
  listAntigravityConnections,
  testNineRouterConnection,
  updateConnection,
} from "../src/server/nine-router-client.js";

test("router connection test and account operations use account endpoints", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const overrides = { url: "https://router.example", apiKey: "test-api-key" };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes("/api/providers/client?")) {
      return Response.json({
        connections: [{ id: "account-1", provider: "antigravity", isActive: true }],
      });
    }
    if (url.endsWith("/api/usage/account-1")) return Response.json({ percentage: 42 });
    if (url.endsWith("/api/providers/account-1"))
      return Response.json({ connection: { id: "account-1" } });
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as typeof fetch;
  try {
    const result = await testNineRouterConnection(overrides);
    assert.equal(result.ok, true);
    assert.equal(result.accountCount, 1);
    assert.equal((await listAntigravityConnections(overrides))[0].id, "account-1");
    assert.deepEqual(await getAccountUsage("account-1", overrides), { percentage: 42 });
    await updateConnection("account-1", { isActive: false }, overrides);
    assert.deepEqual(
      requests.map(({ url, method }) => [method, new URL(url).pathname]),
      [
        ["GET", "/api/providers/client"],
        ["GET", "/api/providers/client"],
        ["GET", "/api/usage/account-1"],
        ["PUT", "/api/providers/account-1"],
      ],
    );
    assert.deepEqual(requests[3].body, { isActive: false });
  } finally {
    globalThis.fetch = originalFetch;
    clearNineRouterSession();
  }
});

test("account discovery reads all pages and propagates later page errors", async () => {
  const originalFetch = globalThis.fetch;
  let failSecondPage = false;
  const pages: number[] = [];
  const overrides = { url: "https://router.example", apiKey: "test-api-key", pageSize: 2 };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get("page") ?? 1);
    pages.push(page);
    if (page === 2 && failSecondPage)
      return Response.json({ error: "unavailable" }, { status: 500 });
    return Response.json({
      connections:
        page === 1
          ? [
              { id: "one", provider: "antigravity" },
              { id: "two", provider: "antigravity" },
            ]
          : [{ id: "three", provider: "antigravity" }],
      pagination: { page, pageSize: 2, total: 3, totalPages: 2 },
    });
  }) as typeof fetch;
  try {
    assert.deepEqual(
      (await listAntigravityConnections(overrides)).map((a) => a.id),
      ["one", "two", "three"],
    );
    assert.deepEqual(pages, [1, 2]);
    pages.length = 0;
    assert.deepEqual(
      (await listAntigravityConnections({ ...overrides, page: 2 })).map((a) => a.id),
      ["three"],
    );
    assert.deepEqual(pages, [2]);
    failSecondPage = true;
    await assert.rejects(listAntigravityConnections(overrides), /unavailable/);
  } finally {
    globalThis.fetch = originalFetch;
    clearNineRouterSession();
  }
});

test("account discovery accepts empty zero-page responses but rejects inconsistent pagination", async () => {
  const originalFetch = globalThis.fetch;
  const overrides = { url: "https://router.example", apiKey: "test-api-key" };
  let response: unknown = {
    connections: [],
    pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 },
  };
  globalThis.fetch = (async () => Response.json(response)) as typeof fetch;
  try {
    assert.deepEqual(await listAntigravityConnections(overrides), []);
    assert.deepEqual(await listAntigravityConnections({ ...overrides, page: 1 }), []);
    const connectionTest = await testNineRouterConnection(overrides);
    assert.equal(connectionTest.ok, true);
    assert.equal(connectionTest.accountCount, 0);

    response = {
      connections: [{ id: "one", provider: "antigravity" }],
      pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 },
    };
    await assert.rejects(listAntigravityConnections(overrides), /Invalid 9Router pagination/);
    response = {
      connections: [],
      pagination: { page: 1, pageSize: 50, total: 1, totalPages: 0 },
    };
    await assert.rejects(listAntigravityConnections(overrides), /Invalid 9Router pagination/);
    response = {
      connections: [],
      pagination: { page: 2, pageSize: 50, total: 0, totalPages: 0 },
    };
    await assert.rejects(
      listAntigravityConnections({ ...overrides, page: 2 }),
      /Invalid 9Router pagination/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    clearNineRouterSession();
  }
});

test("router connection test isolates failed endpoints", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).startsWith("https://down.example")) {
      return Response.json({ error: "offline" }, { status: 500 });
    }
    return Response.json({ connections: [{ id: "account-1", provider: "antigravity" }] });
  }) as typeof fetch;
  try {
    const result = await testNineRouterConnection({
      url: "https://up.example, https://down.example",
      apiKey: "test-api-key",
    });
    assert.equal(result.ok, true);
    assert.equal(result.partial, true);
    assert.equal(result.accountCount, 1);
    assert.deepEqual(
      result.endpoints?.map(({ ok }) => ok),
      [true, false],
    );
  } finally {
    globalThis.fetch = originalFetch;
    clearNineRouterSession();
  }
});
