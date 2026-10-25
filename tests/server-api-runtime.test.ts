import test from "node:test";
import assert from "node:assert/strict";
import { startIsolatedServer } from "./helpers/isolated-server.js";
import { SESSION_COOKIE_NAME } from "../src/server/session-auth.js";

test("runtime server delegates api requests through Hono while preserving native routes", async () => {
  const app = await startIsolatedServer({
    mode: "production",
    mockApi: false,
  });
  try {
    // 1. Health endpoint via Hono
    const healthRes = await fetch(`${app.baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthData = await healthRes.json();
    assert.deepEqual(healthData, { ok: true });

    // 2. Native installer route
    const installRes = await fetch(`${app.baseUrl}/install-agent.sh`);
    assert.equal(installRes.status, 200);
    assert.ok((await installRes.text()).includes("curl"));

    // 3. Unauthenticated protected API rejects with 401
    const unauthRes = await fetch(`${app.baseUrl}/api/settings`);
    assert.equal(unauthRes.status, 401);

    // 4. Login through Hono API
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

    // 5. Authenticated access to settings
    const settingsRes = await fetch(`${app.baseUrl}/api/settings`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(settingsRes.status, 200);
    const settingsData = (await settingsRes.json()) as {
      settings?: Record<string, unknown>;
    };
    assert.ok(settingsData.settings);

    // 6. Unknown API endpoint returns 404
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
