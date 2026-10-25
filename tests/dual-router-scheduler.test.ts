import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { openSyncRepository } from "../src/server/dual-router/repository.js";
import { createDualRouterScheduler } from "../src/server/dual-router/scheduler.js";
import type {
  DualRouterCoordinator,
  RunReport,
  RunRequest,
  SyncPolicy,
  Value,
} from "../src/server/dual-router/types.js";

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-test-"));
  return path.join(dir, "sync.sqlite3");
}

function createMockCoordinator(): {
  coordinator: DualRouterCoordinator;
  runs: RunRequest[];
} {
  const runs: RunRequest[] = [];
  const coordinator: DualRouterCoordinator = {
    async run(request: RunRequest): Promise<RunReport> {
      runs.push(structuredClone(request));
      return {
        id: `mock-run-${request.now}`,
        status: "verified",
        operations: [],
        conflicts: [],
        unmetCapabilities: [],
        verifiedAt: request.now,
      };
    },
    async resolve(_input: {
      id: string;
      revision: number;
      value: Value;
      actor: string;
    }): Promise<RunReport> {
      return {
        id: "mock-resolve",
        status: "verified",
        operations: [],
        conflicts: [],
        unmetCapabilities: [],
        verifiedAt: Date.now(),
      };
    },
    async status(): Promise<RunReport | null> {
      return null;
    },
  };
  return { coordinator, runs };
}

test("Scheduler: Returns null and skips trigger when policy is disabled", async () => {
  const dbPath = tempDbPath();
  const repo = openSyncRepository(dbPath);

  try {
    repo.savePolicy({
      enabled: false,
      usageWriteBackAuthorized: false,
      nextIncrementalAt: 1000,
      nextFullAt: 1000,
    });

    const { coordinator, runs } = createMockCoordinator();
    const scheduler = createDualRouterScheduler({
      repository: repo,
      coordinator,
    });

    const result = await scheduler.tick(2000);
    assert.equal(result, null);
    assert.equal(runs.length, 0);
  } finally {
    repo.close();
  }
});

test("Scheduler: Triggers full sync when due and advances nextFullAt by 48 hours", async () => {
  const dbPath = tempDbPath();
  const repo = openSyncRepository(dbPath);

  try {
    const t0 = 10_000;
    repo.savePolicy({
      enabled: true,
      usageWriteBackAuthorized: false,
      nextIncrementalAt: t0 - 1000,
      nextFullAt: t0,
    });

    const { coordinator, runs } = createMockCoordinator();
    const scheduler = createDualRouterScheduler({
      repository: repo,
      coordinator,
    });

    const result = await scheduler.tick(t0);
    assert.ok(result);
    assert.equal(result.status, "verified");

    // Coordinator received full run request
    assert.equal(runs.length, 1);
    assert.equal(runs[0].mode, "full");
    assert.equal(runs[0].trigger, "scheduled");
    assert.equal(runs[0].now, t0);

    // Policy updated
    const updatedPolicy = repo.getPolicy();
    const expectedFullAt = t0 + 48 * 3600 * 1000;
    const expectedIncrementalAt = t0 + 10 * 60 * 1000;
    assert.equal(updatedPolicy.nextFullAt, expectedFullAt);
    assert.equal(updatedPolicy.nextIncrementalAt, expectedIncrementalAt);
  } finally {
    repo.close();
  }
});

test("Scheduler: Triggers incremental sync when due and advances nextIncrementalAt by 10 minutes", async () => {
  const dbPath = tempDbPath();
  const repo = openSyncRepository(dbPath);

  try {
    const now = 50_000;
    const futureFullAt = now + 24 * 3600 * 1000;
    repo.savePolicy({
      enabled: true,
      usageWriteBackAuthorized: false,
      nextIncrementalAt: now,
      nextFullAt: futureFullAt,
    });

    const { coordinator, runs } = createMockCoordinator();
    const scheduler = createDualRouterScheduler({
      repository: repo,
      coordinator,
    });

    const result = await scheduler.tick(now);
    assert.ok(result);
    assert.equal(result.status, "verified");

    // Coordinator received incremental run request
    assert.equal(runs.length, 1);
    assert.equal(runs[0].mode, "incremental");
    assert.equal(runs[0].trigger, "scheduled");
    assert.equal(runs[0].now, now);

    // Policy updated
    const updatedPolicy = repo.getPolicy();
    const expectedIncrementalAt = now + 10 * 60 * 1000;
    assert.equal(updatedPolicy.nextIncrementalAt, expectedIncrementalAt);
    // nextFullAt untouched
    assert.equal(updatedPolicy.nextFullAt, futureFullAt);
  } finally {
    repo.close();
  }
});

test("Scheduler: Returns null when neither full nor incremental is due", async () => {
  const dbPath = tempDbPath();
  const repo = openSyncRepository(dbPath);

  try {
    const now = 10_000;
    const futureIncremental = now + 5 * 60 * 1000;
    const futureFull = now + 20 * 3600 * 1000;

    repo.savePolicy({
      enabled: true,
      usageWriteBackAuthorized: false,
      nextIncrementalAt: futureIncremental,
      nextFullAt: futureFull,
    });

    const { coordinator, runs } = createMockCoordinator();
    const scheduler = createDualRouterScheduler({
      repository: repo,
      coordinator,
    });

    const result = await scheduler.tick(now);
    assert.equal(result, null);
    assert.equal(runs.length, 0);

    // Policy remains unmodified
    const policy = repo.getPolicy();
    assert.equal(policy.nextIncrementalAt, futureIncremental);
    assert.equal(policy.nextFullAt, futureFull);
  } finally {
    repo.close();
  }
});
