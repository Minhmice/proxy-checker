import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createFleetRepository } from "../src/proxyfleet/db.js";
import { createFleetApiHandler } from "../src/proxyfleet/api-router.js";
import { createEnrollmentService } from "../src/proxyfleet/enrollment.js";

// Exception: integration test running an external child process (compiled Go binary)
// communicating over loopback sockets where fake timers cannot control the external binary's internal time.Ticker.
function waitForProcessTick(ms = 100): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

test("Go agent binary enrolls, heartbeats, polls desired state, and reconnects from disk state", async () => {
  const binaryPath = path.resolve("bin/proxyfleet-agent.exe");
  if (!fs.existsSync(binaryPath)) {
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-agent-smoke-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");
  const agentConfigDir = path.join(tmpDir, "agent-config");
  const proxyConfigPath = path.join(tmpDir, "3proxy.cfg");
  const repo = createFleetRepository({ sqlitePath: dbPath });

  await repo.migrate();

  const handleApi = createFleetApiHandler({
    repo,
    verifyAuth: (pass) => pass === "control-pass-123",
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
  const serverUrl = `http://127.0.0.1:${port}`;

  let agentProcess: ChildProcess | null = null;
  let restartedAgent: ChildProcess | null = null;

  try {
    // 1. Issue an enrollment token via service
    const enrollmentService = createEnrollmentService(repo);
    const { token } = await enrollmentService.issueToken({ nodeName: "smoke-worker-01" });
    assert.ok(token);

    // 2. Spawn the Go agent binary to perform initial enrollment
    agentProcess = spawn(
      binaryPath,
      [
        "--server",
        serverUrl,
        "--token",
        token,
        "--node-name",
        "smoke-worker-01",
        "--config-dir",
        agentConfigDir,
        "--proxy-config",
        proxyConfigPath,
        "--interval",
        "1",
      ],
      { stdio: "pipe" }
    );

    // Wait up to 5s for the node to appear online in DB
    let enrolledNode = null;
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const nodes = await repo.listNodes();
      if (nodes.length > 0 && nodes[0].last_heartbeat_at) {
        enrolledNode = nodes[0];
        break;
      }
      await waitForProcessTick(150);
    }

    assert.ok(enrolledNode, "Node failed to enroll within 5s");
    assert.equal(enrolledNode.name, "smoke-worker-01");
    assert.equal(enrolledNode.status, "online");

    // 3. Create a proxy endpoint for this node
    await repo.createProxyEndpoint({
      nodeId: enrolledNode.id,
      protocol: "http",
      listenIp: "10.77.0.11",
      listenPort: 20001,
      username: "user1",
      password: "pass1",
    });

    // Wait for the agent to render and deploy 3proxy.cfg
    let deployed = false;
    const deployStart = Date.now();
    while (Date.now() - deployStart < 5000) {
      if (fs.existsSync(proxyConfigPath)) {
        const content = fs.readFileSync(proxyConfigPath, "utf8");
        if (content.includes("proxy -p20001 -i10.77.0.11")) {
          deployed = true;
          break;
        }
      }
      await waitForProcessTick(150);
    }
    assert.ok(deployed, "Agent failed to write 3proxy config within 5s");

    // 4. Kill the agent process cleanly
    agentProcess.kill();
    agentProcess = null;

    // 5. Restart agent WITHOUT --token to prove reconnect from state.json
    restartedAgent = spawn(
      binaryPath,
      [
        "--server",
        serverUrl,
        "--config-dir",
        agentConfigDir,
        "--proxy-config",
        proxyConfigPath,
        "--interval",
        "1",
      ],
      { stdio: "pipe" }
    );

    // Verify heartbeat updates after restart
    const initialHeartbeat = enrolledNode.last_heartbeat_at || 0;
    let reconnected = false;
    const reconnectStart = Date.now();
    while (Date.now() - reconnectStart < 5000) {
      const freshNode = await repo.getNode(enrolledNode.id);
      if (freshNode && (freshNode.last_heartbeat_at || 0) > initialHeartbeat) {
        reconnected = true;
        break;
      }
      await waitForProcessTick(150);
    }
    assert.ok(reconnected, "Agent failed to reconnect and send heartbeat from saved state");

    restartedAgent.kill();
    restartedAgent = null;
  } finally {
    if (agentProcess) agentProcess.kill();
    if (restartedAgent) restartedAgent.kill();
    server.close();
    repo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
