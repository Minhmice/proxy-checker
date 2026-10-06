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
    const service = createEnrollmentService(repo);

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
      wireguardPublicKey: "test-client-pubkey-base64",
      publicIp: "113.160.1.2",
      os: "Ubuntu 24.04",
      arch: "x86_64",
      agentVersion: "0.1.0",
    });

    assert.ok(enrolled.nodeId);
    assert.equal(enrolled.wireguardIp, "10.77.0.11");
    assert.equal(enrolled.serverWireguardPublicKey.length > 0, true);

    // 3. Re-using same token must fail
    await assert.rejects(
      service.enrollNode({
        token: tokenResult.token,
        nodeName: "worker-001",
        wireguardPublicKey: "another-pubkey",
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
