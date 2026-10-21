import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createFleetRepository } from "../src/proxyfleet/db.js";
import { createFleetApiHandler } from "../src/proxyfleet/api-router.js";

function setupTestEnvironment() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-convergence-test-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");
  const repo = createFleetRepository({ sqlitePath: dbPath });
  return { tmpDir, dbPath, repo };
}

test("legacy and newly created nodes default to unknown configuration status with null appliedRevision", async () => {
  const { tmpDir, repo } = setupTestEnvironment();
  try {
    await repo.migrate();

    const node = await repo.createNode({
      name: "node-worker-1",
      wireguardIp: "10.77.0.11",
      publicIp: "1.2.3.4",
    });

    assert.equal(node.configuration.status, "unknown");
    assert.equal(node.configuration.desiredRevision, 1);
    assert.equal(node.configuration.appliedRevision, null);
    assert.equal(node.configuration.deploymentRevision, null);
    assert.equal(node.configuration.error, null);
    assert.equal(node.configuration.updatedAt, null);

    const fetched = await repo.getNode(node.id);
    assert.ok(fetched);
    assert.equal(fetched.configuration.status, "unknown");
    assert.equal(fetched.configuration.appliedRevision, null);
  } finally {
    repo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("desired revision changes transition deployment status to pending and clear errors", async () => {
  const { tmpDir, repo } = setupTestEnvironment();
  try {
    await repo.migrate();

    const node = await repo.createNode({
      name: "node-worker-2",
      wireguardIp: "10.77.0.12",
    });

    // 1. Update desired revision explicitly
    await repo.updateNodeDesiredRevision(node.id, 5);
    let updated = await repo.getNode(node.id);
    assert.equal(updated?.desired_revision, 5);
    assert.equal(updated?.configuration.desiredRevision, 5);
    assert.equal(updated?.configuration.status, "pending");
    assert.equal(updated?.configuration.error, null);

    // 2. Creating an endpoint advances desired revision and keeps status pending
    await repo.createProxyEndpoint({
      nodeId: node.id,
      protocol: "http",
      listenIp: "10.77.0.12",
      listenPort: 10001,
      username: "user1",
      password: "pass1",
    });

    updated = await repo.getNode(node.id);
    assert.equal(updated?.desired_revision, 6);
    assert.equal(updated?.configuration.status, "pending");
  } finally {
    repo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("atomic recording and monotonic guards: applied, stale rejection, future rejection, duplicate rejection", async () => {
  const { tmpDir, repo } = setupTestEnvironment();
  try {
    await repo.migrate();

    const node = await repo.createNode({
      name: "node-worker-3",
      wireguardIp: "10.77.0.13",
      desired_revision: 3,
    });

    // 1. Future revision rejection (rev 4 > desired 3)
    const futureOutcome = await repo.recordDeploymentResult({
      nodeId: node.id,
      revision: 4,
      configDigest: "sha256-future",
      status: "applied",
    });
    assert.equal(futureOutcome.ok, false);
    assert.equal(futureOutcome.accepted, false);
    assert.equal(futureOutcome.reason, "future_revision");

    // 2. Applied revision 2 (< desired 3) -> status remains pending
    const partialOutcome = await repo.recordDeploymentResult({
      nodeId: node.id,
      revision: 2,
      configDigest: "sha256-rev2",
      status: "applied",
    });
    assert.equal(partialOutcome.ok, true);
    assert.equal(partialOutcome.accepted, true);

    let fetched = await repo.getNode(node.id);
    assert.equal(fetched?.configuration.appliedRevision, 2);
    assert.equal(fetched?.configuration.deploymentRevision, 2);
    assert.equal(fetched?.configuration.status, "pending");

    // 3. Stale revision rejection (rev 1 < watermark 2)
    const staleOutcome = await repo.recordDeploymentResult({
      nodeId: node.id,
      revision: 1,
      configDigest: "sha256-rev1",
      status: "applied",
    });
    assert.equal(staleOutcome.ok, true);
    assert.equal(staleOutcome.accepted, false);
    assert.equal(staleOutcome.reason, "stale_revision");

    // 4. Convergence to desired (rev 3 === desired 3)
    const convergenceOutcome = await repo.recordDeploymentResult({
      nodeId: node.id,
      revision: 3,
      configDigest: "sha256-rev3",
      status: "applied",
    });
    assert.equal(convergenceOutcome.ok, true);
    assert.equal(convergenceOutcome.accepted, true);

    fetched = await repo.getNode(node.id);
    assert.equal(fetched?.configuration.status, "applied");
    assert.equal(fetched?.configuration.appliedRevision, 3);
    assert.equal(fetched?.configuration.deploymentRevision, 3);
    assert.equal(fetched?.configuration.error, null);

    // 5. Duplicate revision rejection (rev 3 already applied)
    const duplicateOutcome = await repo.recordDeploymentResult({
      nodeId: node.id,
      revision: 3,
      configDigest: "sha256-rev3",
      status: "applied",
    });
    assert.equal(duplicateOutcome.ok, true);
    assert.equal(duplicateOutcome.accepted, false);
    assert.equal(duplicateOutcome.reason, "duplicate_revision");

    // Verify deployments history
    const deployments = await repo.getNodeDeployments(node.id);
    assert.equal(deployments.length, 2); // rev 2 and rev 3
    assert.equal(deployments[0].revision, 3);
    assert.equal(deployments[1].revision, 2);
  } finally {
    repo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("same-revision retry: failed result followed by applied result supersedes failure", async () => {
  const { tmpDir, repo } = setupTestEnvironment();
  try {
    await repo.migrate();

    const node = await repo.createNode({
      name: "node-worker-4",
      wireguardIp: "10.77.0.14",
      desired_revision: 2,
    });

    // 1. Initial failure at rev 2
    const failOutcome = await repo.recordDeploymentResult({
      nodeId: node.id,
      revision: 2,
      configDigest: "sha256-bad",
      status: "failed",
      errorMessage: "syntax error in 3proxy.cfg",
    });
    assert.equal(failOutcome.ok, true);
    assert.equal(failOutcome.accepted, true);

    let fetched = await repo.getNode(node.id);
    assert.equal(fetched?.configuration.status, "failed");
    assert.equal(fetched?.configuration.error, "syntax error in 3proxy.cfg");
    assert.equal(fetched?.configuration.appliedRevision, null);
    assert.equal(fetched?.configuration.deploymentRevision, 2);

    // 2. Duplicate failed report is rejected
    const dupFail = await repo.recordDeploymentResult({
      nodeId: node.id,
      revision: 2,
      configDigest: "sha256-bad",
      status: "failed",
      errorMessage: "syntax error in 3proxy.cfg",
    });
    assert.equal(dupFail.ok, true);
    assert.equal(dupFail.accepted, false);
    assert.equal(dupFail.reason, "duplicate_revision");

    // 3. Retry with applied supersedes failed
    const retryOutcome = await repo.recordDeploymentResult({
      nodeId: node.id,
      revision: 2,
      configDigest: "sha256-good",
      status: "applied",
    });
    assert.equal(retryOutcome.ok, true);
    assert.equal(retryOutcome.accepted, true);

    fetched = await repo.getNode(node.id);
    assert.equal(fetched?.configuration.status, "applied");
    assert.equal(fetched?.configuration.error, null);
    assert.equal(fetched?.configuration.appliedRevision, 2);
    assert.equal(fetched?.configuration.deploymentRevision, 2);
  } finally {
    repo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("decoupling invariant: deployment failure never changes node liveness or heartbeat status", async () => {
  const { tmpDir, repo } = setupTestEnvironment();
  try {
    await repo.migrate();

    const node = await repo.createNode({
      name: "node-worker-5",
      wireguardIp: "10.77.0.15",
      desired_revision: 1,
    });

    // Mark online via heartbeat
    await repo.recordHeartbeat(node.id, {
      status: "online",
      cpuUsage: 10,
    });

    let fetched = await repo.getNode(node.id);
    assert.equal(fetched?.status, "online");
    const originalHeartbeat = fetched?.last_heartbeat_at;
    assert.ok(originalHeartbeat);

    // Deployment fails
    await repo.recordDeploymentResult({
      nodeId: node.id,
      revision: 1,
      configDigest: "sha256-crash",
      status: "failed",
      errorMessage: "process crash",
    });

    fetched = await repo.getNode(node.id);
    // Node liveness MUST remain online
    assert.equal(fetched?.status, "online");
    assert.equal(fetched?.last_heartbeat_at, originalHeartbeat);
    assert.equal(fetched?.configuration.status, "failed");
  } finally {
    repo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("API endpoint /api/fleet/agent/deployment-result validation and response contract", async () => {
  const { tmpDir, repo } = setupTestEnvironment();
  await repo.migrate();

  const handleApi = createFleetApiHandler({
    repo,
    verifyAuth: (pass) => pass === "admin-pass",
  });

  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    const handled = await handleApi(req, res, pathname);
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  });

  const { promise: listenPromise, resolve: listenResolve } = Promise.withResolvers<number>();
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as AddressInfo).port;
    listenResolve(port);
  });
  const port = await listenPromise;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const node = await repo.createNode({
      name: "node-worker-api",
      wireguardIp: "10.77.0.16",
      desired_revision: 2,
    });
    const agentToken = "fla_testagenttoken123456789012345";
    await repo.setNodeAgentToken(node.id, agentToken);

    // 1. Unauthorized request returns 401
    const unauthRes = await fetch(`${baseUrl}/api/fleet/agent/deployment-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodeId: node.id,
        revision: 1,
        configDigest: "digest",
        status: "applied",
      }),
    });
    assert.equal(unauthRes.status, 401);

    // 2. Bad input validation returns 400
    const invalidRevRes = await fetch(`${baseUrl}/api/fleet/agent/deployment-result`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agentToken}`,
      },
      body: JSON.stringify({
        nodeId: node.id,
        revision: -1,
        configDigest: "digest",
        status: "applied",
      }),
    });
    assert.equal(invalidRevRes.status, 400);

    // 3. Future revision returns 400 with reason: future_revision
    const futureRes = await fetch(`${baseUrl}/api/fleet/agent/deployment-result`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agentToken}`,
      },
      body: JSON.stringify({
        nodeId: node.id,
        revision: 99,
        configDigest: "digest",
        status: "applied",
      }),
    });
    assert.equal(futureRes.status, 400);
    const futureBody = await futureRes.json();
    assert.equal(futureBody.reason, "future_revision");

    // 4. Valid applied revision 1 returns 200 with accepted: true
    const validRes = await fetch(`${baseUrl}/api/fleet/agent/deployment-result`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agentToken}`,
      },
      body: JSON.stringify({
        nodeId: node.id,
        revision: 1,
        configDigest: "digest-1",
        status: "applied",
      }),
    });
    assert.equal(validRes.status, 200);
    const validBody = await validRes.json();
    assert.equal(validBody.ok, true);
    assert.equal(validBody.accepted, true);

    // 5. Stale revision (rev 0 or watermark check)
    // Advance to rev 2
    await repo.recordDeploymentResult({
      nodeId: node.id,
      revision: 2,
      configDigest: "digest-2",
      status: "applied",
    });

    const staleRes = await fetch(`${baseUrl}/api/fleet/agent/deployment-result`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agentToken}`,
      },
      body: JSON.stringify({
        nodeId: node.id,
        revision: 1,
        configDigest: "digest-1",
        status: "applied",
      }),
    });
    assert.equal(staleRes.status, 200);
    const staleBody = await staleRes.json();
    assert.equal(staleBody.accepted, false);
    assert.equal(staleBody.reason, "stale_revision");

    // 6. GET /api/fleet/nodes/:id includes deployments and configuration
    const getNodeRes = await fetch(`${baseUrl}/api/fleet/nodes/${node.id}`, {
      headers: {
        Authorization: "Bearer admin-pass",
      },
    });
    assert.equal(getNodeRes.status, 200);
    const nodeDetails = await getNodeRes.json();
    assert.ok(nodeDetails.node);
    assert.equal(nodeDetails.node.configuration.status, "applied");
    assert.equal(nodeDetails.node.configuration.appliedRevision, 2);
    assert.ok(Array.isArray(nodeDetails.deployments));
    assert.ok(nodeDetails.deployments.length >= 2);
  } finally {
    server.close();
    repo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
