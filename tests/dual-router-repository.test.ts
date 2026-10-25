import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSyncRepository } from "../src/server/dual-router/repository.js";
import type {
  Baseline,
  Conflict,
  Operation,
  Receipt,
  RunReport,
  UsageEvent,
  UsageWrite,
} from "../src/server/dual-router/types.js";

test("sync repository persists usage events across reopen and prevents duplicates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-sync-"));
  const file = path.join(dir, "router-sync.sqlite3");

  const event: UsageEvent = {
    id: "request-1",
    namespace: "provider-global",
    sourceRouterId: "A",
    scope: {
      accountKey: "ag:subject-1",
      provider: "antigravity",
      model: "gemini",
      metric: "requests",
      unit: "count",
      currency: null,
      periodStart: "2026-10-01",
      periodEnd: "2026-11-01",
    },
    amount: "1",
    accuracy: "exact",
    provenance: "native",
    generation: "1",
    cursor: "request-1",
    observedAt: 1,
  };

  try {
    let repo = openSyncRepository(file);
    assert.equal(repo.appendUsage(event), true);
    repo.close();

    repo = openSyncRepository(file);
    assert.equal(repo.appendUsage(event), false);
    assert.deepEqual(repo.listUsage(event.scope), [event]);

    // Conflicting content under same id throws integrity conflict
    assert.throws(
      () =>
        repo.appendUsage({
          ...event,
          amount: "999",
        }),
      /Integrity conflict/i,
    );

    repo.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sync repository manages baselines with upsert and reopen persistence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-sync-"));
  const file = path.join(dir, "router-sync.sqlite3");

  try {
    let repo = openSyncRepository(file);
    const b1: Baseline = {
      resource: "pool",
      key: "p1",
      field: "status",
      value: "active",
      deleted: false,
      revision: 1,
    };
    repo.saveBaseline(b1);
    assert.deepEqual(repo.listBaselines(), [b1]);

    // Upsert update
    const b1Updated: Baseline = {
      resource: "pool",
      key: "p1",
      field: "status",
      value: "disabled",
      deleted: false,
      revision: 2,
    };
    repo.saveBaseline(b1Updated);
    repo.close();

    repo = openSyncRepository(file);
    assert.deepEqual(repo.listBaselines(), [b1Updated]);
    repo.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sync repository enqueues operations, tracks pending, and records receipts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-sync-"));
  const file = path.join(dir, "router-sync.sqlite3");

  try {
    const repo = openSyncRepository(file);
    const op: Operation = {
      id: "op-1",
      routerId: "router-1",
      resource: "account",
      key: "acc-1",
      field: null,
      kind: "create",
      expected: null,
      expectedRevision: null,
      desired: { name: "Account 1" },
      dependsOn: [],
    };
    repo.enqueue(op);
    assert.deepEqual(repo.pendingOperations(), [op]);

    const write: UsageWrite = {
      operationId: "op-1",
      routerId: "router-1",
      scope: {
        accountKey: "acc-1",
        provider: "antigravity",
        model: "gemini",
        metric: "requests",
        unit: "count",
        currency: null,
        periodStart: "2026-10-01",
        periodEnd: "2026-11-01",
      },
      ledgerRevision: 1,
      strategy: "absolute",
      amount: "10",
      expectedBoundary: "10",
    };
    repo.prepareWrite(write);

    const receipt: Receipt = {
      operationId: "op-1",
      outcome: "applied",
      boundary: "10",
      evidence: "tx-123",
    };
    repo.recordReceipt(receipt);

    // Pending operations queue no longer includes applied operation
    assert.deepEqual(repo.pendingOperations(), []);
    repo.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sync repository saves and resolves conflicts with revision fencing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-sync-"));
  const file = path.join(dir, "router-sync.sqlite3");

  try {
    const repo = openSyncRepository(file);
    const conflict: Conflict = {
      id: "c-1",
      resource: "settings",
      key: "timeout",
      field: "value",
      revision: 1,
      reason: "divergent",
      base: 30,
      a: 60,
      b: 90,
    };
    repo.saveConflict(conflict);

    // Stale expected revision fails
    assert.equal(repo.resolveConflict("c-1", 99, 120), false);
    // Non-existent id fails
    assert.equal(repo.resolveConflict("c-missing", 1, 120), false);

    // Matching revision succeeds
    assert.equal(repo.resolveConflict("c-1", 1, 120), true);

    // Already resolved fails
    assert.equal(repo.resolveConflict("c-1", 1, 120), false);
    assert.equal(repo.resolveConflict("c-1", 2, 120), false);
    repo.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sync repository handles lease acquisition, renewal, takeover, and fencing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-sync-"));
  const file = path.join(dir, "router-sync.sqlite3");

  try {
    const repo = openSyncRepository(file);
    const t0 = 1000;
    const ttl = 500;

    // Initial acquire grants epoch 1 to controller-A
    const epochA = repo.acquireLease("controller-A", t0, ttl);
    assert.equal(epochA, 1);

    // controller-B cannot acquire while active
    assert.equal(repo.acquireLease("controller-B", t0 + 100, ttl), null);

    // controller-A can renew
    assert.equal(repo.renewLease("controller-A", 1, t0 + 200, ttl), true);

    // controller-B cannot renew
    assert.equal(repo.renewLease("controller-B", 1, t0 + 200, ttl), false);

    // controller-A renewal with wrong epoch fails
    assert.equal(repo.renewLease("controller-A", 99, t0 + 200, ttl), false);

    // Lease expires at t0 + 200 + 500 = 1700
    // At t = 1800, controller-B takes over lease with bumped epoch 2
    const epochB = repo.acquireLease("controller-B", 1800, ttl);
    assert.equal(epochB, 2);

    // Stale controller-A renewal is fenced
    assert.equal(repo.renewLease("controller-A", 1, 1850, ttl), false);

    // controller-B releases lease
    repo.releaseLease("controller-B", 2);

    // controller-C can acquire immediately
    const epochC = repo.acquireLease("controller-C", 1860, ttl);
    assert.equal(epochC, 3);

    repo.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sync repository manages policy and run reports with verified filtering", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-sync-"));
  const file = path.join(dir, "router-sync.sqlite3");

  try {
    let repo = openSyncRepository(file);

    // Default policy
    const defaultPolicy = repo.getPolicy();
    assert.equal(defaultPolicy.enabled, true);
    assert.equal(defaultPolicy.usageWriteBackAuthorized, false);

    // Save policy
    repo.savePolicy({
      enabled: false,
      usageWriteBackAuthorized: true,
      nextIncrementalAt: 5000,
      nextFullAt: 10000,
    });
    repo.close();

    repo = openSyncRepository(file);
    const updatedPolicy = repo.getPolicy();
    assert.equal(updatedPolicy.enabled, false);
    assert.equal(updatedPolicy.usageWriteBackAuthorized, true);
    assert.equal(updatedPolicy.nextIncrementalAt, 5000);
    assert.equal(updatedPolicy.nextFullAt, 10000);

    // Initial run report check
    assert.equal(repo.lastVerifiedRun(), null);

    // Non-verified report does not advance lastVerifiedRun
    const unverifiedReport: RunReport = {
      id: "run-1",
      status: "conflicted",
      operations: [],
      conflicts: [],
      unmetCapabilities: [],
      verifiedAt: null,
    };
    repo.finishRun(unverifiedReport);
    assert.equal(repo.lastVerifiedRun(), null);

    // Verified report advances lastVerifiedRun
    const verifiedReport: RunReport = {
      id: "run-2",
      status: "verified",
      operations: [{ id: "op-1", outcome: "applied" }],
      conflicts: [],
      unmetCapabilities: [],
      verifiedAt: 7000,
    };
    repo.finishRun(verifiedReport);
    assert.deepEqual(repo.lastVerifiedRun(), verifiedReport);

    // Subsequent non-verified run does not overwrite lastVerifiedRun
    const secondUnverified: RunReport = {
      id: "run-3",
      status: "partial",
      operations: [],
      conflicts: [],
      unmetCapabilities: ["usage"],
      verifiedAt: null,
    };
    repo.finishRun(secondUnverified);
    assert.deepEqual(repo.lastVerifiedRun(), verifiedReport);

    repo.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
