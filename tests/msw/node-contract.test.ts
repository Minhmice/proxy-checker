import test from "node:test";
import assert from "node:assert/strict";
import { server } from "../../src/mocks/node.js";
import { http, HttpResponse } from "msw";

test("msw node contract: intercepts handled requests with fixtures", async () => {
  server.listen({ onUnhandledFrame: "error" });

  try {
    const healthRes = await fetch("http://localhost/api/health");
    assert.equal(healthRes.status, 200);
    const healthData = await healthRes.json();
    assert.deepEqual(healthData, { ok: true });

    const sessionRes = await fetch("http://localhost/api/auth/session");
    assert.equal(sessionRes.status, 200);
    const sessionData = await sessionRes.json();
    assert.deepEqual(sessionData, { authenticated: true });

    const loginFailRes = await fetch("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong-password" }),
    });
    assert.equal(loginFailRes.status, 401);

    const loginSuccessRes = await fetch("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "correct-password" }),
    });
    assert.equal(loginSuccessRes.status, 200);
    const loginData = (await loginSuccessRes.json()) as { authenticated: boolean };
    assert.equal(loginData.authenticated, true);

    const nrRes = await fetch("http://localhost/api/ninerouter/status");
    assert.equal(nrRes.status, 200);
    const nrData = (await nrRes.json()) as { status: string };
    assert.equal(nrData.status, "connected");

    const settingsRes = await fetch("http://localhost/api/settings");
    assert.equal(settingsRes.status, 200);
    const settingsData = (await settingsRes.json()) as { settings: Record<string, unknown> };
    assert.ok(settingsData.settings);

    const agRes = await fetch("http://localhost/api/antigravity/status");
    assert.equal(agRes.status, 200);
    const agData = (await agRes.json()) as { totalAccounts: number; accounts: unknown[] };
    assert.equal(agData.totalAccounts, 2);
    assert.equal(agData.accounts.length, 2);

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
