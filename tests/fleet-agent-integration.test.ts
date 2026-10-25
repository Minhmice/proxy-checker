import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createFleetRepository } from "../src/proxyfleet/db.js";
import { createFleetApiHandler } from "../src/proxyfleet/api-router.js";
import { createFleetRuntimeApi } from "../src/proxyfleet/runtime-api.js";
import { createEnrollmentService } from "../src/proxyfleet/enrollment.js";

const pollIntervalMs = 100;
const conditionTimeoutMs = 15_000;
const outputLimitBytes = 8_192;

// External Go time.Ticker and process startup use the real clock; fake timers cannot advance them.
function waitForTick(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function waitForCondition<T>(
  description: string,
  read: () => Promise<T>,
  condition: (value: T) => boolean,
  diagnostics: () => string,
  timeoutMs = conditionTimeoutMs,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T;
  do {
    lastValue = await read();
    if (condition(lastValue)) return lastValue;
    await waitForTick(pollIntervalMs);
  } while (Date.now() < deadline);
  throw new Error(
    `${description} timed out after ${timeoutMs}ms. Last value: ${JSON.stringify(lastValue)}. ${diagnostics()}`,
  );
}

function readBody(request: IncomingMessage, maxBytes = 65_536): Promise<Record<string, unknown>> {
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
  const chunks: Buffer[] = [];
  let size = 0;
  request.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > maxBytes) {
      reject(new Error("Request payload too large"));
      request.destroy();
    } else chunks.push(chunk);
  });
  request.on("end", () => {
    try {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      const value: unknown = text ? JSON.parse(text) : {};
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Expected JSON object");
      resolve(value as Record<string, unknown>);
    } catch (error) {
      reject(error);
    }
  });
  request.on("error", reject);
  return promise;
}

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
  });
  response.end(payload);
}

const linuxArch =
  process.arch === "x64"
    ? "amd64"
    : process.arch === "arm64"
      ? "arm64"
      : process.arch === "arm"
        ? "armv7"
        : process.arch;
const agentBinaryPath = path.resolve(
  "bin",
  process.platform === "win32" ? "proxyfleet-agent.exe" : `proxyfleet-agent-linux-${linuxArch}`,
);

function trackOutput(child: ChildProcess, secrets: string[]): { output: () => string } {
  let captured = "";
  const append = (chunk: Buffer | string) => {
    captured = (captured + chunk.toString()).slice(-outputLimitBytes);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return {
    output: () => {
      let safe = captured;
      for (const secret of secrets) if (secret) safe = safe.replaceAll(secret, "[REDACTED]");
      return safe.slice(-outputLimitBytes);
    },
  };
}

function spawnAgent(
  binary: string,
  args: string[],
  secrets: string[],
): { child: ChildProcess; output: () => string } {
  const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
  const tracked = trackOutput(child, secrets);
  return { child, output: tracked.output };
}

async function stopAgent(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const { promise: exited, resolve } = Promise.withResolvers<void>();
  child.once("exit", () => resolve());
  child.kill();
  const { promise: timedOut, resolve: resolveTimeout } = Promise.withResolvers<false>();
  const timeout = setTimeout(() => resolveTimeout(false), 3_000);
  const didExit = await Promise.race([exited.then(() => true), timedOut]);
  clearTimeout(timeout);
  if (!didExit && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

test("Go agent enrolls, reports unavailable overlay honestly, reconnects, and accepts rotated credentials", async () => {
  assert.ok(
    fs.existsSync(agentBinaryPath),
    `Build the Go agent binary before running Fleet integration: ${agentBinaryPath}`,
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-agent-integration-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");
  const agentConfigDir = path.join(tmpDir, "agent-config");
  const proxyConfigPath = path.join(tmpDir, "3proxy.cfg");
  const repo = createFleetRepository({ sqlitePath: dbPath });
  await repo.migrate();

  const handleFleetApi = createFleetApiHandler({
    repo,
    verifyAuth: (pass) => pass === "control-pass-123",
    enrollmentOptions: {
      serverWireguardPublicKey: Buffer.alloc(32, 7).toString("base64"),
      serverWireguardEndpoint: "127.0.0.1:51820",
    },
  });
  const handleRuntimeApi = createFleetRuntimeApi({
    repo,
    getWireguard: () => null,
    readBody,
    send: (response, body, status = 200) => sendJson(response, body, status),
  });
  // Never serve an empty revision: it could ask the real daemon to reload host 3proxy.
  const { promise: endpointReady, resolve: markEndpointReady } = Promise.withResolvers<void>();
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url || "/", "http://localhost").pathname;
    try {
      if (request.method === "GET" && pathname === "/api/fleet/agent/desired-state")
        await endpointReady;
      const handled =
        (await handleRuntimeApi(request, response, pathname)) ||
        (await handleFleetApi(request, response, pathname));
      if (!handled) sendJson(response, { error: "Not found" }, 404);
    } catch (error) {
      if (!response.headersSent)
        sendJson(
          response,
          { error: error instanceof Error ? error.message : "Request failed" },
          500,
        );
      else response.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const serverUrl = `http://127.0.0.1:${port}`;
  const listener = http.createServer((_request, response) => response.end("probe"));
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolve());
  });
  const listenerPort = (listener.address() as AddressInfo).port;

  let agentProcess: ChildProcess | null = null;
  let restartedAgent: ChildProcess | null = null;
  let rotatedAgent: ChildProcess | null = null;
  let agentOutput = () => "";
  let restartOutput = () => "";
  let rotatedOutput = () => "";
  const secrets: string[] = [];

  try {
    const enrollmentService = createEnrollmentService(repo, {
      serverWireguardPublicKey: Buffer.alloc(32, 7).toString("base64"),
      serverWireguardEndpoint: "127.0.0.1:51820",
    });
    const { token: enrollmentToken } = await enrollmentService.issueToken({
      nodeName: "integration-worker-01",
    });
    const child = spawnAgent(
      agentBinaryPath,
      [
        "--server",
        serverUrl,
        "--token",
        enrollmentToken,
        "--node-name",
        "integration-worker-01",
        "--config-dir",
        agentConfigDir,
        "--proxy-config",
        proxyConfigPath,
        "--interval",
        "1",
      ],
      secrets,
    );
    agentProcess = child.child;
    agentOutput = child.output;

    const enrolledNode = await waitForCondition(
      "Agent enrollment and heartbeat",
      () => repo.listNodes(),
      (nodes) =>
        nodes.length === 1 &&
        nodes[0].name === "integration-worker-01" &&
        !!nodes[0].last_heartbeat_at &&
        !!nodes[0].runtime,
      () => `agent output: ${agentOutput()}`,
    );
    const node = enrolledNode[0];
    const initialRuntime = enrolledNode[0].runtime!;
    assert.ok(initialRuntime.sequence > 0, "agent must send actual telemetry sequence");
    const initialState = JSON.parse(
      fs.readFileSync(path.join(agentConfigDir, "state.json"), "utf8"),
    ) as {
      agent_token: string;
      node_id: string;
      last_revision: number;
    };
    assert.equal(typeof initialState.agent_token, "string");
    assert.equal(initialState.node_id, node.id);
    const originalToken = initialState.agent_token;
    secrets.push(originalToken);

    const reusedEnrollment = await fetch(`${serverUrl}/api/fleet/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: enrollmentToken,
        nodeName: "integration-worker-01",
        wireguardPublicKey: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
      }),
    });
    assert.equal(
      reusedEnrollment.status,
      400,
      "consumed enrollment token must not enroll another node",
    );
    assert.equal((await repo.listNodes()).length, 1);

    const endpoint = await repo.createProxyEndpoint({
      nodeId: node.id,
      protocol: "http",
      listenIp: node.wireguard_ip,
      listenPort: listenerPort,
      username: "user1",
      password: "pass1",
    });
    assert.equal(
      endpoint.listenIp,
      node.wireguard_ip,
      "overlay endpoint must bind the enrolled node WireGuard address",
    );
    markEndpointReady();

    const failedDeployment = await waitForCondition(
      "Overlay deployment failure report",
      async () => {
        const freshNode = await repo.getNode(node.id);
        return { node: freshNode, results: await repo.getNodeDeployments(node.id) };
      },
      (value) =>
        value.results.some(
          (result) =>
            result.status === "failed" && !!result.config_digest && !!result.error_message,
        ) && value.node?.runtime?.activity.kind === "error",
      () => `agent output: ${agentOutput()}`,
    );
    const failedResult = failedDeployment.results.find((result) => result.status === "failed")!;
    assert.ok(
      failedResult.config_digest.trim().length > 0,
      "failed overlay deployment needs a real config digest",
    );
    assert.ok(failedResult.error_message?.trim(), "failed overlay deployment needs a reason");
    assert.match(failedResult.error_message!, /WireGuard/i);
    assert.ok(
      failedDeployment.node?.last_heartbeat_at,
      "failed deployment must preserve authenticated heartbeat liveness",
    );
    assert.ok(
      failedDeployment.node?.runtimeReceivedAt,
      "failed deployment must preserve runtime telemetry liveness",
    );
    assert.equal(failedDeployment.node?.configuration.status, "failed");
    assert.equal(
      failedDeployment.node?.applied_revision,
      null,
      "failed overlay deployment must not advance applied revision",
    );

    const authenticated = await fetch(
      `${serverUrl}/api/fleet/agent/desired-state?nodeId=${node.id}`,
      {
        headers: { Authorization: `Bearer ${originalToken}` },
      },
    );
    assert.equal(authenticated.status, 200);
    const rawWithoutAuth = await fetch(
      `${serverUrl}/api/fleet/agent/desired-state?nodeId=${node.id}`,
    );
    assert.equal(rawWithoutAuth.status, 401);

    await stopAgent(agentProcess);
    agentProcess = null;
    const heartbeatBeforeRestart = (await repo.getNode(node.id))!.last_heartbeat_at || 0;
    const restart = spawnAgent(
      agentBinaryPath,
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
      secrets,
    );
    restartedAgent = restart.child;
    restartOutput = restart.output;
    const reconnectedNode = await waitForCondition(
      "Post-restart authenticated heartbeat and telemetry session",
      () => repo.getNode(node.id),
      (freshNode) =>
        !!freshNode?.last_heartbeat_at &&
        freshNode.last_heartbeat_at > heartbeatBeforeRestart &&
        !!freshNode.runtime &&
        freshNode.runtime.sessionId !== initialRuntime.sessionId &&
        freshNode.runtime.sequence > 0,
      () => `agent output: ${restartOutput()}`,
    );
    assert.notEqual(
      reconnectedNode?.runtime?.sessionId,
      initialRuntime.sessionId,
      "restart must establish new telemetry session",
    );
    const stateAfterRestart = JSON.parse(
      fs.readFileSync(path.join(agentConfigDir, "state.json"), "utf8"),
    ) as typeof initialState;
    assert.equal(stateAfterRestart.node_id, node.id, "restart must retain enrolled identity");
    assert.equal(
      stateAfterRestart.agent_token,
      originalToken,
      "restart must reconnect with saved credential",
    );
    await stopAgent(restartedAgent);
    restartedAgent = null;

    const rotatedResponse = await fetch(`${serverUrl}/api/fleet/nodes/${node.id}/agent-token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from("admin:control-pass-123").toString("base64")}`,
      },
    });
    assert.equal(rotatedResponse.status, 200);
    const rotatedPayload = (await rotatedResponse.json()) as { nodeId: string; agentToken: string };
    assert.equal(rotatedPayload.nodeId, node.id);
    assert.ok(rotatedPayload.agentToken);
    secrets.push(rotatedPayload.agentToken);

    const oldCredential = await fetch(
      `${serverUrl}/api/fleet/agent/desired-state?nodeId=${node.id}`,
      {
        headers: { Authorization: `Bearer ${originalToken}` },
      },
    );
    assert.equal(oldCredential.status, 401, "credential rotation must reject prior token");
    const oldHeartbeat = await fetch(`${serverUrl}/api/fleet/agent/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${originalToken}` },
      body: JSON.stringify({ nodeId: node.id, status: "online" }),
    });
    assert.equal(oldHeartbeat.status, 401, "prior token must not refresh node liveness");

    const heartbeatBeforeRotation = (await repo.getNode(node.id))!.last_heartbeat_at || 0;
    const rotated = spawnAgent(
      agentBinaryPath,
      [
        "--server",
        serverUrl,
        "--agent-token",
        rotatedPayload.agentToken,
        "--config-dir",
        agentConfigDir,
        "--proxy-config",
        proxyConfigPath,
        "--interval",
        "1",
      ],
      secrets,
    );
    rotatedAgent = rotated.child;
    rotatedOutput = rotated.output;
    const rotatedNode = await waitForCondition(
      "Rotated credential heartbeat",
      () => repo.getNode(node.id),
      (freshNode) =>
        !!freshNode?.last_heartbeat_at && freshNode.last_heartbeat_at > heartbeatBeforeRotation,
      () => `agent output: ${rotatedOutput()}`,
    );
    const stateAfterRotation = JSON.parse(
      fs.readFileSync(path.join(agentConfigDir, "state.json"), "utf8"),
    ) as typeof initialState;
    assert.equal(stateAfterRotation.agent_token, rotatedPayload.agentToken);
    assert.equal(
      stateAfterRotation.node_id,
      node.id,
      "credential rotation must preserve node identity",
    );
    assert.equal(
      stateAfterRotation.last_revision,
      initialState.last_revision,
      "credential rotation must preserve desired revision state",
    );
    assert.equal(rotatedNode?.id, node.id);
    assert.equal(
      (
        await fetch(`${serverUrl}/api/fleet/agent/desired-state?nodeId=${node.id}`, {
          headers: { Authorization: `Bearer ${rotatedPayload.agentToken}` },
        })
      ).status,
      200,
    );
  } finally {
    markEndpointReady();
    await stopAgent(agentProcess);
    await stopAgent(restartedAgent);
    await stopAgent(rotatedAgent);
    const { promise: serverClosed, resolve: resolveServerClosed } = Promise.withResolvers<void>();
    server.close(() => resolveServerClosed());
    await serverClosed;
    const { promise: listenerClosed, resolve: resolveListenerClosed } =
      Promise.withResolvers<void>();
    listener.close(() => resolveListenerClosed());
    await listenerClosed;
    repo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
