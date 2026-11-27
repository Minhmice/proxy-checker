import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startIsolatedServer } from "./helpers/isolated-server.js";
import { SESSION_COOKIE_NAME } from "../src/server/session-auth.js";

test("runtime server delegates api requests through Hono while preserving native routes", async () => {
  const app = await startIsolatedServer({
    mode: "production",
    mockApi: false,
  });
  try {
    const healthRes = await fetch(`${app.baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthData = await healthRes.json();
    assert.deepEqual(healthData, { ok: true });

    const unauthRes = await fetch(`${app.baseUrl}/api/settings`);
    assert.equal(unauthRes.status, 401);

    const loginRes = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: app.password }),
    });
    assert.equal(loginRes.status, 200);
    const setCookie = loginRes.headers.get("Set-Cookie");
    assert.ok(setCookie);
    assert.ok(setCookie.includes(SESSION_COOKIE_NAME));

    const tokenMatch = setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
    assert.ok(tokenMatch);
    const cookieHeader = `${SESSION_COOKIE_NAME}=${tokenMatch[1]}`;

    const settingsRes = await fetch(`${app.baseUrl}/api/settings`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(settingsRes.status, 200);
    const settingsData = (await settingsRes.json()) as {
      settings?: Record<string, unknown>;
    };
    assert.ok(settingsData.settings);

    const notFoundRes = await fetch(`${app.baseUrl}/api/non-existent-endpoint`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(notFoundRes.status, 404);
    const notFoundData = await notFoundRes.json();
    assert.deepEqual(notFoundData, { error: "not found" });
  } finally {
    await app.stop();
  }
});

test("oversized settings requests return 413 and leave server healthy", async () => {
  const app = await startIsolatedServer({ mode: "production", mockApi: false });
  try {
    const login = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: app.password }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);

    for (const path of ["/api/settings", "/api/settings/test-ninerouter"]) {
      for (const chunked of [false, true]) {
        const { promise, resolve, reject } = Promise.withResolvers<{
          status?: number;
          connection?: string;
        }>();
        const request = http.request(
          `${app.baseUrl}${path}`,
          {
            method: path === "/api/settings" ? "PUT" : "POST",
            headers: {
              Cookie: cookie,
              "Content-Type": "application/json",
              ...(chunked ? { "Transfer-Encoding": "chunked" } : { "Content-Length": 1_000_001 }),
            },
          },
          (response) => {
            response.resume();
            response.on("end", () =>
              resolve({ status: response.statusCode, connection: response.headers.connection }),
            );
          },
        );
        request.on("error", reject);
        request.end(Buffer.alloc(1_000_001, 0x20));
        const result = await promise;
        assert.equal(result.status, 413, `${path} chunked=${chunked}`);
        assert.equal(result.connection, "close");
        const health = await fetch(`${app.baseUrl}/api/health`);
        assert.equal(health.status, 200);
        assert.deepEqual(await health.json(), { ok: true });
      }
    }
  } finally {
    await app.stop();
  }
});
