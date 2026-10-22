import test from "node:test";
import assert from "node:assert/strict";
import { server } from "../../src/mocks/node.js";
import { http, HttpResponse } from "msw";

test("msw node contract: intercepts handled requests with fixtures", async () => {
  server.listen({ onUnhandledFrame: "error" });

  try {
    // 1. Health
    const healthRes = await fetch("http://localhost/api/health");
    assert.equal(healthRes.status, 200);
    const healthData = await healthRes.json();
    assert.deepEqual(healthData, { ok: true });

    // 2. Auth session
    const sessionRes = await fetch("http://localhost/api/auth/session");
    assert.equal(sessionRes.status, 200);
    const sessionData = await sessionRes.json();
    assert.deepEqual(sessionData, { authenticated: true });

    // 3. Login failure
    const loginFailRes = await fetch("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong-password" }),
    });
    assert.equal(loginFailRes.status, 401);

    // 4. Login success
    const loginSuccessRes = await fetch("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "correct-password" }),
    });
    assert.equal(loginSuccessRes.status, 200);
    const loginData = (await loginSuccessRes.json()) as { authenticated: boolean };
    assert.equal(loginData.authenticated, true);

    // 5. 9Router status
    const nrRes = await fetch("http://localhost/api/ninerouter/status");
    assert.equal(nrRes.status, 200);
    const nrData = (await nrRes.json()) as { status: string };
    assert.equal(nrData.status, "connected");

    // 6. Settings
    const settingsRes = await fetch("http://localhost/api/settings");
    assert.equal(settingsRes.status, 200);
    const settingsData = (await settingsRes.json()) as { settings: Record<string, unknown> };
    assert.ok(settingsData.settings);

    // 7. Intelligence proxies
    const intelRes = await fetch("http://localhost/api/intelligence/proxies");
    assert.equal(intelRes.status, 200);
    const intelData = (await intelRes.json()) as { items: unknown[]; total: number };
    assert.equal(intelData.total, 1);
    assert.equal(intelData.items.length, 1);

    // 8. Handler override and reset
    server.use(
      http.get("*/api/health", () => {
        return HttpResponse.json({ ok: false, overridden: true });
      }),
    );
    const overriddenRes = await fetch("http://localhost/api/health");
    const overriddenData = await overriddenRes.json();
    assert.deepEqual(overriddenData, { ok: false, overridden: true });

    server.resetHandlers();
    const restoredRes = await fetch("http://localhost/api/health");
    const restoredData = await restoredRes.json();
    assert.deepEqual(restoredData, { ok: true });
  } finally {
    server.close();
  }
});
