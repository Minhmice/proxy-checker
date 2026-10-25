import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createFleetRepository } from "../src/proxyfleet/db.js";
import {
  resolveManagedEndpointForAudit,
  syncFleetEndpointsToIntelligence,
} from "../src/proxyfleet/pipeline-adapter.js";
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
test("fleet unlinking preserves separately imported shared proxy rows", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-shared-test-"));
  const fleetDbPath = path.join(tmpDir, "fleet.sqlite3");
  const fleetRepo = createFleetRepository({ sqlitePath: fleetDbPath });
  const intelDb = openProxyIntelligenceDb(tmpDir);
  const intelRepo = createProxyIntelligenceRepository({ db: intelDb });

  try {
    await fleetRepo.migrate();

    // 1. Manually import a proxy with source = 'manual'
    await intelRepo.importProxies({
      source: "manual",
      content: "http://shareduser:sharedpass@10.77.0.22:20002",
    });

    const manualItem = await intelRepo.getProxy("http://shareduser@10.77.0.22:20002");
    assert.ok(manualItem);
    assert.equal(manualItem.source, "manual");

    // 2. Create fleet node & endpoint matching the same proxy URL
    const node = await fleetRepo.createNode({
      name: "worker-shared-01",
      wireguardIp: "10.77.0.22",
      status: "online",
    });

    const endpoint = await fleetRepo.createProxyEndpoint({
      nodeId: node.id,
      protocol: "http",
      listenIp: "10.77.0.22",
      listenPort: 20002,
      username: "shareduser",
      password: "sharedpass",
      enabled: true,
    });

    // 3. Sync fleet endpoints
    const count = await syncFleetEndpointsToIntelligence(fleetRepo, intelRepo);
    assert.equal(count, 1);

    // Verify source is still 'manual' (shared proxy)
    const afterSync = await intelRepo.getProxy("http://shareduser@10.77.0.22:20002");
    assert.ok(afterSync);
    assert.equal(afterSync.source, "manual");

    // 4. Unlink fleet node
    await intelRepo.unlinkManagedFleetNode(node.id);

    // 5. Verify manual proxy survives unlinking!
    const survivingItem = await intelRepo.getProxy("http://shareduser@10.77.0.22:20002");
    assert.ok(survivingItem);
    assert.equal(survivingItem.source, "manual");
  } finally {
    intelDb.close();
    fleetRepo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("endpoint credential rotation updates mapping without stale orphans and handles pending remote links", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-creds-test-"));
  const intelDb = openProxyIntelligenceDb(tmpDir);
  const intelRepo = createProxyIntelligenceRepository({ db: intelDb });

  try {
    const nodeId = "node-alpha";
    const endpointId = "ep-alpha-1";

    // 1. Initial sync with creds 1
    const syncCount1 = await intelRepo.syncManagedFleetEndpoints([
      {
        nodeId,
        endpointId,
        proxyUrl: "http://user1:pass1@10.77.0.33:20003",
      },
    ]);
    assert.equal(syncCount1, 1);

    const key1 = "http://user1@10.77.0.33:20003";
    const item1 = await intelRepo.getProxy(key1);
    assert.ok(item1);
    assert.equal(item1.source, "proxyfleet");
    assert.equal(item1.status, "dead"); // not marked healthy on import

    // Targets list exposes target
    const targets = await intelRepo.listManagedFleetAuditTargets();
    assert.equal(targets.length, 1);
    assert.equal(targets[0].nodeId, nodeId);
    assert.equal(targets[0].endpointId, endpointId);
    assert.equal(targets[0].proxyKey, key1);

    // 2. Rotate credentials to user2:pass2
    const syncCount2 = await intelRepo.syncManagedFleetEndpoints([
      {
        nodeId,
        endpointId,
        proxyUrl: "http://user2:pass2@10.77.0.33:20003",
      },
    ]);
    assert.equal(syncCount2, 1);

    const key2 = "http://user2@10.77.0.33:20003";
    const item2 = await intelRepo.getProxy(key2);
    assert.ok(item2);

    // Old exclusive proxy without remote refs was cleaned up
    const oldItem = await intelRepo.getProxy(key1);
    assert.equal(oldItem, null);

    // 3. Mark key2 with remote reference (e.g. linked to 9router)
    intelDb.exec(`UPDATE proxies SET remote_id = '9router-rem-999' WHERE proxy_key = '${key2}'`);

    // 4. Try unlinking without remote cleanup -> throws and retains mapping
    await assert.rejects(
      async () => {
        await intelRepo.unlinkManagedFleetNode(nodeId);
      },
      (err: Error) => {
        assert.match(err.message, /has active remote reference '9router-rem-999' pending cleanup/);
        return true;
      },
    );

    // Mapping is still retained
    const targetsAfterFailed = await intelRepo.listManagedFleetAuditTargets();
    assert.equal(targetsAfterFailed.length, 1);

    // 5. Unlink with cleanupRemoteRef callback succeeds
    let cleanedRemoteId: string | null = null;
    await intelRepo.unlinkManagedFleetNode(nodeId, {
      cleanupRemoteRef: async (remoteId) => {
        cleanedRemoteId = remoteId;
      },
    });

    assert.equal(cleanedRemoteId, "9router-rem-999");
    const targetsAfterSuccess = await intelRepo.listManagedFleetAuditTargets();
    assert.equal(targetsAfterSuccess.length, 0);
  } finally {
    intelDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
test("unlink fleet node does not remove remote ref from shared non-fleet proxy", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-shared-remote-"));
  const intelDb = openProxyIntelligenceDb(tmpDir);
  const intelRepo = createProxyIntelligenceRepository({ db: intelDb });

  try {
    // 1. Manually imported proxy with existing 9Router remote link
    await intelRepo.importProxies({
      source: "manual",
      content: "http://shared-router-user:pass@10.77.0.44:20004",
    });

    const key = "http://shared-router-user@10.77.0.44:20004";
    intelDb.exec(
      `UPDATE proxies SET remote_id = '9router-foreign-ref', router_state = 'active' WHERE proxy_key = '${key}'`,
    );

    // 2. Fleet maps to this same shared proxy
    await intelRepo.syncManagedFleetEndpoints([
      {
        nodeId: "node-shared-rem",
        endpointId: "ep-shared-1",
        proxyUrl: "http://shared-router-user:fleetpass@10.77.0.44:20004",
      },
    ]);

    // 3. Unlink fleet node - callback MUST NOT be invoked for foreign/shared ref
    let cleanupCalled = false;
    await intelRepo.unlinkManagedFleetNode("node-shared-rem", {
      cleanupRemoteRef: async () => {
        cleanupCalled = true;
      },
    });

    assert.equal(cleanupCalled, false);

    // Foreign remote ownership and credentials remain in SQLite and public projection.
    const surviving = await intelRepo.getProxy(key);
    assert.ok(surviving);
    assert.equal(surviving.remoteId, "9router-foreign-ref");
    assert.equal(surviving.routerState, "active");
    const durable = intelDb.get<{ remote_id: string; router_state: string; password: string }>(
      "SELECT remote_id, router_state, password FROM proxies WHERE proxy_key = ?",
      [key],
    );
    assert.deepEqual(durable, {
      remote_id: "9router-foreign-ref",
      router_state: "active",
      password: "pass",
    });
  } finally {
    intelDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("empty mapping node unlink succeeds idempotently without throwing", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-empty-unlink-"));
  const intelDb = openProxyIntelligenceDb(tmpDir);
  const intelRepo = createProxyIntelligenceRepository({ db: intelDb });

  try {
    // Node with zero endpoints/mappings
    await intelRepo.unlinkManagedFleetNode("node-without-endpoints");
    // Repeated call is also successful
    await intelRepo.unlinkManagedFleetNode("node-without-endpoints");
  } finally {
    intelDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("fleet sync preserves manual password on shared identity and encodes special username", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-pwd-preserve-"));
  const intelDb = openProxyIntelligenceDb(tmpDir);
  const intelRepo = createProxyIntelligenceRepository({ db: intelDb });

  try {
    // 1. Manual import with manual password
    await intelRepo.importProxies({
      source: "manual",
      content: "http://user%40test:manualsecret@10.77.0.55:20005",
    });

    const sharedKey = "http://user%40test@10.77.0.55:20005";
    const initial = dbGetPassword(intelDb, sharedKey);
    assert.equal(initial, "manualsecret");

    // 2. Fleet sync attempts to link with different password
    await intelRepo.syncManagedFleetEndpoints([
      {
        nodeId: "node-pwd",
        endpointId: "ep-pwd-1",
        proxyUrl: "http://user%40test:fleetsecret@10.77.0.55:20005",
      },
      {
        nodeId: "node-pwd",
        endpointId: "ep-pwd-2",
        proxyUrl: "http://exclusive%40user:fleetsecret@10.77.0.55:20006",
      },
    ]);

    // Manual password is preserved on shared row!
    const afterSync = dbGetPassword(intelDb, sharedKey);
    assert.equal(afterSync, "manualsecret");

    // Audit targets have encoded username in proxyKey and fleet-exclusive proxyUrl
    const targets = await intelRepo.listManagedFleetAuditTargets();
    assert.equal(targets.length, 2);
    const sharedTarget = targets.find((t) => t.endpointId === "ep-pwd-1");
    assert.ok(sharedTarget);
    assert.ok(sharedTarget.proxyKey.includes("user%40test"));

    const exclusiveTarget = targets.find((t) => t.endpointId === "ep-pwd-2");
    assert.ok(exclusiveTarget);
    assert.ok(exclusiveTarget.proxyUrl.includes("exclusive%40user"));
  } finally {
    intelDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("two fleet nodes sharing same proxyKey unlink one preserves remote ref and proxy until last", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-two-nodes-"));
  const intelDb = openProxyIntelligenceDb(tmpDir);
  const intelRepo = createProxyIntelligenceRepository({ db: intelDb });

  try {
    const sharedUrl = "http://sharedfleet:pass@10.77.0.77:20007";
    const sharedKey = "http://sharedfleet@10.77.0.77:20007";

    await intelRepo.syncManagedFleetEndpoints([
      { nodeId: "node-1", endpointId: "ep-1", proxyUrl: sharedUrl },
      { nodeId: "node-2", endpointId: "ep-2", proxyUrl: sharedUrl },
    ]);

    intelDb.exec(
      `UPDATE proxies SET remote_id = '9router-shared-two-nodes' WHERE proxy_key = '${sharedKey}'`,
    );

    let node1Cleaned = false;
    await intelRepo.unlinkManagedFleetNode("node-1", {
      cleanupRemoteRef: async () => {
        node1Cleaned = true;
      },
    });

    // Other fleet node still references proxy, so callback MUST NOT be invoked
    assert.equal(node1Cleaned, false);

    // Public projection and durable row retain remote ref while another fleet node owns mapping.
    const surviving = await intelRepo.getProxy(sharedKey);
    assert.ok(surviving);
    assert.equal(surviving.remoteId, "9router-shared-two-nodes");
    const durable = intelDb.get<{ remote_id: string }>(
      "SELECT remote_id FROM proxies WHERE proxy_key = ?",
      [sharedKey],
    );
    assert.equal(durable?.remote_id, "9router-shared-two-nodes");

    // Unlink node-2 (last reference)
    let node2Cleaned = false;
    await intelRepo.unlinkManagedFleetNode("node-2", {
      cleanupRemoteRef: async (remoteId) => {
        node2Cleaned = true;
        assert.equal(remoteId, "9router-shared-two-nodes");
      },
    });

    assert.equal(node2Cleaned, true);
    const deadProxy = await intelRepo.getProxy(sharedKey);
    assert.equal(deadProxy, null);
  } finally {
    intelDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("cleanupPendingManagedFleetEndpoints processes pending credential mappings and race safety", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-pending-clean-"));
  const intelDb = openProxyIntelligenceDb(tmpDir);
  const intelRepo = createProxyIntelligenceRepository({ db: intelDb });

  try {
    const nodeId = "node-race";
    const endpointId = "ep-race-1";
    const url1 = "http://creds1:pass1@10.77.0.88:20008";
    const key1 = "http://creds1@10.77.0.88:20008";
    const url2 = "http://creds2:pass2@10.77.0.88:20008";
    const key2 = "http://creds2@10.77.0.88:20008";

    // 1. Initial sync with url1
    await intelRepo.syncManagedFleetEndpoints([{ nodeId, endpointId, proxyUrl: url1 }]);
    intelDb.exec(
      `UPDATE proxies SET remote_id = '9router-pending-old' WHERE proxy_key = '${key1}'`,
    );

    // 2. Rotate to url2
    await intelRepo.syncManagedFleetEndpoints([{ nodeId, endpointId, proxyUrl: url2 }]);

    // 3. Cleanup pending mappings
    let cleanedRemote: string | null = null;
    const result = await intelRepo.cleanupPendingManagedFleetEndpoints({
      cleanupRemoteRef: async (remoteId) => {
        cleanedRemote = remoteId;
      },
    });

    assert.equal(result.cleaned, 1);
    assert.equal(result.pendingRemaining, 0);
    assert.equal(cleanedRemote, "9router-pending-old");

    // Old proxy deleted, new proxy remains
    assert.equal(await intelRepo.getProxy(key1), null);
    assert.ok(await intelRepo.getProxy(key2));
  } finally {
    intelDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("pending cleanup revalidates remote identity after external await", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-pending-revalidate-"));
  const intelDb = openProxyIntelligenceDb(tmpDir);
  const intelRepo = createProxyIntelligenceRepository({ db: intelDb });

  try {
    const nodeId = "node-revalidate";
    const endpointId = "ep-revalidate";
    const key = "http://revalidate@10.77.0.99:20009";
    await intelRepo.syncManagedFleetEndpoints([
      { nodeId, endpointId, proxyUrl: "http://revalidate:pass@10.77.0.99:20009" },
    ]);
    intelDb.run("UPDATE proxies SET remote_id = ?, router_state = 'active' WHERE proxy_key = ?", [
      "9router-old",
      key,
    ]);
    await intelRepo.syncManagedFleetEndpoints([
      { nodeId, endpointId, proxyUrl: "http://revalidate2:pass@10.77.0.99:20009" },
    ]);

    const result = await intelRepo.cleanupPendingManagedFleetEndpoints({
      cleanupRemoteRef: async () => {
        intelDb.run("UPDATE proxies SET remote_id = ? WHERE proxy_key = ?", [
          "9router-replaced",
          key,
        ]);
      },
    });

    assert.equal(result.cleaned, 0);
    assert.equal(result.pendingRemaining, 1);
    assert.equal(
      intelDb.get<{ remote_id: string }>("SELECT remote_id FROM proxies WHERE proxy_key = ?", [key])
        ?.remote_id,
      "9router-replaced",
    );
    assert.equal(
      intelDb.get<{ pending_cleanup: number }>(
        "SELECT pending_cleanup FROM fleet_managed_endpoints WHERE node_id = ? AND endpoint_id = ? AND proxy_key = ?",
        [nodeId, endpointId, key],
      )?.pending_cleanup,
      1,
    );
  } finally {
    intelDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("unlink revalidates remote identity after external await", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-unlink-revalidate-"));
  const intelDb = openProxyIntelligenceDb(tmpDir);
  const intelRepo = createProxyIntelligenceRepository({ db: intelDb });

  try {
    const nodeId = "node-unlink-revalidate";
    const endpointId = "ep-unlink-revalidate";
    const key = "http://unlink-revalidate@10.77.0.98:20010";
    await intelRepo.syncManagedFleetEndpoints([
      { nodeId, endpointId, proxyUrl: "http://unlink-revalidate:pass@10.77.0.98:20010" },
    ]);
    intelDb.run("UPDATE proxies SET remote_id = ?, router_state = 'active' WHERE proxy_key = ?", [
      "9router-old-unlink",
      key,
    ]);

    await intelRepo.unlinkManagedFleetNode(nodeId, {
      cleanupRemoteRef: async () => {
        intelDb.run("UPDATE proxies SET remote_id = ? WHERE proxy_key = ?", [
          "9router-replaced-unlink",
          key,
        ]);
      },
    });

    assert.equal(
      intelDb.get<{ remote_id: string }>("SELECT remote_id FROM proxies WHERE proxy_key = ?", [key])
        ?.remote_id,
      "9router-replaced-unlink",
    );
    assert.equal(
      intelDb.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM fleet_managed_endpoints WHERE node_id = ? AND endpoint_id = ?",
        [nodeId, endpointId],
      )?.count,
      1,
    );
  } finally {
    intelDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function dbGetPassword(
  db: { get: (sql: string, params: unknown[]) => Record<string, unknown> | undefined },
  key: string,
): string | null {
  const row = db.get("SELECT password FROM proxies WHERE proxy_key = ?", [key]);
  return row ? (row.password as string) : null;
}
