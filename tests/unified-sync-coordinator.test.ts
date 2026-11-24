import test from "node:test";
import assert from "node:assert/strict";
import { createUnifiedSyncCoordinator } from "../src/server/unified-sync-coordinator.js";

test("maintenance cycle runs account rotation and returns its snapshot", async () => {
  const calls: Array<{ force?: boolean } | undefined> = [];
  const snapshot = { activeCount: 1, degraded: false };
  const coordinator = createUnifiedSyncCoordinator({
    antigravityRotator: {
      async runRotation(options) {
        calls.push(options);
        return snapshot;
      },
    },
  });
  const result = await coordinator.runUnifiedSyncCycle({ force: false });
  assert.deepEqual(calls, [{ force: false }]);
  assert.equal(result.started, true);
  assert.deepEqual(result.rotatorSnapshot, snapshot);
  assert.equal(coordinator.isRunning, false);
});

test("maintenance skips disabled or already running rotation", async () => {
  let calls = 0;
  const rotator = {
    isRunning: true,
    async runRotation() {
      calls++;
    },
  };
  const coordinator = createUnifiedSyncCoordinator({ antigravityRotator: rotator });
  assert.equal((await coordinator.runUnifiedSyncCycle()).rotationSkipped, true);
  rotator.isRunning = false;
  assert.equal((await coordinator.runUnifiedSyncCycle({ rotation: false })).rotationSkipped, true);
  assert.equal(calls, 0);
});

test("maintenance prevents overlapping cycles and releases state after failure", async () => {
  const gate = Promise.withResolvers<void>();
  const coordinator = createUnifiedSyncCoordinator({
    antigravityRotator: {
      async runRotation() {
        await gate.promise;
        throw new Error("Rotation failed");
      },
    },
  });
  const first = coordinator.runUnifiedSyncCycle();
  assert.equal(coordinator.isRunning, true);
  assert.deepEqual(await coordinator.runUnifiedSyncCycle(), { started: false, running: true });
  gate.resolve();
  const result = await first;
  assert.equal(result.started, true);
  assert.equal(result.error, "Rotation failed");
  assert.equal(coordinator.isRunning, false);
});
