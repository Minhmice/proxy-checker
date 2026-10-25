import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createFleetRepository } from "../src/proxyfleet/db.js";

test("fleet state safety: legacy schema migration seeds desired_revision above historical timestamps", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-legacy-test-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");

  try {
    // 1. Manually setup legacy SQLite schema without desired_revision and agent_token_hash columns
    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(`
      CREATE TABLE fleet_nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'worker',
        status TEXT NOT NULL DEFAULT 'offline',
        public_ip TEXT,
        wireguard_ip TEXT NOT NULL UNIQUE,
        wireguard_public_key TEXT,
        os TEXT,
        arch TEXT,
        agent_version TEXT,
        last_heartbeat_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE fleet_proxy_endpoints (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES fleet_nodes(id) ON DELETE CASCADE,
        protocol TEXT NOT NULL,
        listen_ip TEXT NOT NULL,
        listen_port INTEGER NOT NULL,
        egress_id TEXT,
        username TEXT NOT NULL,
        credential_ref TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        current_revision INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(node_id, listen_ip, listen_port)
      );
    `);

    const legacyTimestampNode = 1710000000000;
    const legacyTimestampEndpoint = 1710000050000;
    const legacyRevisionEndpoint = 1710000050000;

    rawDb
      .prepare(`
      INSERT INTO fleet_nodes (
        id, name, role, status, public_ip, wireguard_ip, wireguard_public_key, os, arch, agent_version, last_heartbeat_at, created_at, updated_at
      ) VALUES ('legacy-node-1', 'old-worker', 'worker', 'offline', NULL, '10.77.0.20', NULL, 'linux', 'amd64', '0.0.1', NULL, ?, ?)
    `)
      .run(legacyTimestampNode - 1000, legacyTimestampNode);

    rawDb
      .prepare(`
      INSERT INTO fleet_proxy_endpoints (
        id, node_id, protocol, listen_ip, listen_port, egress_id, username, credential_ref, enabled, current_revision, created_at, updated_at
      ) VALUES ('ep-legacy-1', 'legacy-node-1', 'http', '10.77.0.20', 20050, NULL, 'user_old', 'cred-old', 1, ?, ?, ?)
    `)
      .run(legacyRevisionEndpoint, legacyTimestampEndpoint - 1000, legacyTimestampEndpoint);

    rawDb.close();

    // 2. Open via repository and run migrate()
    const repo = createFleetRepository({ sqlitePath: dbPath });
    const beforeMigrate = Date.now();
    await repo.migrate();

    const node = await repo.getNode("legacy-node-1");
    assert.ok(node, "Legacy node must exist");
    assert.ok(
      node.desired_revision > legacyTimestampNode,
      "Revision must exceed legacy node updated_at",
    );
    assert.ok(
      node.desired_revision > legacyTimestampEndpoint,
      "Revision must exceed legacy endpoint updated_at",
    );
    assert.ok(
      node.desired_revision > legacyRevisionEndpoint,
      "Revision must exceed legacy endpoint revision",
    );
    assert.ok(
      node.desired_revision >= beforeMigrate + 1,
      "Revision must exceed migration start time",
    );

    repo.close();
  } finally {
    try {
      fs.rmSync(tmpDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    } catch {}
  }
});

test("fleet state safety: agent token hashing, rotation, scoping and private storage", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-token-test-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");
  const repo = createFleetRepository({ sqlitePath: dbPath });

  try {
    await repo.migrate();

    await repo.createNode({
      id: "node-alpha",
      name: "worker-alpha",
      wireguardIp: "10.77.0.12",
    });

    await repo.createNode({
      id: "node-beta",
      name: "worker-beta",
      wireguardIp: "10.77.0.13",
    });

    // Initial check: no token configured
    const unverifiedAlpha = await repo.verifyNodeAgentToken("node-alpha", "fla_secret_123");
    assert.equal(unverifiedAlpha, false, "Node without token must reject verification");

    // Set token for alpha
    await repo.setNodeAgentToken("node-alpha", "fla_secret_alpha_token_value_32_bytes");

    // Verify valid token
    const valid = await repo.verifyNodeAgentToken(
      "node-alpha",
      "fla_secret_alpha_token_value_32_bytes",
    );
    assert.equal(valid, true, "Valid token must verify");

    // Scoped check: beta cannot use alpha's token
    const foreign = await repo.verifyNodeAgentToken(
      "node-beta",
      "fla_secret_alpha_token_value_32_bytes",
    );
    assert.equal(foreign, false, "Token must be scoped to specific node only");

    // Wrong token rejected
    const invalid = await repo.verifyNodeAgentToken("node-alpha", "fla_wrong_token");
    assert.equal(invalid, false, "Incorrect token must reject");

    // Empty token or empty node rejected
    assert.equal(await repo.verifyNodeAgentToken("node-alpha", ""), false);
    assert.equal(
      await repo.verifyNodeAgentToken("", "fla_secret_alpha_token_value_32_bytes"),
      false,
    );

    // Node mapper must never leak token hash
    const nodeRecord = await repo.getNode("node-alpha");
    assert.ok(nodeRecord);
    assert.equal("agent_token_hash" in nodeRecord, false);

    // Rotation: setting new token immediately invalidates old token
    await repo.setNodeAgentToken("node-alpha", "fla_rotated_token_new");
    assert.equal(
      await repo.verifyNodeAgentToken("node-alpha", "fla_secret_alpha_token_value_32_bytes"),
      false,
    );
    assert.equal(await repo.verifyNodeAgentToken("node-alpha", "fla_rotated_token_new"), true);

    repo.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("fleet state safety: transactional endpoint mutations, same-clock disable, noop and rollback", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-tx-test-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");
  const repo = createFleetRepository({ sqlitePath: dbPath });

  const origNow = Date.now;
  try {
    await repo.migrate();

    const node0 = await repo.createNode({
      id: "node-tx",
      name: "worker-tx",
      wireguardIp: "10.77.0.14",
    });
    const rev0 = node0.desired_revision;
    assert.ok(rev0 > 0, "Initial desired_revision must be positive");

    // 1. Create endpoint sets endpoint-local current_revision=1 and strictly increases node desired_revision
    const ep1 = await repo.createProxyEndpoint({
      id: "ep-tx-1",
      nodeId: "node-tx",
      protocol: "http",
      listenIp: "10.77.0.14",
      listenPort: 21001,
      username: "user1",
      password: "pass1",
      enabled: true,
    });
    assert.equal(
      ep1.current_revision,
      1,
      "Endpoint-local current_revision must start at 1 on creation",
    );

    const nodeAfterCreate = await repo.getNode("node-tx");
    const nodeRevAfterCreate = nodeAfterCreate?.desired_revision ?? 0;
    assert.ok(
      nodeRevAfterCreate > rev0,
      "Node desired_revision must strictly increase after endpoint creation",
    );

    // 2. Same-clock disable increments endpoint current_revision independently and bumps node desired_revision
    const frozenClock = 1720000000000;
    Date.now = () => frozenClock;

    const disabledEp = await repo.updateEndpoint("ep-tx-1", { enabled: false });
    assert.equal(disabledEp.enabled, false);
    assert.equal(
      disabledEp.current_revision,
      2,
      "Endpoint current_revision must increment to 2 on update",
    );

    const nodeAfterDisable = await repo.getNode("node-tx");
    const nodeRevAfterDisable = nodeAfterDisable?.desired_revision ?? 0;
    assert.ok(
      nodeRevAfterDisable > nodeRevAfterCreate,
      "Node desired_revision must strictly increase on disable",
    );
    // 3. No-op update preserves revision stability
    const noop1 = await repo.updateEndpoint("ep-tx-1", { enabled: false });
    assert.equal(noop1.current_revision, 2, "No-op enabled update must preserve endpoint revision");

    const noop2 = await repo.updateEndpoint("ep-tx-1", {
      username: "user1",
      password: "pass1",
    });
    assert.equal(
      noop2.current_revision,
      2,
      "No-op credentials update must preserve endpoint revision",
    );

    const nodeAfterNoop = await repo.getNode("node-tx");
    assert.equal(nodeAfterNoop?.desired_revision, nodeRevAfterDisable);

    // 4. Failed mutation rolls back and preserves revision
    await assert.rejects(
      repo.createProxyEndpoint({
        id: "ep-tx-fail",
        nodeId: "node-tx",
        protocol: "http",
        listenIp: "10.77.0.14",
        listenPort: 21001, // duplicate port fails UNIQUE constraint
        username: "user_dup",
        password: "pwd",
      }),
      /UNIQUE constraint failed/i,
    );

    const nodeAfterRollback = await repo.getNode("node-tx");
    assert.equal(
      nodeAfterRollback?.desired_revision,
      nodeRevAfterDisable,
      "Failed transaction must preserve revision",
    );

    // 5. Creating distinct second endpoint sets local current_revision=1 while bumping node revision
    const epNoCred = await repo.createProxyEndpoint({
      id: "ep-nocred",
      nodeId: "node-tx",
      protocol: "socks5",
      listenIp: "10.77.0.14",
      listenPort: 21002,
      username: "bare_user",
      enabled: true,
    });
    assert.equal(
      epNoCred.current_revision,
      1,
      "New endpoint must start at local current_revision 1",
    );

    const nodeAfterEp2 = await repo.getNode("node-tx");
    const nodeRevAfterEp2 = nodeAfterEp2?.desired_revision ?? 0;
    assert.ok(
      nodeRevAfterEp2 > nodeRevAfterDisable,
      "Node revision must increase on second endpoint creation",
    );

    const credsBefore = await repo.getEndpointCredentials("ep-nocred");
    assert.equal(credsBefore, null);

    const epWithCred = await repo.updateEndpoint("ep-nocred", {
      password: "new_secret_pwd",
    });
    assert.equal(epWithCred.current_revision, 2, "Updated endpoint increments to local revision 2");

    const nodeAfterEp2Update = await repo.getNode("node-tx");
    assert.ok(
      (nodeAfterEp2Update?.desired_revision ?? 0) > nodeRevAfterEp2,
      "Node revision must increase on endpoint update",
    );
    const credsAfter = await repo.getEndpointCredentials("ep-nocred");
    assert.equal(credsAfter?.username, "bare_user");
    assert.equal(credsAfter?.password, "new_secret_pwd");

    // 6. Username change keeps credentials row username consistent
    await repo.updateEndpoint("ep-nocred", { username: "renamed_user" });
    const credsRenamed = await repo.getEndpointCredentials("ep-nocred");
    assert.equal(credsRenamed?.username, "renamed_user");
    assert.equal(credsRenamed?.password, "new_secret_pwd");

    repo.close();
  } finally {
    Date.now = origNow;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("fleet state safety: getNodeDesiredState returns atomic snapshot with correct revision and enabled proxies", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desired-test-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");
  const repo = createFleetRepository({ sqlitePath: dbPath });

  try {
    await repo.migrate();

    // Nonexistent node returns null
    assert.equal(await repo.getNodeDesiredState("nonexistent-node"), null);

    await repo.createNode({
      id: "node-snap",
      name: "worker-snap",
      wireguardIp: "10.77.0.17",
    });

    // Initial state: 0 endpoints
    const initialSnap = await repo.getNodeDesiredState("node-snap");
    assert.ok(initialSnap);
    assert.ok(initialSnap.revision > 0);
    assert.equal(initialSnap.proxies.length, 0);

    // Add endpoint with password
    await repo.createProxyEndpoint({
      id: "ep-snap-1",
      nodeId: "node-snap",
      protocol: "http",
      listenIp: "10.77.0.17",
      listenPort: 23001,
      username: "user_snap",
      password: "secret_snap_pwd",
      enabled: true,
    });

    const snap1 = await repo.getNodeDesiredState("node-snap");
    assert.ok(snap1);
    assert.ok(snap1.revision > initialSnap.revision);
    assert.equal(snap1.proxies.length, 1);
    assert.equal(snap1.proxies[0].id, "ep-snap-1");
    assert.equal(snap1.proxies[0].username, "user_snap");
    assert.equal(snap1.proxies[0].password, "secret_snap_pwd");
    assert.equal(snap1.proxies[0].enabled, true);

    // Disable endpoint: revision bumps, enabled proxies becomes empty
    await repo.updateEndpoint("ep-snap-1", { enabled: false });
    const snap2 = await repo.getNodeDesiredState("node-snap");
    assert.ok(snap2);
    assert.ok(
      snap2.revision > snap1.revision,
      "Disabling endpoint must strictly increase revision",
    );
    assert.equal(
      snap2.proxies.length,
      0,
      "Disabled endpoint must not appear in desired state proxies",
    );

    repo.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("fleet state safety: revision persistence across repo reopen", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-persist-test-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");

  try {
    const repo1 = createFleetRepository({ sqlitePath: dbPath });
    await repo1.migrate();

    await repo1.createNode({
      id: "node-persist",
      name: "worker-persist",
      wireguardIp: "10.77.0.15",
    });

    await repo1.createProxyEndpoint({
      id: "ep-persist-1",
      nodeId: "node-persist",
      protocol: "http",
      listenIp: "10.77.0.15",
      listenPort: 22001,
      username: "u1",
      password: "p1",
    });

    await repo1.updateEndpoint("ep-persist-1", { enabled: false });

    const nodeBeforeClose = await repo1.getNode("node-persist");
    assert.equal(nodeBeforeClose?.desired_revision, 3);
    repo1.close();

    // Reopen from same path
    const repo2 = createFleetRepository({ sqlitePath: dbPath });
    await repo2.migrate();

    const nodeAfterReopen = await repo2.getNode("node-persist");
    assert.equal(
      nodeAfterReopen?.desired_revision,
      3,
      "desired_revision must persist across reopen",
    );

    repo2.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("fleet state safety: effective worker liveness and status filtering", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-liveness-test-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");
  const repo = createFleetRepository({ sqlitePath: dbPath });

  try {
    await repo.migrate();

    // 1. Worker created without heartbeat -> effective status offline
    await repo.createNode({
      id: "node-live-1",
      name: "worker-live-1",
      wireguardIp: "10.77.0.16",
    });

    const initial = await repo.getNode("node-live-1");
    assert.equal(initial?.status, "offline");

    const offlineList1 = await repo.listNodes({ status: "offline" });
    assert.ok(offlineList1.some((n) => n.id === "node-live-1"));

    const onlineList1 = await repo.listNodes({ status: "online" });
    assert.ok(!onlineList1.some((n) => n.id === "node-live-1"));

    // 2. Fresh heartbeat with online status -> online
    await repo.recordHeartbeat("node-live-1", { status: "online" });
    const afterHeartbeat = await repo.getNode("node-live-1");
    assert.equal(afterHeartbeat?.status, "online");
    assert.equal(afterHeartbeat?.desired_revision, 1, "Heartbeat must not bump desired_revision");

    const onlineList2 = await repo.listNodes({ status: "online" });
    assert.ok(onlineList2.some((n) => n.id === "node-live-1"));

    // 3. Stale heartbeat (>= 60s ago) evaluates to offline
    const rawDb = new DatabaseSync(dbPath);
    rawDb
      .prepare("UPDATE fleet_nodes SET last_heartbeat_at = ? WHERE id = ?")
      .run(Date.now() - 65_000, "node-live-1");
    rawDb.close();

    const staleNode = await repo.getNode("node-live-1");
    assert.equal(staleNode?.status, "offline", "Heartbeat older than 60s must evaluate to offline");

    const offlineFiltered = await repo.listNodes({ status: "offline" });
    assert.ok(
      offlineFiltered.some((n) => n.id === "node-live-1"),
      "listNodes({ status: 'offline' }) must match effective status",
    );

    const onlineFiltered = await repo.listNodes({ status: "online" });
    assert.ok(
      !onlineFiltered.some((n) => n.id === "node-live-1"),
      "listNodes({ status: 'online' }) must exclude expired node",
    );

    // 4. Fresh heartbeat with degraded status preserves degraded
    await repo.recordHeartbeat("node-live-1", { status: "degraded" });
    const degradedNode = await repo.getNode("node-live-1");
    assert.equal(degradedNode?.status, "degraded", "Fresh degraded status must be preserved");

    const degradedFiltered = await repo.listNodes({ status: "degraded" });
    assert.ok(degradedFiltered.some((n) => n.id === "node-live-1"));
  } finally {
    repo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("fleet state safety: atomic consumeEnrollmentToken across concurrent connections and expiry boundaries", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-enroll-atomic-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");
  const repo1 = createFleetRepository({ sqlitePath: dbPath });
  const repo2 = createFleetRepository({ sqlitePath: dbPath });

  try {
    await repo1.migrate();

    // 1. Concurrent consumption across distinct repo instances on same DB
    const tokenHash = "token-hash-atomic-race";
    await repo1.createEnrollmentToken({
      tokenHash,
      nodeName: "race-worker",
      expiresAt: Date.now() + 60_000,
      assignedIp: "10.77.0.50",
    });

    const [res1, res2] = await Promise.all([
      repo1.consumeEnrollmentToken(tokenHash),
      repo2.consumeEnrollmentToken(tokenHash),
    ]);

    const successes = [res1, res2].filter((r) => r !== null);
    const failures = [res1, res2].filter((r) => r === null);
    assert.equal(successes.length, 1, "Exactly one concurrent caller must consume token");
    assert.equal(failures.length, 1, "Second concurrent caller must fail");
    assert.equal(successes[0]?.nodeName, "race-worker");
    assert.equal(successes[0]?.assignedIp, "10.77.0.50");

    // 2. Expiry boundary: expired token returns null
    const expiredHash = "token-hash-expired";
    await repo1.createEnrollmentToken({
      tokenHash: expiredHash,
      nodeName: "expired-worker",
      expiresAt: Date.now() - 1000,
    });
    const expiredRes = await repo1.consumeEnrollmentToken(expiredHash);
    assert.equal(expiredRes, null, "Expired token must return null");

    // 3. Valid boundary token consumed once, then rejected on reuse
    const boundaryHash = "token-hash-boundary";
    await repo1.createEnrollmentToken({
      tokenHash: boundaryHash,
      nodeName: "boundary-worker",
      expiresAt: Date.now() + 10_000,
    });
    const boundaryFirst = await repo1.consumeEnrollmentToken(boundaryHash);
    assert.ok(boundaryFirst);
    assert.equal(boundaryFirst.nodeName, "boundary-worker");

    const boundarySecond = await repo2.consumeEnrollmentToken(boundaryHash);
    assert.equal(boundarySecond, null, "Consumed token must not be reusable");

    repo1.close();
    repo2.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
