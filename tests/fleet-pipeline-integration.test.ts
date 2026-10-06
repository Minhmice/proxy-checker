import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createFleetRepository } from "../src/proxyfleet/db.js";
import { resolveManagedEndpointForAudit, syncFleetEndpointsToIntelligence } from "../src/proxyfleet/pipeline-adapter.js";
import { openProxyIntelligenceDb } from "../src/server/proxy-intelligence-db.js";
import { createProxyIntelligenceRepository } from "../src/server/proxy-intelligence-repository.js";

test("managed endpoints integrate into auditor adapter and intelligence repository preserving source identity", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-pipeline-test-"));
  const fleetDbPath = path.join(tmpDir, "fleet.sqlite3");
  const fleetRepo = createFleetRepository({ sqlitePath: fleetDbPath });
  const intelDb = openProxyIntelligenceDb(tmpDir);
  const intelRepo = createProxyIntelligenceRepository({ db: intelDb });

  try {
    await fleetRepo.migrate();

    // 1. Create a node and endpoint in fleet
    const node = await fleetRepo.createNode({
      name: "worker-wg-01",
      wireguardIp: "10.77.0.11",
      status: "online",
    });

    const endpoint = await fleetRepo.createProxyEndpoint({
      nodeId: node.id,
      protocol: "http",
      listenIp: "10.77.0.11",
      listenPort: 20001,
      username: "fleetuser",
      password: "fleetpassword123",
      enabled: true,
    });

    // 2. Resolve endpoint for audit
    const resolved = await resolveManagedEndpointForAudit(fleetRepo, endpoint.id);
    assert.ok(resolved);
    assert.equal(resolved.targetUrl, "http://fleetuser:fleetpassword123@10.77.0.11:20001");
    assert.equal(resolved.options.allowPrivateTargets, true);
    assert.deepEqual(resolved.options.allowedPrivateIps, ["10.77.0.11"]);

    // 3. Sync fleet endpoints to Proxy Intelligence SQLite inventory
    const syncedCount = await syncFleetEndpointsToIntelligence(fleetRepo, intelRepo);
    assert.equal(syncedCount, 1);

    // 4. Verify proxy item in intelligence DB has source = 'proxyfleet'
    const item = await intelRepo.getProxy("http://fleetuser@10.77.0.11:20001");
    assert.ok(item);
    assert.equal(item.source, "proxyfleet");
    assert.equal(item.port, 20001);

    // 5. Ensure non-destructive: endpoint revision in fleetRepo is still 1
    const freshEndpoint = await fleetRepo.getEndpoint(endpoint.id);
    assert.equal(freshEndpoint?.current_revision, 1);
  } finally {
    intelDb.close();
    fleetRepo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
