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

test("account discovery filters every Codex pagination request by provider", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ page: number; provider: string | null }> = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get("page") ?? 1);
    requests.push({ page, provider: url.searchParams.get("provider") });
    return Response.json({
      connections: [{ id: `codex-${page}`, provider: "codex", isActive: false }],
      pagination: { page, total: 2, totalPages: 2 },
    });
  }) as typeof fetch;
  try {
    const accounts = await listAntigravityConnections({
      url: "https://router.example",
      apiKey: "test-api-key",
      provider: "codex",
    });
    assert.deepEqual(
      accounts.map((account) => account.id),
      ["codex-1", "codex-2"],
    );
    assert.deepEqual(requests, [
      { page: 1, provider: "codex" },
      { page: 2, provider: "codex" },
    ]);
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

test("request clears its timeout only after the response body is read", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let timer: NodeJS.Timeout | undefined;
  let cleared = false;
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    const handle = originalSetTimeout(callback, ms, ...args);
    if (ms === 60_000) timer = handle;
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: NodeJS.Timeout) => {
    if (handle === timer) cleared = true;
    originalClearTimeout(handle);
  }) as typeof clearTimeout;
  globalThis.fetch = (async () => {
    const response = Response.json({ percentage: 42 });
    const text = response.text.bind(response);
    response.text = async () => {
      assert.equal(cleared, false);
      return text();
    };
    return response;
  }) as typeof fetch;
  try {
    assert.deepEqual(
      await getAccountUsage("one", {
        url: "https://router.example",
        apiKey: "test-api-key",
        timeoutMs: 60_000,
      }),
      { percentage: 42 },
    );
    assert.ok(timer);
    assert.equal(cleared, true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    clearNineRouterSession();
  }
});

test("clearing a session prevents old logins from replacing or disrupting new sessions", async () => {
  const originalFetch = globalThis.fetch;
  const overrides = { url: "https://router.example", password: "password" };
  const logins: Array<(response: Response) => void> = [];
  const cookies: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/api/auth/login")) {
      const { promise, resolve } = Promise.withResolvers<Response>();
      logins.push(resolve);
      return promise;
    }
    cookies.push((init!.headers as Record<string, string>).Cookie);
    return Response.json({});
  }) as typeof fetch;
  const loginResponse = (token: string) =>
    new Response("{}", { headers: { "set-cookie": `auth_token=${token}; Path=/` } });
  try {
    clearNineRouterSession();
    const old = getAccountUsage("old", overrides);
    clearNineRouterSession(`${overrides.url}/`);
    const fresh = getAccountUsage("fresh", overrides);
    assert.equal(logins.length, 2);
    logins[0](loginResponse("old"));
    await old;
    const joined = getAccountUsage("joined", overrides);
    assert.equal(logins.length, 2);
    logins[1](loginResponse("fresh"));
    await Promise.all([fresh, joined]);
    await getAccountUsage("cached", overrides);
    assert.deepEqual(cookies, [
      "auth_token=old",
      "auth_token=fresh",
      "auth_token=fresh",
      "auth_token=fresh",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    clearNineRouterSession();
  }
});

test("clearing a session prevents stale request completion and 401 from changing its replacement", async () => {
  for (const staleStatus of [200, 401]) {
    const originalFetch = globalThis.fetch;
    const overrides = { url: "https://router.example", password: "password" };
    let loginCount = 0;
    const oldResponse = Promise.withResolvers<Response>();
    const oldStarted = Promise.withResolvers<void>();
    const cookies: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/auth/login")) {
        loginCount++;
        return new Response("{}", {
          headers: { "set-cookie": `auth_token=${loginCount}; Path=/` },
        });
      }
      cookies.push((init!.headers as Record<string, string>).Cookie);
      if (url.endsWith("/api/usage/old")) {
        oldStarted.resolve();
        return oldResponse.promise;
      }
      return Response.json({});
    }) as typeof fetch;
    try {
      clearNineRouterSession();
      const old = getAccountUsage("old", overrides);
      await oldStarted.promise;
      clearNineRouterSession(overrides.url);
      await getAccountUsage("fresh", overrides);
      oldResponse.resolve(new Response("{}", { status: staleStatus }));
      if (staleStatus === 401) await assert.rejects(old);
      else await old;
      await getAccountUsage("cached", overrides);
      assert.equal(loginCount, 2);
      assert.equal(cookies.at(-1), "auth_token=2");
    } finally {
      globalThis.fetch = originalFetch;
      clearNineRouterSession();
    }
  }
});
