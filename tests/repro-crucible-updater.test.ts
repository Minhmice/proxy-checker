import test from "node:test";
import assert from "node:assert/strict";
import {
  NineRouterServerManager,
  TARGET_NINEROUTER_SERVERS,
  type NineRouterServerTarget,
  type InteractiveUpgradeResult,
} from "../src/server/server-interactive-updater.js";
import { compareSemver } from "../src/proxyfleet/update-checker.js";

test("REGRESSION-01: compareSemver correctly follows SemVer 2.0.0 precedence for prerelease tags", () => {
  // Pre-release versions have LOWER precedence than normal releases (0.5.109-beta.1 < 0.5.109)
  assert.equal(compareSemver("0.5.109-beta.1", "0.5.109"), -1);
  assert.equal(compareSemver("0.5.109", "0.5.109-beta.1"), 1);
  assert.equal(compareSemver("0.5.109-beta.1", "0.5.109-beta.2"), -1);
  assert.equal(compareSemver("0.5.109-beta.2", "0.5.109-beta.1"), 1);
  assert.equal(compareSemver("0.5.109-beta.1", "0.5.109-beta.1"), 0);

  // Normal releases
  assert.equal(compareSemver("0.5.109", "0.5.104"), 1);
  assert.equal(compareSemver("0.5.104", "0.5.109"), -1);
  assert.equal(compareSemver("0.5.109", "0.5.109"), 0);
});

test("REGRESSION-02: Simultaneous startInteractiveUpgrade acquires lock and prevents collision", async () => {
  let activeConcurrency = 0;
  let maxConcurrencyObserved = 0;

  const mockRunner = async (target: NineRouterServerTarget): Promise<InteractiveUpgradeResult> => {
    activeConcurrency++;
    maxConcurrencyObserved = Math.max(maxConcurrencyObserved, activeConcurrency);
    await new Promise((r) => setTimeout(r, 30));
    activeConcurrency--;
    return {
      serverId: target.id,
      serverName: target.name,
      host: target.host,
      status: "success",
      output: "done",
      durationMs: 30,
    };
  };

  const manager = new NineRouterServerManager(mockRunner);

  // First job acquires lock on server-lan
  const job1 = await manager.startInteractiveUpgrade(["server-lan"]);
  assert.equal(manager.isServerLocked("server-lan"), true);

  // Second concurrent job attempting to upgrade server-lan must be rejected with lock error
  await assert.rejects(
    async () => {
      await manager.startInteractiveUpgrade(["server-lan"]);
    },
    (err: Error) => {
      return err.message.includes("already currently running on");
    },
  );

  // Let first job complete
  await job1.done;

  // Lock must be released
  assert.equal(manager.isServerLocked("server-lan"), false);
  assert.equal(maxConcurrencyObserved, 1, "Concurrency strictly bounded to 1 per server host");
});

test("REGRESSION-03: Max job capacity eviction prevents memory leaks", async () => {
  const mockRunner = async (target: NineRouterServerTarget): Promise<InteractiveUpgradeResult> => ({
    serverId: target.id,
    serverName: target.name,
    host: target.host,
    status: "success",
    output: "done",
  });

  const manager = new NineRouterServerManager(mockRunner);

  for (let i = 0; i < 55; i++) {
    const job = await manager.startInteractiveUpgrade(["server-lan"]);
    await job.done;
  }

  // Max capacity is capped at 50 jobs
  assert.ok(manager.listJobs().length <= 50, "Capped at max capacity to prevent memory leak");
});
test("REGRESSION-04: Runner promise rejection is safely caught and marked failed without corrupting job status", async () => {
  const crashingRunner = async (
    target: NineRouterServerTarget,
  ): Promise<InteractiveUpgradeResult> => {
    if (target.id === "server-vpn") {
      throw new Error("Simulated unhandled SSH crash or network segmentation fault");
    }
    return {
      serverId: target.id,
      serverName: target.name,
      host: target.host,
      status: "success",
      output: "OK",
    };
  };

  const manager = new NineRouterServerManager(crashingRunner);
  const job = await manager.startInteractiveUpgrade();
  await job.done;

  // Asserting expected correct behavior:
  // 1. The crashed target must NOT remain in "running" state
  // 2. The crashed target status must be "failed"
  // 3. The overall job status must be "failed"
  assert.equal(job.targets["server-vpn"].status, "failed");
  assert.equal(job.status, "failed");
});
