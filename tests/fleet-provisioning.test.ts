import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFleetRepository } from "../src/proxyfleet/db.js";
import { createProvisioningService } from "../src/proxyfleet/provisioning.js";

test("provisioning service creates node, validates public IP, and activates on verified unique IP", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-prov-test-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");
  const repo = createFleetRepository({ sqlitePath: dbPath });

  try {
    await repo.migrate();

    let executedCommands: string[] = [];
    const mockSshFactory = () => ({
      async execute(cmd: string) {
        executedCommands.push(cmd);
        return "OK";
      },
      async readPublicIp() {
        return "1.1.1.1";
      },
    });

    const service = createProvisioningService({
      repo,
      sshClientFactory: mockSshFactory,
    });

    const { nodeId, done } = await service.provision({
      name: "worker-prov-1",
      tailscaleIp: "100.90.108.8",
      username: "pi",
      password: "secretpassword",
      hostKeyFingerprint: "SHA256:abc123fingerprint",
      expectedPublicIp: "1.1.1.1",
      controllerUrl: "http://100.79.102.99:1300",
    });

    assert.ok(nodeId);
    await done;

    const node = await repo.getNode(nodeId);
    assert.ok(node);
    assert.equal(node.public_ip, "1.1.1.1");
    assert.equal(node.public_ip_status, "verified");
    assert.equal(node.provision_status, "ready");
    assert.equal(node.proxy_activation, "enabled");

    assert.ok(executedCommands.length > 0);
    assert.ok(executedCommands[0].includes("install-agent.sh"));
  } finally {
    repo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("provisioning service keeps node in inventory and disables when public IP mismatches expectation", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-prov-mismatch-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");
  const repo = createFleetRepository({ sqlitePath: dbPath });

  try {
    await repo.migrate();

    let bootstrapExecuted = false;
    const mockSshFactory = () => ({
      async execute() {
        bootstrapExecuted = true;
        return "OK";
      },
      async readPublicIp() {
        return "8.8.8.8"; // Mismatches expected 1.1.1.1
      },
    });

    const service = createProvisioningService({
      repo,
      sshClientFactory: mockSshFactory,
    });

    const { nodeId, done } = await service.provision({
      name: "worker-mismatch-1",
      tailscaleIp: "100.90.108.10",
      username: "pi",
      password: "secretpassword",
      hostKeyFingerprint: "SHA256:abc123fingerprint",
      expectedPublicIp: "1.1.1.1",
      controllerUrl: "http://100.79.102.99:1300",
    });

    assert.ok(nodeId);
    await done;

    const node = await repo.getNode(nodeId);
    assert.ok(node);
    assert.equal(node.public_ip, "8.8.8.8");
    assert.equal(node.public_ip_status, "expected_mismatch");
    assert.equal(node.provision_status, "failed");
    assert.equal(node.proxy_activation, "disabled");
    assert.equal(bootstrapExecuted, false, "Bootstrap must not run when IP validation fails");
  } finally {
    repo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
