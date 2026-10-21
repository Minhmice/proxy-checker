import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { openProxyIntelligenceDb } from "../src/server/proxy-intelligence-db.js";
import { createProxyIntelligenceRepository } from "../src/server/proxy-intelligence-repository.js";
import { createProxyCheckHandler } from "../src/server/proxy-check-handler.js";
import { createSession, sessionCookie } from "../src/server/session-auth.js";
import type { NineRouterTestResult } from "../src/server/nine-router-client.js";

async function fixture(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-check-"));
  const db = openProxyIntelligenceDb(dir);
  const repo = createProxyIntelligenceRepository({ db });
  await repo.importProxies({ content: "http://user:pass@1.2.3.4:8080", source: "test" });
  const key = (await repo.getUnifiedProxies({})).items[0].proxyKey;
  let outcome: NineRouterTestResult = { ok: true, elapsedMs: 42 };
  let throws = false;
  const handler = createProxyCheckHandler({ db, repo, testPool: async () => {
    if (throws) throw new Error("upstream unavailable");
    return outcome;
  }, readBody: async req => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return JSON.parse(raw);
  }, json: (res, body, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); } });
  const server = http.createServer((req, res) => { void handler(req, res, new URL(req.url!, "http://localhost").pathname); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookie = sessionCookie(createSession().token).split(";")[0];
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, repo, key, setOutcome: (value: NineRouterTestResult) => { outcome = value; }, setThrow: () => { throws = true; },
    check: (authenticated = true) => fetch(base + "/api/proxies/check", { method: "POST", headers: { Cookie: authenticated ? cookie : "", "Content-Type": "application/json" }, body: JSON.stringify({ proxyKey: key }) }),
    history: async () => (await fetch(base + `/api/proxies/history?key=${encodeURIComponent(key)}`, { headers: { Cookie: cookie } })).json(),
    link: () => db.run("UPDATE proxies SET remote_id = ? WHERE proxy_key = ?", ["pool-1", key]),
  };
}

test("manual success and failure atomically update one history row and current evidence", async t => {
  const f = await fixture(t); f.link();
  assert.equal((await f.check(false)).status, 401);
  assert.equal((await f.check()).status, 200);
  f.setOutcome({ ok: false, error: "Connection refused", elapsedMs: 15 });
  assert.equal((await f.check()).status, 200);
  const row = f.db.get<any>("SELECT * FROM proxies WHERE proxy_key = ?", [f.key])!;
  assert.equal(row.successes, 1); assert.equal(row.failures, 1);
  assert.equal(row.last_verdict, "FAIL"); assert.equal(row.latency_ms, null);
  assert.equal(row.last_latency_ms, null); assert.equal(row.last_error, "Connection refused");
  assert.equal(row.last_checked_at, row.checked_at);
  const { history } = await f.history();
  assert.equal(history.length, 2);
  assert.equal(history[0].errorMessage, "Connection refused");
  assert.equal(history[0].udp, "Unknown");
  f.setOutcome({ ok: true, elapsedMs: 9 }); await f.check();
  assert.equal(f.db.get<any>("SELECT last_error FROM proxies WHERE proxy_key = ?", [f.key])!.last_error, null);
});

test("unlinked proxy and upstream transport errors never mutate proxy health or history", async t => {
  const f = await fixture(t);
  await f.repo.recordTestResult(f.key, true, 5);
  const before = f.db.get<any>("SELECT * FROM proxies WHERE proxy_key = ?", [f.key]);
  assert.equal((await f.check()).status, 409);
  assert.deepEqual(f.db.get("SELECT * FROM proxies WHERE proxy_key = ?", [f.key]), before);
  f.link();
  const linked = f.db.get("SELECT * FROM proxies WHERE proxy_key = ?", [f.key]);
  f.setOutcome({ ok: false, failureKind: "transport", error: "upstream down" });
  assert.equal((await f.check()).status, 502);
  f.setThrow(); assert.equal((await f.check()).status, 502);
  assert.deepEqual(f.db.get("SELECT * FROM proxies WHERE proxy_key = ?", [f.key]), linked);
  assert.equal((await f.history()).history.length, 1);
});
