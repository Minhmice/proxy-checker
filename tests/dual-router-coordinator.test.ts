import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { openSyncRepository } from "../src/server/dual-router/repository.js";
import { createDualRouterCoordinator } from "../src/server/dual-router/coordinator.js";
import type {
  Baseline,
  Capability,
  Conflict,
  Entity,
  Operation,
  Receipt,
  Resource,
  RouterAdapter,
  Snapshot,
  UsageEvent,
  UsageWrite,
  Value,
} from "../src/server/dual-router/types.js";

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coordinator-test-"));
  return path.join(dir, "sync.sqlite3");
}

function createMockAdapter(
  routerId: string,
  initialEntities: Partial<Record<Resource, Entity[]>> = {},
): {
  adapter: RouterAdapter;
  appliedOps: Operation[];
  state: Map<Resource, Map<string, Entity>>;
} {
  const appliedOps: Operation[] = [];
  const state = new Map<Resource, Map<string, Entity>>();

  const resources: Resource[] = ["pool", "account", "settings", "role", "history"];
  for (const r of resources) {
    const resourceMap = new Map<string, Entity>();
    for (const e of initialEntities[r] ?? []) {
      resourceMap.set(e.key, structuredClone(e));
    }
    state.set(r, resourceMap);
  }

  const adapter: RouterAdapter = {
    routerId,
    url: `http://${routerId}.test`,

    async capabilities(): Promise<Capability[]> {
      return resources.map((r) => ({
        resource: r,
        read: true,
        export: true,
        write: true,
        conditional: true,
        evidence: "mock",
      }));
    },

    async readState(): Promise<Snapshot> {
      const scopes: Snapshot["scopes"] = {} as Snapshot["scopes"];
      for (const r of resources) {
        const entities = Array.from(state.get(r)!.values()).map((e) => structuredClone(e));
        scopes[r] = {
          complete: true,
          entities,
          cursor: null,
          observedAt: 1000,
          error: null,
        };
      }
      return {
        routerId,
        scopes,
      };
    },

    async apply(operation: Operation): Promise<Receipt> {
      appliedOps.push(structuredClone(operation));
      const resourceMap = state.get(operation.resource)!;

      if (operation.kind === "create") {
        resourceMap.set(operation.key, {
          resource: operation.resource,
          key: operation.key,
          localId: operation.key,
          fields: (operation.desired as Record<string, Value>) ?? {},
          revision: "rev-1",
        });
      } else if (operation.kind === "update") {
        const entity = resourceMap.get(operation.key);
        if (entity) {
          if (operation.field) {
            entity.fields[operation.field] = operation.desired;
          }
        } else {
          resourceMap.set(operation.key, {
            resource: operation.resource,
            key: operation.key,
            localId: operation.key,
            fields: operation.field ? { [operation.field]: operation.desired } : {},
            revision: "rev-1",
          });
        }
      } else if (operation.kind === "delete") {
        resourceMap.delete(operation.key);
      }

      return {
        operationId: operation.id,
        outcome: "applied",
        boundary: "b-1",
        evidence: "ok",
      };
    },

    async readUsage(): Promise<UsageEvent[]> {
      return [];
    },

    async writeUsage(write: UsageWrite): Promise<Receipt> {
      return {
        operationId: write.operationId,
        outcome: "applied",
        boundary: "b-1",
        evidence: null,
      };
    },

    async readReceipt(): Promise<Receipt | null> {
      return null;
    },
  };

  return { adapter, appliedOps, state };
}

test("Coordinator: Audit mode makes zero mutations on remote adapters", async () => {
  const dbPath = tempDbPath();
  const repo = openSyncRepository(dbPath);

  try {
    const mockA = createMockAdapter("router-a", {
      pool: [
        {
          resource: "pool",
          key: "pool-1",
          localId: "pool-1",
          fields: { name: "Pool One", priority: 1 },
          revision: "1",
        },
      ],
    });
    const mockB = createMockAdapter("router-b", {
      pool: [],
    });

    const coordinator = createDualRouterCoordinator({
      repository: repo,
      adapters: [mockA.adapter, mockB.adapter],
    });

    const report = await coordinator.run({
      mode: "audit",
      trigger: "manual",
      now: 1000,
    });

    // Zero mutations on adapters
    assert.equal(mockA.appliedOps.length, 0);
    assert.equal(mockB.appliedOps.length, 0);

    // Planned operation reported with unknown/conflicted outcome
    assert.equal(report.operations.length, 1);
    assert.equal(report.operations[0].id.includes("router-b"), true);
    assert.equal(report.verifiedAt, null);

    // Baselines not modified
    assert.equal(repo.listBaselines().length, 0);
  } finally {
    repo.close();
  }
});

test("Coordinator: Incremental and Full modes apply safe operations and advance baselines", async () => {
  const dbPath = tempDbPath();
  const repo = openSyncRepository(dbPath);

  try {
    const mockA = createMockAdapter("router-a", {
      pool: [
        {
          resource: "pool",
          key: "pool-1",
          localId: "pool-1",
          fields: { name: "Pool One", priority: 1 },
          revision: "1",
        },
      ],
    });
    const mockB = createMockAdapter("router-b", {
      pool: [],
    });

    const coordinator = createDualRouterCoordinator({
      repository: repo,
      adapters: [mockA.adapter, mockB.adapter],
    });

    const report = await coordinator.run({
      mode: "full",
      trigger: "manual",
      now: 2000,
    });

    assert.equal(report.status, "verified");
    assert.equal(report.verifiedAt, 2000);
    assert.equal(report.conflicts.length, 0);

    // Operation was applied to router-b
    assert.equal(mockB.appliedOps.length, 1);
    assert.equal(mockB.appliedOps[0].kind, "create");
    assert.equal(mockB.appliedOps[0].key, "pool-1");

    // Baselines were saved in repository
    const baselines = repo.listBaselines();
    assert.ok(baselines.length >= 2);
    const nameBaseline = baselines.find((b) => b.key === "pool-1" && b.field === "name");
    assert.ok(nameBaseline);
    assert.equal(nameBaseline.value, "Pool One");

    // Coordinator status returns last verified report
    const lastRun = await coordinator.status();
    assert.ok(lastRun);
    assert.equal(lastRun.status, "verified");
    assert.equal(lastRun.verifiedAt, 2000);
  } finally {
    repo.close();
  }
});

test("Coordinator: Conflicts prevent verified status but allow independent operations to proceed", async () => {
  const dbPath = tempDbPath();
  const repo = openSyncRepository(dbPath);

  try {
    // Initial baseline for pool-1
    repo.saveBaseline({
      resource: "pool",
      key: "pool-1",
      field: "name",
      value: "Base Name",
      deleted: false,
      revision: 1,
    });

    // Both A and B edited pool-1.name divergently -> conflict
    // Router A also has an independent pool-2 -> should be applied safely to B
    const mockA = createMockAdapter("router-a", {
      pool: [
        {
          resource: "pool",
          key: "pool-1",
          localId: "pool-1",
          fields: { name: "Name on A" },
          revision: "2",
        },
        {
          resource: "pool",
          key: "pool-2",
          localId: "pool-2",
          fields: { name: "Independent Pool 2" },
          revision: "1",
        },
      ],
    });

    const mockB = createMockAdapter("router-b", {
      pool: [
        {
          resource: "pool",
          key: "pool-1",
          localId: "pool-1",
          fields: { name: "Name on B" },
          revision: "2",
        },
      ],
    });

    const coordinator = createDualRouterCoordinator({
      repository: repo,
      adapters: [mockA.adapter, mockB.adapter],
    });

    const report = await coordinator.run({
      mode: "full",
      trigger: "manual",
      now: 3000,
    });

    // Run status must be conflicted, verifiedAt null
    assert.equal(report.status, "conflicted");
    assert.equal(report.verifiedAt, null);
    assert.equal(report.conflicts.length, 1);
    assert.equal(report.conflicts[0].key, "pool-1");

    // Conflicted pool-1 edit was NOT applied
    const pool1Ops = mockB.appliedOps.filter((o) => o.key === "pool-1");
    assert.equal(pool1Ops.length, 0);

    // Independent pool-2 was applied safely to B!
    const pool2Ops = mockB.appliedOps.filter((o) => o.key === "pool-2");
    assert.equal(pool2Ops.length, 1);
    assert.equal(pool2Ops[0].kind, "create");

    // Baseline for independent pool-2 was saved
    const baselines = repo.listBaselines();
    const pool2Baseline = baselines.find((b) => b.key === "pool-2" && b.field === "name");
    assert.ok(pool2Baseline);
    assert.equal(pool2Baseline.value, "Independent Pool 2");
  } finally {
    repo.close();
  }
});

test("Coordinator: Lease locks overlapping runs and returns busy", async () => {
  const dbPath = tempDbPath();
  const repo = openSyncRepository(dbPath);

  try {
    const mockA = createMockAdapter("router-a");
    const mockB = createMockAdapter("router-b");

    const coordinator = createDualRouterCoordinator({
      repository: repo,
      adapters: [mockA.adapter, mockB.adapter],
    });

    // Manually hold lease under another owner
    const epoch = repo.acquireLease("other-worker", 5000, 30000);
    assert.ok(epoch);

    // Coordinator run must return busy
    const busyReport = await coordinator.run({
      mode: "full",
      trigger: "manual",
      now: 6000,
    });

    assert.equal(busyReport.status, "busy");
    assert.equal(mockA.appliedOps.length, 0);
    assert.equal(mockB.appliedOps.length, 0);

    // Release other worker lease
    repo.releaseLease("other-worker", epoch);

    // Coordinator now successfully runs
    const nextReport = await coordinator.run({
      mode: "full",
      trigger: "manual",
      now: 7000,
    });
    assert.equal(nextReport.status, "verified");
  } finally {
    repo.close();
  }
});

test("Coordinator: Conflict resolution rejects stale revision and applies resolved value on success", async () => {
  const dbPath = tempDbPath();
  const repo = openSyncRepository(dbPath);

  try {
    const conflict: Conflict = {
      id: "conflict:pool:p-conf:name",
      resource: "pool",
      key: "p-conf",
      field: "name",
      revision: 1,
      reason: "divergent",
      base: "Old Name",
      a: "Name from A",
      b: "Name from B",
    };
    repo.saveConflict(conflict);

    const mockA = createMockAdapter("router-a", {
      pool: [
        {
          resource: "pool",
          key: "p-conf",
          localId: "p-conf",
          fields: { name: "Name from A" },
          revision: "2",
        },
      ],
    });

    const mockB = createMockAdapter("router-b", {
      pool: [
        {
          resource: "pool",
          key: "p-conf",
          localId: "p-conf",
          fields: { name: "Name from B" },
          revision: "2",
        },
      ],
    });

    const coordinator = createDualRouterCoordinator({
      repository: repo,
      adapters: [mockA.adapter, mockB.adapter],
    });

    // Reject stale revision (revision 99 vs expected 1)
    await assert.rejects(
      async () => {
        await coordinator.resolve({
          id: conflict.id,
          revision: 99,
          value: "Resolved Name",
          actor: "admin",
        });
      },
      (err: Error) => {
        assert.match(err.message, /invalid or stale revision/);
        return true;
      },
    );

    // Valid revision resolves and triggers reconciliation run
    const report = await coordinator.resolve({
      id: conflict.id,
      revision: 1,
      value: "Resolved Name",
      actor: "admin",
    });

    assert.ok(report);
    // Baseline updated with resolved value
    const baselines = repo.listBaselines();
    const resolvedBaseline = baselines.find((b) => b.key === "p-conf" && b.field === "name");
    assert.ok(resolvedBaseline);
    assert.equal(resolvedBaseline.value, "Resolved Name");
  } finally {
    repo.close();
  }
});
