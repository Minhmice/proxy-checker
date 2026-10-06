import test from "node:test";
import assert from "node:assert/strict";
import { computeRotationPlan, optimizeAccountsBySpeed } from "../src/server/antigravity-rotator.js";
import { createUnifiedSyncCoordinator } from "../src/server/unified-sync-coordinator.js";

test("antigravity rotator only replaces dead proxy during normal cycle, and assigns by speed when optimized", () => {
  const accounts = [
    { id: "acc-1", email: "a1@test.com", isActive: true, sessionPercentage: 80, weeklyPercentage: 100, resetAt: null, proxyPoolId: "px-alive" },
    { id: "acc-2", email: "a2@test.com", isActive: true, sessionPercentage: 70, weeklyPercentage: 100, resetAt: null, proxyPoolId: "px-dead" },
  ];
  const usableProxies = [
    { remoteId: "px-alive", name: "1" },
    { remoteId: "px-backup", name: "2" },
  ];

  // 1. Normal rotation: acc-1 keeps px-alive, acc-2 gets px-backup
  const plan = computeRotationPlan(accounts, usableProxies, { activeLimit: 2, sessionThreshold: 20 });
  assert.equal(plan.proxyReassignments["acc-1"], undefined); // acc-1 giữ nguyên proxy
  assert.equal(plan.proxyReassignments["acc-2"], "px-backup"); // acc-2 được đổi sang px-backup

  // 2. Optimize by speed: active accounts are assigned top proxies
  const speedReassignments = optimizeAccountsBySpeed(accounts, usableProxies);
  assert.equal(speedReassignments.length, 2);
  assert.equal(speedReassignments[0].proxyPoolId, "px-alive");
  assert.equal(speedReassignments[1].proxyPoolId, "px-backup");
});

test("unified sync coordinator chains 9router sync and antigravity rotator in one cycle", async () => {
  let syncCalled = false;
  let rotatorCalled = false;

  const mockPoolRanker = {
    syncPools: async () => {
      syncCalled = true;
      return { started: true, activated: 2, reserve: 0, dead: 1 };
    },
    isSyncing: () => false,
  };

  const mockRotator = {
    runRotation: async () => {
      rotatorCalled = true;
      return { running: false, activeCount: 2, totalAccounts: 2 };
    },
    isRunning: false,
  };

  const coordinator = createUnifiedSyncCoordinator({
    poolRanker: mockPoolRanker as any,
    antigravityRotator: mockRotator as any,
  });

  assert.equal(coordinator.isRunning, false);
  const result = await coordinator.runUnifiedSyncCycle();
  assert.equal(syncCalled, true);
  assert.equal(rotatorCalled, true);
  assert.equal(result.started, true);
  assert.equal(coordinator.isRunning, false);
});
