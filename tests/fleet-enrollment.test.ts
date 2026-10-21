import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createFleetRepository } from "../src/proxyfleet/db.js";
import { createEnrollmentService } from "../src/proxyfleet/enrollment.js";

test("enrollment service creates expiring tokens, consumes once, and provisions node", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-enrollment-test-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");
  const repo = createFleetRepository({ sqlitePath: dbPath });

  try {
    await repo.migrate();
    const service = createEnrollmentService(repo, {
      serverWireguardPublicKey: "OTk5OTk5OTlBQUFBQUFBQUJCQkJCQkJCQ0NDQ0NDQ0M=",
      serverWireguardEndpoint: "198.51.100.1:51820",
    });
    // 1. Issue token
    const tokenResult = await service.issueToken({
      nodeName: "worker-001",
      ttlMinutes: 15,
    });

    assert.ok(tokenResult.token);
    assert.equal(tokenResult.nodeName, "worker-001");
    assert.ok(tokenResult.expiresAt > Date.now());

    // 2. Consume token to register node
    const enrolled = await service.enrollNode({
      token: tokenResult.token,
      nodeName: "worker-001",
      wireguardPublicKey: "MTExMTExMTEyMjIyMjIyMjMzMzMzMzMzNDQ0NDQ0NDQ=",
      publicIp: "113.160.1.2",
      os: "Ubuntu 24.04",
      arch: "x86_64",
      agentVersion: "0.1.0",
    });

    assert.ok(enrolled.nodeId);
    assert.equal(enrolled.wireguardIp, "10.77.0.11");
    assert.equal(enrolled.serverWireguardPublicKey.length > 0, true);
    assert.equal(await repo.verifyNodeAgentToken(enrolled.nodeId, enrolled.agentToken), true);
    assert.equal(await repo.verifyNodeAgentToken(enrolled.nodeId, tokenResult.token), false);
    assert.equal(JSON.stringify(await repo.getNode(enrolled.nodeId)).includes(enrolled.agentToken), false);
    assert.equal(JSON.stringify(await repo.listEvents({ nodeId: enrolled.nodeId })).includes(enrolled.agentToken), false);

    // 3. Re-using same token must fail
    await assert.rejects(
      service.enrollNode({
        token: tokenResult.token,
        nodeName: "worker-001",
        wireguardPublicKey: "NTU1NTU1NTU2NjY2NjY2Njc3Nzc3Nzc3ODg4ODg4ODg=",
      }),
      /token already consumed or expired/i
    );

    // 4. Node should now be in DB
    const node = await repo.getNode(enrolled.nodeId);
    assert.ok(node);
    assert.equal(node.name, "worker-001");
    assert.equal(node.wireguardIp, "10.77.0.11");
  } finally {
    repo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
test("enrollNode rejects when wireguard server config is missing without consuming token", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-enrollment-missing-wg-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");
  const repo = createFleetRepository({ sqlitePath: dbPath });

  try {
    await repo.migrate();
    const service = createEnrollmentService(repo);

    const tokenResult = await service.issueToken({ nodeName: "worker-preflight" });
    assert.ok(tokenResult.token);

    // enrollNode fails with actionable message
    await assert.rejects(
      async () => {
        await service.enrollNode({
          token: tokenResult.token,
          nodeName: "worker-preflight",
          wireguardPublicKey: "MTExMTExMTEyMjIyMjIyMjMzMzMzMzMzNDQ0NDQ0NDQ=",
        });
      },
      /WireGuard server configuration missing/i
    );

    // Token was NOT consumed because error was raised preflight
    const configuredService = createEnrollmentService(repo, {
      serverWireguardPublicKey: "OTk5OTk5OTlBQUFBQUFBQUJCQkJCQkJCQ0NDQ0NDQ0M=",
      serverWireguardEndpoint: "198.51.100.1:51820",
    });

    const enrolled = await configuredService.enrollNode({
      token: tokenResult.token,
      nodeName: "worker-preflight",
      wireguardPublicKey: "MTExMTExMTEyMjIyMjIyMjMzMzMzMzMzNDQ0NDQ0NDQ=",
    });
    assert.ok(enrolled.nodeId);
  } finally {
    repo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
