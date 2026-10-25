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
      /UNIQUE constraint failed|duplicate listener/i,
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
test("fleet repository handles durable node removal lifecycle, controller guard, and IP reservation", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-db-removal-test-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");
  let repo = createFleetRepository({ sqlitePath: dbPath });

  try {
    await repo.migrate();

    const controller = await repo.bootstrapControllerNode();
    const worker = await repo.createNode({
      name: "worker-rm-1",
      wireguardIp: "10.77.0.11",
      role: "worker",
    });

    const ep = await repo.createProxyEndpoint({
      nodeId: worker.id,
      protocol: "http",
      listenIp: "10.77.0.11",
      listenPort: 20002,
      username: "worker_proxy",
    });

    // 1. Controller deletion rejected
    await assert.rejects(
      async () => {
        await repo.requestNodeRemoval(controller.id);
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /controller/i);
        return true;
      },
    );

    // 2. Set token and request removal
    await repo.setNodeAgentToken(worker.id, "worker-token");
    const removal = await repo.requestNodeRemoval(worker.id);

    // Sequence assertion from specification
    assert.equal(removal.status, "pending");
    assert.equal(await repo.verifyNodeAgentToken(worker.id, "worker-token"), false);
    assert.equal(await repo.getNodeDesiredState(worker.id), null);
    assert.equal(
      (await repo.listNodes()).some((n) => n.id === worker.id),
      false,
    );
    assert.notEqual(await repo.getNextWireguardIp(), worker.wireguard_ip);

    // 3. Endpoints of pending node excluded from public query
    assert.equal(await repo.getEndpoint(ep.id), null);
    const publicEndpoints = await repo.listEndpoints();
    assert.equal(
      publicEndpoints.some((e) => e.id === ep.id),
      false,
    );
    // Credentials and update of pending node endpoints are hidden/rejected
    assert.equal(await repo.getEndpointCredentials(ep.id), null);
    await assert.rejects(async () => {
      await repo.updateEndpoint(ep.id, { enabled: false });
    }, /not found/i);

    // Durable intent across DB reopen / process restart
    repo.close();
    const repoReopened = createFleetRepository({ sqlitePath: dbPath });
    await repoReopened.migrate();
    assert.equal((await repoReopened.getNodeRemoval(worker.id))?.status, "pending");
    assert.notEqual(await repoReopened.getNextWireguardIp(), worker.wireguard_ip);
    assert.equal(await repoReopened.verifyNodeAgentToken(worker.id, "worker-token"), false);
    repoReopened.close();
    // Reconnect original repo handle
    repo = createFleetRepository({ sqlitePath: dbPath });
    await repo.migrate();
    const cleanupEndpoints = await repo.listEndpointsForNodeRemovalCleanup(worker.id);
    assert.equal(cleanupEndpoints.length, 1);
    assert.equal(cleanupEndpoints[0].id, ep.id);

    // 5. Health checks rejected for pending node
    await assert.rejects(async () => {
      await repo.recordHealthCheck({
        endpointId: ep.id,
        nodeId: worker.id,
        status: "healthy",
      });
    }, /pending removal/i);

    // 6. Record bounded error
    await repo.recordNodeRemovalError(worker.id, "cleanup connection timeout");
    const pendingWithErr = await repo.getNodeRemoval(worker.id);
    assert.equal(pendingWithErr?.lastError, "cleanup connection timeout");

    // 7. Complete removal
    const completed = await repo.completeNodeRemoval(worker.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.lastError, null);
    assert.ok(completed.completedAt);

    // WireGuard IP is now freed for reallocation
    const nextIp = await repo.getNextWireguardIp();
    assert.equal(nextIp, worker.wireguard_ip);

    // Completed record remains readable (idempotence)
    const tombstone = await repo.getNodeRemoval(worker.id);
    assert.equal(tombstone?.status, "completed");
  } finally {
    repo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("fleet repository stores Tailscale transport, encrypted SSH credentials, and public-IP validation state", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-ts-db-test-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");
  const repo = createFleetRepository({ sqlitePath: dbPath });

  try {
    await repo.migrate();

    // Create Tailscale-based node
    const node = await repo.createTailscaleNode({
      name: "worker-ts-1",
      tailscaleIp: "100.90.108.8",
      expectedPublicIp: "1.1.1.1",
    });

    assert.equal(node.name, "worker-ts-1");
    assert.equal(node.tailscale_ip, "100.90.108.8");
    assert.equal(node.expected_public_ip, "1.1.1.1");
    assert.equal(node.public_ip_status, "unknown");
    assert.equal(node.proxy_activation, "disabled");
    assert.equal(node.ssh_credentials_set, false);

    // Store SSH credentials with pinned fingerprint
    await repo.setNodeSshCredentials(node.id, {
      username: "pi",
      password: "secret_pi_password",
      port: 22,
      hostKeyFingerprint: "SHA256:abc123mockfingerprint",
    });

    const fetched = await repo.getNode(node.id);
    assert.ok(fetched);
    assert.equal(fetched.ssh_credentials_set, true);
    assert.equal(JSON.stringify(fetched).includes("secret_pi_password"), false);

    const creds = await repo.getNodeSshCredentials(node.id);
    assert.ok(creds);
    assert.equal(creds.username, "pi");
    assert.equal(creds.password, "secret_pi_password");
    assert.equal(creds.port, 22);
    assert.equal(creds.hostKeyFingerprint, "SHA256:abc123mockfingerprint");

    // Record observation: expected mismatch
    const mismatchDecision = await repo.recordPublicIpObservation(node.id, "8.8.8.8");
    assert.equal(mismatchDecision.status, "expected_mismatch");
    const nodeAfterMismatch = await repo.getNode(node.id);
    assert.equal(nodeAfterMismatch?.public_ip, "8.8.8.8");
    assert.equal(nodeAfterMismatch?.public_ip_status, "expected_mismatch");
    assert.equal(nodeAfterMismatch?.proxy_activation, "disabled");

    // Attempt activation when status is expected_mismatch must reject
    await assert.rejects(async () => {
      await repo.activateNode(node.id);
    }, /activate/i);

    // Record observation: verified (matches expected 1.1.1.1 and unique)
    const verifiedDecision = await repo.recordPublicIpObservation(node.id, "1.1.1.1");
    assert.equal(verifiedDecision.status, "verified");
    const nodeAfterVerified = await repo.getNode(node.id);
    assert.equal(nodeAfterVerified?.public_ip_status, "verified");

    // Now activate succeeds
    await repo.recordProvisioningState(node.id, { status: "ready", error: null });
    const activated = await repo.activateNode(node.id);
    assert.equal(activated.proxy_activation, "enabled");

    // A second node observing the same public IP must get duplicate status
    const node2 = await repo.createTailscaleNode({
      name: "worker-ts-2",
      tailscaleIp: "100.90.108.9",
      expectedPublicIp: null,
    });
    const dupDecision = await repo.recordPublicIpObservation(node2.id, "1.1.1.1");
    assert.equal(dupDecision.status, "duplicate");
    const node2AfterDup = await repo.getNode(node2.id);
    assert.equal(node2AfterDup?.proxy_activation, "disabled");

    // Disable first node
    await repo.disableNode(node.id, "Manual operator pause");
    const nodeAfterDisable = await repo.getNode(node.id);
    assert.equal(nodeAfterDisable?.proxy_activation, "disabled");
    assert.equal(nodeAfterDisable?.proxy_activation_reason, "Manual operator pause");
  } finally {
    repo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
