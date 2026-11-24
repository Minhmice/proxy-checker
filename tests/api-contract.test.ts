import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  checkSession,
  fetchAntigravityStatus,
  refreshAntigravityQuota,
  fetchSettings,
  updateSettings,
  testNineRouterConnection,
  updateNodeConnection,
} from "../src/lib/api.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function recordFetch(body: unknown, status = 200) {
  const request = { url: "", init: {} as RequestInit };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    request.url = String(input);
    request.init = init ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }) as typeof fetch;
  return request;
}

test("checkSession sends GET /api/auth/session with same-origin credentials", async () => {
  const request = recordFetch({ authenticated: true });
  const result = await checkSession();
  assert.equal(request.url, "/api/auth/session");
  assert.equal(result, true);
});

test("fetchSettings sends GET /api/settings with auth header", async () => {
  const request = recordFetch({
    settings: {
      controlPasswordSet: true,
      nineRouterPasswordSet: true,
      nineRouterApiKeySet: false,
      nineRouterUrl: "https://9router.example",
      antigravityRotatorEnabled: true,
      antigravityRotateMinutes: 10,
    },
    meta: { restartRequired: [], source: "settings" },
  });
  const result = await fetchSettings("secret");
  assert.equal(request.url, "/api/settings");
  const headers = new Headers(request.init.headers);
  assert.equal(headers.get("authorization"), `Basic ${btoa("admin:secret")}`);
  assert.equal(result.settings.nineRouterUrl, "https://9router.example");
});

test("updateSettings sends rotator payload to /api/settings", async () => {
  const request = recordFetch({
    settings: {
      controlPasswordSet: true,
      nineRouterPasswordSet: true,
      nineRouterApiKeySet: false,
      nineRouterUrl: "https://9router.example",
      antigravityRotatorEnabled: true,
      antigravityRotateMinutes: 15,
    },
    meta: { restartRequired: [], source: "settings" },
  });

  const res = await updateSettings("secret", {
    antigravityRotatorEnabled: true,
    antigravityRotateMinutes: 15,
  });

  assert.equal(request.url, "/api/settings");
  assert.equal(request.init.method, "PUT");
  const sentPayload = JSON.parse(String(request.init.body));
  assert.equal(sentPayload.antigravityRotatorEnabled, true);
  assert.equal(sentPayload.antigravityRotateMinutes, 15);
  assert.equal(res.settings.antigravityRotateMinutes, 15);
});

test("fetchAntigravityStatus sends GET /api/antigravity/status", async () => {
  const request = recordFetch({
    lastRunAt: 123456789,
    running: false,
    totalAccounts: 2,
    activeCount: 1,
    totalSessionQuotaPercentage: 80,
    maxPossiblePercentage: 200,
    accounts: [],
    degraded: false,
  });
  const result = await fetchAntigravityStatus("secret");
  assert.equal(request.url, "/api/antigravity/status");
  assert.equal(result?.activeCount, 1);
});

test("updateNodeConnection sends PUT /api/ninerouter/nodes/:nodeId/connections/:connectionId", async () => {
  const request = recordFetch({ ok: true });
  const result = await updateNodeConnection("node-1", "conn-1", true, "secret");
  assert.equal(request.url, "/api/ninerouter/nodes/node-1/connections/conn-1");
  assert.equal(request.init.method, "PUT");
  const sentPayload = JSON.parse(String(request.init.body));
  assert.equal(sentPayload.isActive, true);
  assert.equal(result.ok, true);
});

test("all abortable API functions swallow AbortError from json parsing without rejections", async () => {
  const abortError = new DOMException("signal is aborted without reason", "AbortError");
  globalThis.fetch = (async () => {
    return {
      ok: true,
      status: 200,
      json: async () => {
        throw abortError;
      },
    } as unknown as Response;
  }) as typeof fetch;

  const controller = new AbortController();
  const antiRes = await fetchAntigravityStatus("secret", controller.signal);
  assert.equal(antiRes, null);

  const settingsRes = await fetchSettings("secret", controller.signal);
  assert.equal(settingsRes.settings.controlPasswordSet, false);

  const sessionRes = await checkSession(controller.signal);
  assert.equal(sessionRes, false);
});
