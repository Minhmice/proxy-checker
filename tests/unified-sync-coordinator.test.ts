import test from "node:test";
import assert from "node:assert/strict";
import { computeRotationPlan, optimizeAccountsBySpeed } from "../src/server/antigravity-rotator.js";
import { createUnifiedSyncCoordinator } from "../src/server/unified-sync-coordinator.js";

test("antigravity rotator only replaces dead proxy during normal cycle, and assigns by speed when optimized", () => {
  const accounts = [
    {
      id: "acc-1",
      email: "a1@test.com",
      isActive: true,
      sessionPercentage: 80,
      weeklyPercentage: 100,
      resetAt: null,
      proxyPoolId: "px-alive",
    },
    {
      id: "acc-2",
      email: "a2@test.com",
      isActive: true,
      sessionPercentage: 70,
      weeklyPercentage: 100,
      resetAt: null,
      proxyPoolId: "px-dead",
    },
  ];
  const usableProxies = [
    { remoteId: "px-alive", name: "1" },
    { remoteId: "px-backup", name: "2" },
  ];

  // 1. Normal rotation: acc-1 keeps px-alive, acc-2 gets px-backup
  const plan = computeRotationPlan(accounts, usableProxies, {
    activeLimit: 2,
    sessionThreshold: 20,
  });
  assert.equal(plan.proxyReassignments["acc-1"], undefined); // acc-1 giữ nguyên proxy
  assert.equal(plan.proxyReassignments["acc-2"], "px-backup"); // acc-2 được đổi sang px-backup

  // 2. Optimize by speed: active accounts are assigned top proxies
  const speedReassignments = optimizeAccountsBySpeed(accounts, usableProxies);
  assert.equal(speedReassignments.length, 2);
  assert.equal(speedReassignments[0].proxyPoolId, "px-alive");
  assert.equal(speedReassignments[1].proxyPoolId, "px-backup");
});

test("unified sync coordinator chains 9router sync, db reconcile, and antigravity rotator in one cycle", async () => {
  let syncCalled = false;
  let rotatorCalled = false;
  let reconciledPools: Array<{ remoteId?: string | null }> | null = null;

  const mockPoolRanker = {
    async syncPools() {
      syncCalled = true;
      return { started: true, activated: 2, reserve: 0, dead: 1 };
    },
    isSyncing() {
      return false;
    },
    listByTier() {
      return [
        { remoteId: "rem-1", proxyUrl: "http://1.1.1.1:8080", status: "usable", tier: "active" },
        { remoteId: null, proxyUrl: "http://dead:8080", status: "dead", tier: "removed" },
      ];
    },
  };

  const mockRotator = {
    async runRotation() {
      rotatorCalled = true;
      return { running: false, activeCount: 2, totalAccounts: 2 };
    },
    isRunning: false,
  };

  const mockRepo = {
    async syncWorkingPools(pools: Array<{ remoteId?: string | null }>) {
      reconciledPools = pools;
      return { imported: pools.length, proxyKeys: [] };
    },
  };

  const coordinator = createUnifiedSyncCoordinator({
    poolRanker: mockPoolRanker,
    antigravityRotator: mockRotator,
    proxyIntelligenceRepo: mockRepo,
  });

  assert.equal(coordinator.isRunning, false);
  const result = await coordinator.runUnifiedSyncCycle();
  assert.equal(syncCalled, true);
  assert.equal(rotatorCalled, true);
  assert.ok(reconciledPools !== null);
  const poolsList: Array<{ remoteId?: string | null }> = reconciledPools;
  assert.equal(poolsList.length, 1);
  const firstReconciled = poolsList[0];
  assert.ok(firstReconciled);
  assert.equal(firstReconciled.remoteId, "rem-1");
  assert.equal(result.started, true);
  assert.equal(coordinator.isRunning, false);
});
test("coordinator runs router sync and antigravity rotator concurrently", async () => {
  const routerStarted = Promise.withResolvers<void>();
  const rotatorStarted = Promise.withResolvers<void>();
  const releaseGate = Promise.withResolvers<void>();

  let observedAllActive = false;

  const mockPoolRanker = {
    async syncPools() {
      routerStarted.resolve();
      await releaseGate.promise;
      return { started: true };
    },
    isSyncing: () => false,
  };

  const mockRotator = {
    async runRotation() {
      rotatorStarted.resolve();
      await releaseGate.promise;
      return { activeCount: 3 };
    },
    isRunning: false,
  };

  const coordinator = createUnifiedSyncCoordinator({
    poolRanker: mockPoolRanker,
    antigravityRotator: mockRotator,
  });

  const cyclePromise = coordinator.runUnifiedSyncCycle();

  await Promise.all([routerStarted.promise, rotatorStarted.promise]);
  observedAllActive = true;
  releaseGate.resolve();

  const result = await cyclePromise;
  assert.equal(result.started, true);
  assert.equal(observedAllActive, true);
  assert.ok(result.syncResult);
  assert.ok(result.rotatorSnapshot);
});

test("rotator failure is isolated and does not fail router work", async () => {
  const mockPoolRanker = {
    async syncPools() {
      return { ok: true, active: 5 };
    },
    isSyncing: () => false,
  };

  const mockRotator = {
    async runRotation() {
      throw new Error("Rotator API timeout");
    },
    isRunning: false,
  };

  const coordinator = createUnifiedSyncCoordinator({
    poolRanker: mockPoolRanker,
    antigravityRotator: mockRotator,
  });

  const result = await coordinator.runUnifiedSyncCycle();
  assert.equal(result.started, true);
  assert.ok(result.syncResult);
  assert.equal(result.error, "Rotator API timeout");
});

test("coordinator respects selective skip flags for router and rotation without error", async () => {
  let routerCalled = false;
  let rotatorCalled = false;

  const mockPoolRanker = {
    async syncPools() {
      routerCalled = true;
      return {};
    },
    isSyncing: () => false,
  };

  const mockRotator = {
    async runRotation() {
      rotatorCalled = true;
      return {};
    },
    isRunning: false,
  };

  const coordinator = createUnifiedSyncCoordinator({
    poolRanker: mockPoolRanker,
    antigravityRotator: mockRotator,
  });

  const result = await coordinator.runUnifiedSyncCycle({ router: false, rotation: false });
  assert.equal(result.started, true);
  assert.equal(routerCalled, false);
  assert.equal(rotatorCalled, false);
  assert.equal(result.routerSkipped, true);
  assert.equal(result.rotationSkipped, true);
});
