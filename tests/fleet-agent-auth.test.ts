import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createFleetRepository } from "../src/proxyfleet/db.js";
import { createFleetApiHandler } from "../src/proxyfleet/api-router.js";

async function fixture(t: test.TestContext) {
  const repo = createFleetRepository({ sqlitePath: ":memory:" });
  await repo.migrate();
  const handler = createFleetApiHandler({ repo, verifyAuth: token => token === "dashboard-secret" });
  const server = http.createServer((req, res) => {
    void handler(req, res, new URL(req.url!, "http://localhost").pathname).then(handled => {
      if (!handled) { res.writeHead(404); res.end(); }
    }).catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); repo.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { repo, base, request: (path: string, token?: string, body?: unknown) => fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) };
}

test("anonymous worker routes reject before leaking credentials or mutating state", async t => {
  const f = await fixture(t);
  const node = await f.repo.createNode({ name: "worker", wireguardIp: "10.77.0.11" });
  await f.repo.createProxyEndpoint({ nodeId: node.id, protocol: "http", listenIp: node.wireguard_ip, listenPort: 20001, username: "u", password: "dummy-secret" });
  for (const token of [undefined, "dashboard-secret", "wrong-token"]) {
    const state = await f.request(`/api/fleet/agent/desired-state?nodeId=${node.id}`, token);
    assert.equal(state.status, 401);
    assert.equal((await state.text()).includes("dummy-secret"), false);
    assert.equal((await f.request("/api/fleet/agent/heartbeat", token, { nodeId: node.id, status: "online" })).status, 401);
    assert.equal((await f.request("/api/fleet/agent/deployment-result", token, { nodeId: node.id, status: "applied" })).status, 401);
  }
  assert.equal((await f.repo.getNode(node.id))!.last_heartbeat_at, null);
  assert.deepEqual(await f.repo.listEvents({ nodeId: node.id }), []);
});

test("admin-issued node token scopes all worker actions and rotates without changing identity", async t => {
  const f = await fixture(t);
  const a = await f.repo.createNode({ name: "a", wireguardIp: "10.77.0.11" });
  const b = await f.repo.createNode({ name: "b", wireguardIp: "10.77.0.12" });
  const route = `/api/fleet/nodes/${a.id}/agent-token`;
  assert.equal((await f.request(route, undefined, {})).status, 401);
  const issued = await f.request(route, "dashboard-secret", {});
  assert.equal(issued.status, 200);
  const { agentToken } = await issued.json();
  assert.equal(typeof agentToken, "string");
  assert.equal((await f.request(`/api/fleet/agent/desired-state?nodeId=${a.id}`, agentToken)).status, 200);
  assert.equal((await f.request(`/api/fleet/agent/desired-state?nodeId=${b.id}`, agentToken)).status, 401);
  for (const path of ["heartbeat", "deployment-result"]) {
    assert.equal((await f.request(`/api/fleet/agent/${path}`, agentToken, { nodeId: b.id, status: "online" })).status, 401);
  }
  assert.equal((await f.request("/api/fleet/agent/heartbeat", agentToken, { nodeId: a.id, status: "online" })).status, 200);
  const rotated = await f.request(route, "dashboard-secret", {});
  const replacement = (await rotated.json()).agentToken;
  assert.notEqual(replacement, agentToken);
  assert.equal((await f.request(`/api/fleet/agent/desired-state?nodeId=${a.id}`, agentToken)).status, 401);
  assert.equal((await f.request(`/api/fleet/agent/desired-state?nodeId=${a.id}`, replacement)).status, 200);
  const nodeResponse = await f.request(`/api/fleet/nodes/${a.id}`, "dashboard-secret");
  const text = await nodeResponse.text();
  assert.equal(text.includes(replacement), false);
  assert.equal(text.includes("agent_token_hash"), false);
});

test("agent token rejected immediately upon removal intent", async (t) => {
  const f = await fixture(t);
  const node = await f.repo.createNode({ name: "worker-to-remove", wireguardIp: "10.77.0.15" });
  const tokenRoute = `/api/fleet/nodes/${node.id}/agent-token`;
  const tokenRes = await f.request(tokenRoute, "dashboard-secret", {});
  assert.equal(tokenRes.status, 200);
  const { agentToken } = await tokenRes.json();

  // Valid before removal
  assert.equal((await f.request(`/api/fleet/agent/desired-state?nodeId=${node.id}`, agentToken)).status, 200);

  // Request removal
  await f.repo.requestNodeRemoval(node.id);

  // Rejected immediately after removal intent
  assert.equal((await f.request(`/api/fleet/agent/desired-state?nodeId=${node.id}`, agentToken)).status, 401);
  assert.equal(
    (await f.request("/api/fleet/agent/heartbeat", agentToken, { nodeId: node.id, status: "online" })).status,
    401
  );
  assert.equal(
    (await f.request("/api/fleet/agent/deployment-result", agentToken, { nodeId: node.id, status: "applied" })).status,
    401
  );
});
