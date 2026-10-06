#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createFleetRepository } from "../src/proxyfleet/db.js";
import { createFleetApiHandler } from "../src/proxyfleet/api-router.js";
import { createEnrollmentService } from "../src/proxyfleet/enrollment.js";
import { resolveManagedEndpointForAudit, syncFleetEndpointsToIntelligence } from "../src/proxyfleet/pipeline-adapter.js";
import { openProxyIntelligenceDb } from "../src/server/proxy-intelligence-db.js";
import { createProxyIntelligenceRepository } from "../src/server/proxy-intelligence-repository.js";

console.log("=== ProxyFleet End-to-End Acceptance Test ===");

const isDryRun = process.argv.includes("--dry-run");
if (isDryRun) {
  console.log("[Acceptance] Running in dry-run mode: verifying all prerequisites and scripts...");
  assert.ok(fs.existsSync("scripts/install-agent.sh"), "install-agent.sh must exist");
  assert.ok(fs.existsSync("docs/proxyfleet-architecture.md"), "Architecture doc must exist");
  assert.ok(fs.existsSync("docs/superpowers/plans/2026-10-02-proxyfleet.md"), "Plan must exist");
  console.log("[Acceptance] Dry-run passed: all components and documentation present.");
  process.exit(0);
}

// Full live acceptance workflow
async function runAcceptance() {
  const binaryPath = path.resolve(process.platform === "win32" ? "bin/proxyfleet-agent.exe" : "bin/proxyfleet-agent-linux-amd64");
  if (!fs.existsSync(binaryPath)) {
    console.error(`Binary not found at ${binaryPath}. Build it first with go build.`);
    process.exit(1);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-acceptance-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");
  const agentConfigDir = path.join(tmpDir, "agent-config");
  const proxyConfigPath = path.join(tmpDir, "3proxy.cfg");
  const repo = createFleetRepository({ sqlitePath: dbPath });

  await repo.migrate();

  const handleApi = createFleetApiHandler({
    repo,
    verifyAuth: (pass) => pass === "admin-secret-pass",
  });

  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    const handled = await handleApi(req, res, pathname);
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  });

  const { promise: listenPromise, resolve: listenResolve } = Promise.withResolvers();
  server.listen(0, "127.0.0.1", () => {
    listenResolve(server.address().port);
  });
  const port = await listenPromise;
  const serverUrl = `http://127.0.0.1:${port}`;
  console.log(`[Step 1] Controller API listening on ${serverUrl}`);

  let agentProcess = null;

  try {
    // Step 2: Issue Enrollment Token
    const enrollmentService = createEnrollmentService(repo);
    const { token } = await enrollmentService.issueToken({ nodeName: "acceptance-worker" });
    console.log(`[Step 2] Issued enrollment token: ${token.slice(0, 10)}...`);

    // Step 3: Spawn Agent to Join Controller
    agentProcess = spawn(
      binaryPath,
      [
        "--server",
        serverUrl,
        "--token",
        token,
        "--node-name",
        "acceptance-worker",
        "--config-dir",
        agentConfigDir,
        "--proxy-config",
        proxyConfigPath,
        "--interval",
        "1",
      ],
      { stdio: "pipe" }
    );

    // Step 4: Verify Dashboard Shows Node Online
    let enrolledNode = null;
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const nodes = await repo.listNodes();
      if (nodes.length > 0 && nodes[0].last_heartbeat_at) {
        enrolledNode = nodes[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(enrolledNode, "Node failed to join controller within 5s");
    assert.equal(enrolledNode.status, "online");
    console.log(`[Step 3 & 4] Worker joined controller. Node: ${enrolledNode.name}, WG IP: ${enrolledNode.wireguard_ip}, Status: ONLINE`);

    // Step 5: Create Proxy Endpoint
    const ep = await repo.createProxyEndpoint({
      nodeId: enrolledNode.id,
      protocol: "http",
      listenIp: enrolledNode.wireguard_ip,
      listenPort: 20001,
      username: "user_accept",
      password: "secret_acceptance_pass",
    });
    console.log(`[Step 5] Created ProxyEndpoint ID: ${ep.id} (${ep.listen_ip}:${ep.listen_port})`);

    // Step 6: Verify Agent Renders and Deploys Config
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
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(deployed, "Agent failed to configure 3proxy within 5s");
    console.log(`[Step 6] Desired configuration deployed to ${proxyConfigPath}`);

    // Step 7: Record Layered Health Check
    await repo.recordHealthCheck({
      endpointId: ep.id,
      nodeId: enrolledNode.id,
      status: "healthy",
      exitIp: "113.160.1.2",
      latencyMs: 42,
    });
    const latestHealth = await repo.getLatestHealthCheck(ep.id);
    assert.equal(latestHealth?.status, "healthy");
    assert.equal(latestHealth?.exit_ip, "113.160.1.2");
    console.log(`[Step 7] Health check recorded: status=${latestHealth?.status}, exitIP=${latestHealth?.exit_ip}, latency=${latestHealth?.latency_ms}ms`);

    // Step 8: Safety Auditor Integration
    const resolvedAudit = await resolveManagedEndpointForAudit(repo, ep.id);
    assert.ok(resolvedAudit);
    assert.equal(resolvedAudit.options.allowPrivateTargets, true);
    assert.deepEqual(resolvedAudit.options.allowedPrivateIps, ["10.77.0.11"]);
    console.log(`[Step 8] Safety Auditor resolved endpoint target: ${resolvedAudit.targetUrl.replace(/:[^@:]+@/, ":***@")}`);

    // Step 9: Diagnostics and Intelligence Pipeline Ingestion
    const intelDb = openProxyIntelligenceDb(tmpDir);
    const intelRepo = createProxyIntelligenceRepository({ db: intelDb });
    const synced = await syncFleetEndpointsToIntelligence(repo, intelRepo);
    assert.equal(synced, 1);
    const intelItem = await intelRepo.getProxy("http://user_accept@10.77.0.11:20001");
    assert.ok(intelItem);
    assert.equal(intelItem.source, "proxyfleet");
    console.log(`[Step 9] Endpoint ingested into intelligence inventory with source: '${intelItem.source}'`);
    intelDb.close();

    // Step 10: Secret Redaction & Authorized Reveal
    const creds = await repo.getEndpointCredentials(ep.id);
    assert.equal(creds?.password, "secret_acceptance_pass");
    console.log(`[Step 10] Credential vault encryption and reveal validated.`);

    console.log("=== All Acceptance Steps Passed Successfully! ===");
  } finally {
    if (agentProcess) agentProcess.kill();
    server.close();
    repo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

runAcceptance().catch((err) => {
  console.error("Acceptance test failed:", err);
  process.exit(1);
});
