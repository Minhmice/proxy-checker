import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  refreshAntigravityQuota,
  triggerBackupSync,
  updateNodeConnection,
  fetchBackupStatus,
  restoreBackup,
  rotateAntigravityAccounts,
  testNineRouterConnection,
  updateSettings,
} from "../src/lib/api.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function respond(body: string, status: number, type = "text/html") {
  globalThis.fetch = (async () =>
    new Response(body, { status, headers: { "content-type": type } })) as typeof fetch;
}

const html = "<html><body>Bad</body></html>";

test("updateSettings: 401 HTML -> wrong password", async () => {
  respond(html, 401);
  await assert.rejects(updateSettings("pw", {}), /Wrong control password/);
});

test("updateSettings: 500 HTML -> HTTP status", async () => {
  respond(html, 500);
  await assert.rejects(updateSettings("pw", {}), /HTTP 500/);
});

test("updateSettings: JSON error and success", async () => {
  respond(JSON.stringify({ error: "nope" }), 400, "application/json");
  await assert.rejects(updateSettings("pw", {}), /nope/);
  respond(JSON.stringify({ a: 1 }), 200, "application/json");
  assert.deepEqual(await updateSettings("pw", {}), { a: 1 });
});

test("testNineRouterConnection: 401/500 HTML and success", async () => {
  respond(html, 401);
  await assert.rejects(testNineRouterConnection("pw"), /Wrong control password/);
  respond(html, 500);
  await assert.rejects(testNineRouterConnection("pw"), /HTTP 500/);
  respond(JSON.stringify({ ok: true }), 200, "application/json");
  assert.deepEqual(await testNineRouterConnection("pw"), { ok: true });
});

test("wrappers: HTML 500 -> {ok:false,error}, JSON error preserved, 401 throws", async () => {
  respond(html, 500);
  assert.deepEqual(await rotateAntigravityAccounts("pw"), { ok: false, error: "HTTP 500" });
  assert.deepEqual(await fetchBackupStatus("pw"), { ok: false, error: "HTTP 500" });
  respond(JSON.stringify({ ok: false, error: "x" }), 500, "application/json");
  assert.deepEqual(await restoreBackup("pw"), { ok: false, error: "x" });
  respond(html, 401);
  await assert.rejects(fetchBackupStatus("pw"), /Wrong control password/);
});

test("updateNodeConnection/triggerBackupSync: HTML 500, JSON error, 401, success", async () => {
  const calls = [
    () => updateNodeConnection("n", "c", true, "pw"),
    () => triggerBackupSync(true, "pw"),
  ];
  for (const call of calls) {
    respond(html, 500);
    assert.deepEqual(await call(), { ok: false, error: "HTTP 500" });
    respond(JSON.stringify({ ok: false, error: "x" }), 500, "application/json");
    assert.deepEqual(await call(), { ok: false, error: "x" });
    respond(html, 401);
    await assert.rejects(call(), /Wrong control password/);
    respond(JSON.stringify({ ok: true }), 200, "application/json");
    assert.deepEqual(await call(), { ok: true });
  }
});

test("refreshAntigravityQuota: OK non-JSON throws HTTP status, 401, success", async () => {
  respond(html, 200);
  await assert.rejects(refreshAntigravityQuota("pw"), /HTTP 200/);
  respond(html, 401);
  await assert.rejects(refreshAntigravityQuota("pw"), /Wrong control password/);
  respond(JSON.stringify({ started: true }), 200, "application/json");
  assert.deepEqual(await refreshAntigravityQuota("pw"), { started: true });
});
