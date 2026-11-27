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

test("maintenance measures duration independently of wall clock rollback", async (t) => {
  let now = 2_000;
  t.mock.method(Date, "now", () => now);
  const coordinator = createUnifiedSyncCoordinator({
    antigravityRotator: {
      async runRotation() {
        now = 1_000;
      },
    },
  });
  const result = await coordinator.runUnifiedSyncCycle();
  assert.equal(result.completedAt, 1_000);
  assert.equal(Number.isInteger(result.durationMs), true);
  assert.ok(result.durationMs! >= 0);
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

test("maintenance reports an already running rotator without queueing rotation", async () => {
  let calls = 0;
  const rotator = {
    isRunning: true,
    async runRotation() {
      calls++;
    },
  };
  const coordinator = createUnifiedSyncCoordinator({ antigravityRotator: rotator });
  const result = await coordinator.runUnifiedSyncCycle();
  assert.equal(result.started, true);
  assert.equal(result.rotationSkipped, true);
  assert.equal(result.rotationSkipReason, "already-running");
  assert.equal(result.rotatorSnapshot, undefined);
  rotator.isRunning = false;
  await Promise.resolve();
  assert.equal(calls, 0);
  const disabled = await coordinator.runUnifiedSyncCycle({ rotation: false });
  assert.equal(disabled.rotationSkipped, true);
  assert.equal(disabled.rotationSkipReason, undefined);
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
