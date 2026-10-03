import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createFleetRepository } from "../src/proxyfleet/db.js";

test("fleet repository initializes sqlite storage and manages nodes and endpoints", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-db-test-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");
  const repo = createFleetRepository({ sqlitePath: dbPath });

  try {
    await repo.migrate();

    // 1. Create a node
    const node = await repo.createNode({
      id: "node-001",
      name: "worker-001",
      wireguardIp: "10.77.0.11",
      publicIp: "113.160.1.2",
      os: "Ubuntu 24.04",
      arch: "x86_64",
      agentVersion: "0.1.0",
    });

    assert.equal(node.id, "node-001");
    assert.equal(node.name, "worker-001");
    assert.equal(node.status, "offline");

    // 2. Fetch node
    const fetched = await repo.getNode("node-001");
    assert.ok(fetched);
    assert.equal(fetched.wireguardIp, "10.77.0.11");

    // 3. Heartbeat update
    await repo.recordHeartbeat("node-001", {
      status: "online",
      cpuUsage: 15.4,
      memoryUsage: 32.1,
      publicIp: "113.160.1.2",
    });

    const updated = await repo.getNode("node-001");
    assert.equal(updated?.status, "online");

    // 4. Create an endpoint
    const endpoint = await repo.createProxyEndpoint({
      id: "ep-001",
      nodeId: "node-001",
      protocol: "http",
      listenIp: "10.77.0.11",
      listenPort: 20001,
      username: "user_a",
      password: "secret_password_123",
      enabled: true,
    });

    assert.equal(endpoint.id, "ep-001");
    assert.equal(endpoint.listenPort, 20001);

    // List endpoints for node
    const endpoints = await repo.listEndpoints({ nodeId: "node-001" });
    assert.equal(endpoints.length, 1);
    assert.equal(endpoints[0].id, "ep-001");

    // 5. Duplicate listener rejected
    await assert.rejects(
      repo.createProxyEndpoint({
        id: "ep-002",
        nodeId: "node-001",
        protocol: "socks5",
        listenIp: "10.77.0.11",
        listenPort: 20001, // same port on same node!
        username: "user_b",
        password: "another_password",
        enabled: true,
      }),
      /UNIQUE constraint failed|duplicate listener/i
    );

    // 6. Record health check
    await repo.recordHealthCheck({
      endpointId: "ep-001",
      nodeId: "node-001",
      status: "healthy",
      exitIp: "113.160.1.2",
      latencyMs: 45,
    });

    const latestCheck = await repo.getLatestHealthCheck("ep-001");
    assert.equal(latestCheck?.status, "healthy");
    assert.equal(latestCheck?.exitIp, "113.160.1.2");

    // 7. Events recording
    await repo.recordEvent({
      nodeId: "node-001",
      endpointId: "ep-001",
      eventType: "proxy.healthy",
      level: "info",
      payload: { latency: 45 },
    });

    const events = await repo.listEvents({ nodeId: "node-001" });
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, "proxy.healthy");
  } finally {
    repo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("fleet repository supports node role and idempotent controller bootstrap", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-role-test-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");
  const repo = createFleetRepository({ sqlitePath: dbPath });

  try {
    await repo.migrate();

    // 1. Regular worker node creation defaults to role "worker"
    const worker = await repo.createNode({
      id: "node-worker-01",
      name: "worker-001",
      wireguardIp: "10.77.0.11",
    });
    assert.equal(worker.role, "worker");

    // 2. Idempotent controller-worker bootstrap
    const ctrl1 = await repo.bootstrapControllerNode({
      id: "controller-node-01",
      name: "controller-001",
      wireguardIp: "10.77.0.1",
      os: "Linux",
      arch: "x86_64",
    });
    assert.equal(ctrl1.role, "controller-worker");
    assert.equal(ctrl1.wireguardIp, "10.77.0.1");

    // 3. Second bootstrap call must return same node without duplicating
    const ctrl2 = await repo.bootstrapControllerNode({
      id: "controller-node-01",
      name: "controller-001",
      wireguardIp: "10.77.0.1",
      os: "Linux",
      arch: "x86_64",
    });
    assert.equal(ctrl2.id, ctrl1.id);

    const allNodes = await repo.listNodes();
    assert.equal(allNodes.length, 2);
  } finally {
    repo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
