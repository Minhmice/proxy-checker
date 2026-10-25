import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFleetRepository } from "../src/proxyfleet/db.js";
import { createNodeRemovalService } from "../src/proxyfleet/node-removal.js";
import * as wireguard from "../src/proxyfleet/wireguard.js";

test("unconfigured controller releases removal only after native overlay absence is verified", async (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-wg-absent-"));
  const repo = createFleetRepository({ sqlitePath: ":memory:" });
  t.after(() => {
    repo.close();
    fs.rmSync(configDir, { recursive: true, force: true });
  });
  await repo.migrate();
  const node = await repo.createNode({ name: "never-provisioned", wireguardIp: "10.77.0.11" });
  await repo.setNodeAgentToken(node.id, "old-worker-token");
  let inspectionFails = true;
  let nativeInterface = true;
  let serviceExists = false;
  const options: wireguard.FleetWireGuardManagerOptions = {
    configDir,
    commandExecutor: async (_file, args) => {
      if (args[0] === "query") {
        if (inspectionFails) return { stdout: "", stderr: "Access denied", code: 5 };
        return serviceExists
          ? { stdout: "SERVICE_STOPPED", stderr: "", code: 0 }
          : { stdout: "FAILED 1060", stderr: "", code: 1060 };
      }
      assert.deepEqual(args, ["show", "interfaces"]);
      if (inspectionFails) return { stdout: "", stderr: "Permission denied", code: 1 };
      return { stdout: nativeInterface ? "omp-pi proxyfleet\n" : "omp-pi\n", stderr: "", code: 0 };
    },
  };
  const removal = createNodeRemovalService({
    repo,
    removeOwnedPeer: async () => {
      assert.equal(
        typeof wireguard.verifyFleetWireGuardAbsent,
        "function",
        "cleanup needs native absence verification without setup",
      );
      if (!(await wireguard.verifyFleetWireGuardAbsent(options)))
        throw new Error("Existing overlay requires verified cleanup");
    },
    unlinkManagedEndpoints: async () => {},
  });
  assert.equal((await removal.remove(node.id)).status, "pending");
  assert.equal(await repo.verifyNodeAgentToken(node.id, "old-worker-token"), false);
  assert.notEqual(await repo.getNextWireguardIp(), "10.77.0.11");
  inspectionFails = false;
  assert.equal(
    (await removal.remove(node.id)).status,
    "pending",
    "live interface cannot be forgotten",
  );
  nativeInterface = false;
  if (process.platform === "win32") {
    serviceExists = true;
    assert.equal(
      (await removal.remove(node.id)).status,
      "pending",
      "stopped service can restore peers",
    );
    serviceExists = false;
  }
  for (const name of ["proxyfleet.conf", "proxyfleet-owner.json", "proxyfleet.key"]) {
    fs.writeFileSync(path.join(configDir, name), "unverified persisted resource");
    assert.equal((await removal.remove(node.id)).status, "pending", name);
    fs.unlinkSync(path.join(configDir, name));
  }
  const completed = await removal.remove(node.id);
  assert.equal(completed.status, "completed", completed.lastError ?? "");
  assert.equal(await repo.getNode(node.id), null);
  assert.equal(await repo.getNextWireguardIp(), "10.77.0.11");
  assert.deepEqual(await repo.listPendingNodeRemovals(), []);
});
