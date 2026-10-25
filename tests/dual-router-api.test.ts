import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApiApp } from "../src/server/api/app.js";
import type { ApiDependencies } from "../src/server/api/types.js";
import { openSyncRepository } from "../src/server/dual-router/repository.js";
import { createDualRouterCoordinator } from "../src/server/dual-router/coordinator.js";
import type {
  Capability,
  Conflict,
  Entity,
  Operation,
  Receipt,
  Resource,
  RouterAdapter,
  RunReport,
  Snapshot,
  UsageEvent,
  UsageWrite,
} from "../src/server/dual-router/types.js";

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dual-api-test-"));
  return path.join(dir, "sync.sqlite3");
}

function createMockAdapter(routerId: string, url = `http://${routerId}.internal`): RouterAdapter {
  return {
    routerId,
    url,
    async capabilities(): Promise<Capability[]> {
      return [
        {
          resource: "pool",
          read: true,
          export: false,
          write: true,
          conditional: false,
          evidence: "mock",
        },
      ];
    },
    async readState(): Promise<Snapshot> {
      return {
        routerId,
        scopes: {
          pool: {
            complete: true,
            entities: [
              {
                key: "pool-1",
                resource: "pool",
                localId: "p1",
                fields: { name: "Pool 1", active: true },
                revision: "rev1",
              },
            ],
            cursor: null,
            observedAt: Date.now(),
            error: null,
          },
          account: {
            complete: true,
            entities: [
              {
                key: "acc-1",
                resource: "account",
                localId: "a1",
                fields: { email: "acc@example.com", active: true },
                revision: "rev1",
              },
            ],
            cursor: null,
            observedAt: Date.now(),
            error: null,
          },
          settings: { complete: true, entities: [], cursor: null, observedAt: 0, error: null },
          role: { complete: true, entities: [], cursor: null, observedAt: 0, error: null },
          history: { complete: true, entities: [], cursor: null, observedAt: 0, error: null },
        },
      };
    },
    async apply(op: Operation): Promise<Receipt> {
      return { operationId: op.id, outcome: "applied", boundary: "bound1", evidence: null };
    },
    async readUsage(): Promise<UsageEvent[]> {
      return [];
    },
    async writeUsage(write: UsageWrite): Promise<Receipt> {
      return {
        operationId: write.operationId,
        outcome: "applied",
        boundary: "bound1",
        evidence: null,
      };
    },
    async readReceipt(opId: string): Promise<Receipt | null> {
      return { operationId: opId, outcome: "applied", boundary: "bound1", evidence: null };
    },
  };
}

function createBaseDeps(overrides: Partial<ApiDependencies> = {}): ApiDependencies {
  return {
    verifyControlPassword: (pass: string) => pass === "secret123",
    proxyIntelligenceRepo: {} as unknown as ApiDependencies["proxyIntelligenceRepo"],
    fleetRepo: {} as unknown as ApiDependencies["fleetRepo"],
    poolRanker: {} as unknown as ApiDependencies["poolRanker"],
    antigravityRotator: {} as unknown as ApiDependencies["antigravityRotator"],
    unifiedSyncCoordinator: {} as unknown as ApiDependencies["unifiedSyncCoordinator"],
    fleetWireguard: () => null,
    handleFleetRuntimeApi: async () => false,
    handleFleetApi: async () => false,
    handleProxyCheck: async () => false,
    router: {} as unknown as ApiDependencies["router"],
    settings: {} as unknown as ApiDependencies["settings"],
    legacyHandlers: {
      handleNineRouter: async () => {},
      handleAntigravity: async () => {},
      handleSettings: async () => {},
      handleIntelligence: async () => {},
      handleProxiesUnified: async () => {},
    },
    ...overrides,
  };
}

const authHeader = {
  Authorization: `Basic ${Buffer.from("admin:secret123").toString("base64")}`,
  "Content-Type": "application/json",
};

test("dual router api: GET /status returns unconfigured when coordinator is missing", async () => {
  const deps = createBaseDeps();
  const app = createApiApp(deps);

  const res = await app.request("/api/ninerouter/dual/status", { headers: authHeader });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.status, "unconfigured");
  assert.equal(data.activeConflictsCount, 0);
  assert.deepEqual(data.routers, []);
});

test("dual router api: GET /status returns complete status and metrics when configured", async () => {
  const repo = openSyncRepository(tempDbPath());
  const adapter1 = createMockAdapter("router-1");
  const adapter2 = createMockAdapter("router-2");
  const coordinator = createDualRouterCoordinator({
    repository: repo,
    adapters: [adapter1, adapter2],
  });

  const deps = createBaseDeps({
    dualRouterRepo: repo,
    dualRouterCoordinator: coordinator,
    dualRouterAdapters: [adapter1, adapter2],
  });
  const app = createApiApp(deps);

  const res = await app.request("/api/ninerouter/dual/status", { headers: authHeader });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.status, "idle");
  assert.equal(data.activeConflictsCount, 0);
  assert.equal(data.routers.length, 2);
  assert.equal(data.routers[0].id, "router-1");
  assert.equal(data.routers[0].reachable, true);
  assert.equal(data.routers[0].activePools, 1);
  assert.equal(data.routers[0].activeAccounts, 1);
  repo.close();
});

test("dual router api: GET /conflicts returns unresolved conflicts", async () => {
  const repo = openSyncRepository(tempDbPath());
  const conflict: Conflict = {
    id: "conflict:pool:p1:name",
    resource: "pool",
    key: "p1",
    field: "name",
    revision: 1,
    reason: "divergent",
    base: "Old Name",
    a: "Name R1",
    b: "Name R2",
  };
  repo.saveConflict(conflict);

  const deps = createBaseDeps({ dualRouterRepo: repo });
  const app = createApiApp(deps);

  const res = await app.request("/api/ninerouter/dual/conflicts", { headers: authHeader });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.total, 1);
  assert.equal(data.conflicts[0].id, conflict.id);
  repo.close();
});

test("dual router api: GET /conflicts and GET /status redact sensitive credentials", async () => {
  const repo = openSyncRepository(tempDbPath());
  const credConflict: Conflict = {
    id: "conflict:pool:p1:apiKey",
    resource: "pool",
    key: "p1",
    field: "apiKey",
    revision: 1,
    reason: "credential",
    base: "secret-base-key",
    a: "secret-key-a",
    b: "secret-key-b",
  };
  const passConflict: Conflict = {
    id: "conflict:account:a1:password",
    resource: "account",
    key: "a1",
    field: "password",
    revision: 1,
    reason: "divergent",
    base: "pass-old",
    a: "pass-new-a",
    b: "pass-new-b",
  };
  const safeConflict: Conflict = {
    id: "conflict:pool:p1:name",
    resource: "pool",
    key: "p1",
    field: "name",
    revision: 1,
    reason: "divergent",
    base: "Public Name",
    a: "Name Alpha",
    b: "Name Beta",
  };
  repo.saveConflict(credConflict);
  repo.saveConflict(passConflict);
  repo.saveConflict(safeConflict);

  const adapter1 = createMockAdapter("router-1");
  const adapter2 = createMockAdapter("router-2");
  const coordinator = createDualRouterCoordinator({
    repository: repo,
    adapters: [adapter1, adapter2],
  });

  const deps = createBaseDeps({
    dualRouterRepo: repo,
    dualRouterCoordinator: coordinator,
    dualRouterAdapters: [adapter1, adapter2],
  });
  const app = createApiApp(deps);

  // 1. Check GET /conflicts
  const resConflicts = await app.request("/api/ninerouter/dual/conflicts", { headers: authHeader });
  assert.equal(resConflicts.status, 200);
  const conflictsData = await resConflicts.json();
  const conflictsRawStr = JSON.stringify(conflictsData);

  assert.equal(conflictsRawStr.includes("secret-base-key"), false);
  assert.equal(conflictsRawStr.includes("secret-key-a"), false);
  assert.equal(conflictsRawStr.includes("secret-key-b"), false);
  assert.equal(conflictsRawStr.includes("pass-old"), false);
  assert.equal(conflictsRawStr.includes("pass-new-a"), false);
  assert.equal(conflictsRawStr.includes("pass-new-b"), false);
  assert.equal(conflictsRawStr.includes("Public Name"), true);
  assert.equal(conflictsRawStr.includes("Name Alpha"), true);

  const redCred = conflictsData.conflicts.find((c: Conflict) => c.field === "apiKey");
  assert.equal(redCred.base, "***REDACTED***");
  assert.equal(redCred.a, "***REDACTED***");
  assert.equal(redCred.b, "***REDACTED***");

  const redPass = conflictsData.conflicts.find((c: Conflict) => c.field === "password");
  assert.equal(redPass.base, "***REDACTED***");
  assert.equal(redPass.a, "***REDACTED***");
  assert.equal(redPass.b, "***REDACTED***");

  const redSafe = conflictsData.conflicts.find((c: Conflict) => c.field === "name");
  assert.equal(redSafe.base, "Public Name");
  assert.equal(redSafe.a, "Name Alpha");
  assert.equal(redSafe.b, "Name Beta");

  // 2. Check GET /status conflicts array
  const resStatus = await app.request("/api/ninerouter/dual/status", { headers: authHeader });
  assert.equal(resStatus.status, 200);
  const statusData = await resStatus.json();
  const statusRawStr = JSON.stringify(statusData);

  assert.equal(statusRawStr.includes("secret-base-key"), false);
  assert.equal(statusRawStr.includes("secret-key-a"), false);
  assert.equal(statusRawStr.includes("pass-old"), false);
  assert.equal(statusRawStr.includes("pass-new-a"), false);
  assert.equal(statusData.conflicts.length, 3);

  repo.close();
});

test("dual router api: POST /audit runs coordinator in audit mode", async () => {
  const repo = openSyncRepository(tempDbPath());
  const adapter1 = createMockAdapter("router-1");
  const adapter2 = createMockAdapter("router-2");
  const coordinator = createDualRouterCoordinator({
    repository: repo,
    adapters: [adapter1, adapter2],
  });

  const deps = createBaseDeps({
    dualRouterRepo: repo,
    dualRouterCoordinator: coordinator,
    dualRouterAdapters: [adapter1, adapter2],
  });
  const app = createApiApp(deps);

  const res = await app.request("/api/ninerouter/dual/audit", {
    method: "POST",
    headers: authHeader,
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.ok(data.report.id);
  repo.close();
});

test("dual router api: POST /reconcile runs coordinator incremental or full mode", async () => {
  const repo = openSyncRepository(tempDbPath());
  const adapter1 = createMockAdapter("router-1");
  const adapter2 = createMockAdapter("router-2");
  const coordinator = createDualRouterCoordinator({
    repository: repo,
    adapters: [adapter1, adapter2],
  });

  const deps = createBaseDeps({
    dualRouterRepo: repo,
    dualRouterCoordinator: coordinator,
    dualRouterAdapters: [adapter1, adapter2],
  });
  const app = createApiApp(deps);

  const res = await app.request("/api/ninerouter/dual/reconcile", {
    method: "POST",
    headers: authHeader,
    body: JSON.stringify({ mode: "full" }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.ok(data.report.id);
  repo.close();
});

test("dual router api: POST /conflicts/:id/resolve resolves conflict or rejects stale revision", async () => {
  const repo = openSyncRepository(tempDbPath());
  const adapter1 = createMockAdapter("router-1");
  const adapter2 = createMockAdapter("router-2");
  const conflict: Conflict = {
    id: "conflict:pool:p1:name",
    resource: "pool",
    key: "p1",
    field: "name",
    revision: 2,
    reason: "divergent",
    base: "Old Name",
    a: "Name R1",
    b: "Name R2",
  };
  repo.saveConflict(conflict);

  const coordinator = createDualRouterCoordinator({
    repository: repo,
    adapters: [adapter1, adapter2],
  });

  const deps = createBaseDeps({
    dualRouterRepo: repo,
    dualRouterCoordinator: coordinator,
    dualRouterAdapters: [adapter1, adapter2],
  });
  const app = createApiApp(deps);

  // Stale revision: expect 409 Conflict
  const resStale = await app.request(`/api/ninerouter/dual/conflicts/${conflict.id}/resolve`, {
    method: "POST",
    headers: authHeader,
    body: JSON.stringify({ revision: 999, value: "Resolved Name" }),
  });
  assert.equal(resStale.status, 409);

  // Correct revision: expect 200 OK
  const resValid = await app.request(`/api/ninerouter/dual/conflicts/${conflict.id}/resolve`, {
    method: "POST",
    headers: authHeader,
    body: JSON.stringify({ revision: 2, value: "Resolved Name" }),
  });
  assert.equal(resValid.status, 200);
  const validData = await resValid.json();
  assert.equal(validData.ok, true);

  // Conflict should now be resolved
  assert.equal(repo.listConflicts().length, 0);
  repo.close();
});

test("dual router api: POST /usage/write-back checks authorization policy", async () => {
  const repo = openSyncRepository(tempDbPath());
  const adapter1 = createMockAdapter("router-1");
  const deps = createBaseDeps({
    dualRouterRepo: repo,
    dualRouterAdapters: [adapter1],
  });
  const app = createApiApp(deps);

  // Policy has usageWriteBackAuthorized = false by default
  const resForbidden = await app.request("/api/ninerouter/dual/usage/write-back", {
    method: "POST",
    headers: authHeader,
    body: JSON.stringify({ writes: [] }),
  });
  assert.equal(resForbidden.status, 403);

  // Authorize write-back in policy
  repo.savePolicy({
    enabled: true,
    usageWriteBackAuthorized: true,
    nextIncrementalAt: 0,
    nextFullAt: 0,
  });

  const resOk = await app.request("/api/ninerouter/dual/usage/write-back", {
    method: "POST",
    headers: authHeader,
    body: JSON.stringify({
      writes: [
        {
          operationId: "write-1",
          routerId: "router-1",
          scope: {
            accountKey: "acc1",
            provider: "gemini",
            model: "flash",
            metric: "tokens",
            unit: "count",
            currency: null,
            periodStart: "2026-01-01T00:00:00Z",
            periodEnd: "2026-01-01T01:00:00Z",
          },
          ledgerRevision: 1,
          strategy: "absolute",
          amount: "100",
          expectedBoundary: "b1",
        },
      ],
    }),
  });
  assert.equal(resOk.status, 200);
  const data = await resOk.json();
  assert.equal(data.ok, true);
  assert.equal(data.receipts.length, 1);
  assert.equal(data.receipts[0].outcome, "applied");

  repo.close();
});
