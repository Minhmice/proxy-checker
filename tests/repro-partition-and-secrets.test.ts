import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { planMerge } from "../src/server/dual-router/merge.js";
import { openSyncRepository } from "../src/server/dual-router/repository.js";
import { createDualRouterCoordinator } from "../src/server/dual-router/coordinator.js";
import { createDualRouterRoutes } from "../src/server/api/routes/dual-router.js";
import type { ApiDependencies } from "../src/server/api/types.js";
import type {
  Baseline,
  Capability,
  Conflict,
  Entity,
  Operation,
  Receipt,
  Resource,
  RouterAdapter,
  RunReport,
  ScopeSnapshot,
  Snapshot,
  SyncRepository,
  UsageEvent,
  UsageWrite,
} from "../src/server/dual-router/types.js";

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repro-partition-secrets-"));
  return path.join(dir, "sync.sqlite3");
}

function makeScope(
  entities: Entity[] = [],
  complete = true,
  error: string | null = null,
): ScopeSnapshot {
  return {
    complete,
    entities,
    cursor: null,
    observedAt: Date.now(),
    error,
  };
}

function makeSnapshot(
  routerId: string,
  scopes: Partial<Record<Resource, ScopeSnapshot>> = {},
): Snapshot {
  return {
    routerId,
    scopes: {
      pool: scopes.pool ?? makeScope([], true),
      account: scopes.account ?? makeScope([], true),
      settings: scopes.settings ?? makeScope([], true),
      role: scopes.role ?? makeScope([], true),
      history: scopes.history ?? makeScope([], true),
    },
  };
}

test("Ca 1.1: Single Router Failure / Partition - complete: false blocks mutation operations", () => {
  // Router A has an entity that does not exist on Router B.
  // Router B failed to fetch pool scope completely: complete: false, entities: []
  const entityOnA: Entity = {
    key: "pool-live-1",
    resource: "pool",
    localId: "p1",
    fields: { name: "Live Production Pool", active: true },
    revision: "1",
  };

  const snapshotA = makeSnapshot("router-a", {
    pool: makeScope([entityOnA], true),
  });

  const snapshotB = makeSnapshot("router-b", {
    pool: makeScope([], false, "ECONNRESET / Partial network timeout"),
  });

  const plan = planMerge({
    a: snapshotA,
    b: snapshotB,
    baselines: [],
  });

  // Quan sát 1: incompleteScopes có ghi nhận 'pool' không?
  assert.ok(
    plan.incompleteScopes.includes("pool"),
    "incompleteScopes should include 'pool' when Router B has complete: false",
  );

  // Quan sát 2: incompleteScopes có chặn được lệnh sinh ra không?
  // Kỳ vọng an toàn: Khi scope của Router B bị incomplete/lỗi, không được tự ý lập kế hoạch push sang Router B.
  // Thực tế hiện tại: planMerge vẫn sinh lệnh 'create' trên router-b!
  const createOpsOnB = plan.operations.filter(
    (op) => op.routerId === "router-b" && op.resource === "pool" && op.kind === "create",
  );

  console.log("\n[Repro Ca 1.1] Incomplete Scope Operations:");
  console.log("incompleteScopes:", plan.incompleteScopes);
  console.log("Operations generated:", plan.operations);

  assert.equal(
    createOpsOnB.length,
    0,
    "Incomplete scope on Router B must prevent 'create' operations to Router B",
  );
});

test("Ca 1.2: Single Router Failure / Partition - Missing scope does NOT cause wrongful DELETE on live router", () => {
  // Baseline: entity 'pool-critical' existed on both routers and baseline was saved.
  const baselines: Baseline[] = [
    {
      resource: "pool",
      key: "pool-critical",
      field: "name",
      value: "Critical Active Pool",
      deleted: false,
      revision: 1,
    },
    {
      resource: "pool",
      key: "pool-critical",
      field: "active",
      value: true,
      deleted: false,
      revision: 1,
    },
  ];

  const entityOnA: Entity = {
    key: "pool-critical",
    resource: "pool",
    localId: "p-crit",
    fields: { name: "Critical Active Pool", active: true },
    revision: "1",
  };

  // Router A has the entity intact
  const snapshotA = makeSnapshot("router-a", {
    pool: makeScope([entityOnA], true),
  });

  // Router B is partitioned or its adapter failed to return pool scope at all
  // scopes: {}
  const snapshotB: Snapshot = {
    routerId: "router-b",
    scopes: {} as unknown as Record<Resource, ScopeSnapshot>,
  };

  const plan = planMerge({
    a: snapshotA,
    b: snapshotB,
    baselines,
  });

  console.log("\n[Repro Ca 1.2] Missing Scope Handling:");
  console.log("incompleteScopes:", plan.incompleteScopes);
  console.log("Operations generated:", plan.operations);

  // Quan sát: Router B bị mất scope 'pool' hoàn toàn (undefined scope).
  // Vì `scopeB?.complete !== false` là true khi scopeB là undefined,
  // merge engine ngộ nhận Router B đã xóa sạch pool hợp lệ,
  // và sinh ra lệnh DELETE pool-critical trên ROUTER A (router đang sống bình thường)!
  const deleteOpsOnA = plan.operations.filter(
    (op) => op.routerId === "router-a" && op.resource === "pool" && op.kind === "delete",
  );

  assert.equal(
    deleteOpsOnA.length,
    0,
    "Missing scope on Router B must NEVER result in DELETE operations on healthy Router A",
  );
});

test("Ca 1.3: Single Router Failure / Partition - Network error in adapter handled safely without crash", async () => {
  const dbPath = tempDbPath();
  const repo: SyncRepository = openSyncRepository(dbPath);

  const adapterA: RouterAdapter = {
    routerId: "router-a",
    url: "http://router-a.internal",
    async capabilities(): Promise<Capability[]> {
      return [
        {
          resource: "pool",
          read: true,
          export: false,
          write: true,
          conditional: false,
          evidence: "ok",
        },
      ];
    },
    async readState(): Promise<Snapshot> {
      return makeSnapshot("router-a");
    },
    async apply(op: Operation): Promise<Receipt> {
      return { operationId: op.id, outcome: "applied", boundary: null, evidence: null };
    },
    async readUsage(): Promise<UsageEvent[]> {
      return [];
    },
    async writeUsage(write: UsageWrite): Promise<Receipt> {
      return { operationId: write.operationId, outcome: "applied", boundary: null, evidence: null };
    },
    async readReceipt(): Promise<Receipt | null> {
      return null;
    },
  };

  const adapterB: RouterAdapter = {
    routerId: "router-b",
    url: "http://router-b.internal",
    async capabilities(): Promise<Capability[]> {
      return [
        {
          resource: "pool",
          read: true,
          export: false,
          write: true,
          conditional: false,
          evidence: "ok",
        },
      ];
    },
    async readState(): Promise<Snapshot> {
      throw new Error("ECONNREFUSED: connect ECONNREFUSED 192.168.1.50:8080");
    },
    async apply(op: Operation): Promise<Receipt> {
      throw new Error("Cannot apply to offline router");
    },
    async readUsage(): Promise<UsageEvent[]> {
      return [];
    },
    async writeUsage(): Promise<Receipt> {
      throw new Error("Cannot write usage to offline router");
    },
    async readReceipt(): Promise<Receipt | null> {
      return null;
    },
  };

  const coordinator = createDualRouterCoordinator({
    repository: repo,
    adapters: [adapterA, adapterB],
  });

  // Quan sát: Khi một router gặp sự cố mạng (ECONNREFUSED), coordinator.run()
  // không bọc lỗi hay trả về report có status degraded/failed, mà ném exception unhandled làm sập quy trình sync.
  let errorCaught: Error | null = null;
  let runReport: RunReport | null = null;
  try {
    runReport = await coordinator.run({ now: Date.now(), mode: "audit", trigger: "manual" });
  } catch (err) {
    errorCaught = err as Error;
  }

  console.log("\n[Repro Ca 1.3] Coordinator Network Error Exception:");
  console.log("Error caught:", errorCaught?.message);
  console.log("Run report status:", runReport?.status);

  assert.equal(
    errorCaught,
    null,
    "Coordinator must not crash with unhandled exception on network error",
  );
  assert.ok(runReport !== null, "Coordinator must return a safe RunReport");
  assert.equal(runReport.status, "partial");
  assert.deepEqual(runReport.operations, []);
  assert.deepEqual(runReport.conflicts, []);
  assert.ok(runReport.unmetCapabilities.includes("router-unreachable-abort"));
});

test("Ca 2: Secret Leakage in Conflicts API - Sensitive keys and passwords exposed in plaintext", async () => {
  const dbPath = tempDbPath();
  const repo: SyncRepository = openSyncRepository(dbPath);

  // 1. Tạo 2 snapshot có trường nhạy cảm apiKey và password bị xung đột giá trị
  const snapshotA = makeSnapshot("router-a", {
    pool: makeScope([
      {
        key: "provider-upstream-1",
        resource: "pool",
        localId: "p-upstream-1",
        fields: {
          apiKey: "secret_live_key_999",
          password: "super_secret_password",
          name: "Main Upstream",
        },
        revision: "1",
      },
    ]),
  });

  const snapshotB = makeSnapshot("router-b", {
    pool: makeScope([
      {
        key: "provider-upstream-1",
        resource: "pool",
        localId: "p-upstream-1",
        fields: {
          apiKey: "secret_live_key_888_diverged",
          password: "super_secret_password_changed",
          name: "Main Upstream",
        },
        revision: "2",
      },
    ]),
  });

  // 2. Chạy qua planMerge
  const plan = planMerge({
    a: snapshotA,
    b: snapshotB,
    baselines: [],
  });

  console.log("\n[Repro Ca 2] Conflicts generated by planMerge:");
  console.log(plan.conflicts);

  assert.ok(plan.conflicts.length >= 2, "Conflicts detected for sensitive fields");
  for (const c of plan.conflicts) {
    repo.saveConflict(c);
  }

  // 3. Khởi tạo route GET /api/ninerouter/dual/conflicts
  const mockDeps: Partial<ApiDependencies> = {
    dualRouterRepo: repo,
    dualRouterCoordinator: {} as ApiDependencies["dualRouterCoordinator"],
    dualRouterAdapters: [],
  };

  const app = new Hono();
  app.route("/api/ninerouter/dual", createDualRouterRoutes(mockDeps as ApiDependencies));

  // 4. Gọi API GET /api/ninerouter/dual/conflicts
  const res = await app.request("/api/ninerouter/dual/conflicts");
  assert.equal(res.status, 200);

  const jsonBody = (await res.json()) as { ok: boolean; conflicts: Conflict[]; total: number };
  const rawResponseString = JSON.stringify(jsonBody);

  console.log("\n[Repro Ca 2] API Response Body (/api/ninerouter/dual/conflicts):");
  console.log(rawResponseString);

  // 5. Kiểm tra rò rỉ secret trong response
  const leaksApiKeyA = rawResponseString.includes("secret_live_key_999");
  const leaksPasswordA = rawResponseString.includes("super_secret_password");
  const leaksApiKeyB = rawResponseString.includes("secret_live_key_888_diverged");
  const leaksPasswordB = rawResponseString.includes("super_secret_password_changed");

  console.log("Secret leakage findings:");
  console.log("  secret_live_key_999 leaked:", leaksApiKeyA);
  console.log("  super_secret_password leaked:", leaksPasswordA);
  console.log("  secret_live_key_888_diverged leaked:", leaksApiKeyB);
  console.log("  super_secret_password_changed leaked:", leaksPasswordB);

  // Xác minh an toàn: Chuỗi bí mật đã được che giấu bằng ***REDACTED***
  assert.equal(leaksApiKeyA, false, "secret_live_key_999 must NOT leak in conflicts API response!");
  assert.equal(
    leaksPasswordA,
    false,
    "super_secret_password must NOT leak in conflicts API response!",
  );
  assert.equal(
    leaksApiKeyB,
    false,
    "secret_live_key_888_diverged must NOT leak in conflicts API response!",
  );
  assert.equal(
    leaksPasswordB,
    false,
    "super_secret_password_changed must NOT leak in conflicts API response!",
  );

  // Kiểm tra chi tiết từng field trong Conflict object đã được redact
  const apiKeyConflict = jsonBody.conflicts.find((c) => c.field === "apiKey");
  assert.ok(apiKeyConflict, "apiKey conflict should be present");
  assert.equal(apiKeyConflict.a, "***REDACTED***");
  assert.equal(apiKeyConflict.b, "***REDACTED***");
  assert.equal(apiKeyConflict.reason, "credential");

  const passwordConflict = jsonBody.conflicts.find((c) => c.field === "password");
  assert.ok(passwordConflict, "password conflict should be present");
  assert.equal(passwordConflict.a, "***REDACTED***");
  assert.equal(passwordConflict.b, "***REDACTED***");
});
