import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { getRequestListener } from "@hono/node-server";
import { createApiApp } from "../src/server/api/app.js";
import type { ApiDependencies } from "../src/server/api/types.js";
import { openSyncRepository } from "../src/server/dual-router/repository.js";
import { createDualRouterCoordinator } from "../src/server/dual-router/coordinator.js";
import { createDualRouterScheduler } from "../src/server/dual-router/scheduler.js";
import { createUnifiedSyncCoordinator } from "../src/server/unified-sync-coordinator.js";
import {
  fetchDualRouterStatus,
  fetchDualRouterConflicts,
  triggerDualRouterAudit,
  triggerDualRouterReconcile,
  resolveDualRouterConflict,
} from "../src/lib/api.js";
import type {
  Capability,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dual-integration-test-"));
  return path.join(dir, "sync.sqlite3");
}

function createMemoryAdapter(
  routerId: string,
  initialEntities: Partial<Record<Resource, Entity[]>> = {},
): {
  adapter: RouterAdapter;
  state: Map<Resource, Map<string, Entity>>;
  appliedOps: Operation[];
  writes: UsageWrite[];
} {
  const appliedOps: Operation[] = [];
  const writes: UsageWrite[] = [];
  const state = new Map<Resource, Map<string, Entity>>();

  const resources: Resource[] = ["pool", "account", "settings", "role", "history"];
  for (const r of resources) {
    const map = new Map<string, Entity>();
    for (const e of initialEntities[r] ?? []) {
      map.set(e.key, structuredClone(e));
    }
    state.set(r, map);
  }

  const adapter: RouterAdapter = {
    routerId,
    url: `http://${routerId}.internal`,
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
        {
          resource: "account",
          read: true,
          export: false,
          write: true,
          conditional: false,
          evidence: "mock",
        },
      ];
    },
    async readState(): Promise<Snapshot> {
      const scopes: Snapshot["scopes"] = {} as Snapshot["scopes"];
      for (const r of resources) {
        scopes[r] = {
          complete: true,
          entities: Array.from(state.get(r)!.values()).map((e) => structuredClone(e)),
          cursor: null,
          observedAt: Date.now(),
          error: null,
        };
      }
      return { routerId, scopes };
    },
    async apply(op: Operation): Promise<Receipt> {
      appliedOps.push(op);
      const resMap = state.get(op.resource);
      if (resMap) {
        if (op.kind === "delete") {
          resMap.delete(op.key);
        } else if (op.kind === "create" || op.kind === "update") {
          const existing = resMap.get(op.key);
          if (op.field !== null && existing) {
            existing.fields[op.field] = op.desired;
          } else {
            resMap.set(op.key, {
              key: op.key,
              resource: op.resource,
              localId: op.key,
              fields:
                typeof op.desired === "object" && op.desired !== null
                  ? (op.desired as Record<string, Value>)
                  : {},
              revision: "rev-new",
            });
          }
        }
      }
      return { operationId: op.id, outcome: "applied", boundary: "boundary-1", evidence: null };
    },
    async readUsage(): Promise<UsageEvent[]> {
      return [];
    },
    async writeUsage(write: UsageWrite): Promise<Receipt> {
      writes.push(write);
      return {
        operationId: write.operationId,
        outcome: "applied",
        boundary: "boundary-1",
        evidence: null,
      };
    },
    async readReceipt(operationId: string): Promise<Receipt | null> {
      return { operationId, outcome: "applied", boundary: "boundary-1", evidence: null };
    },
  };

  return { adapter, state, appliedOps, writes };
}

function createBaseDeps(overrides: Partial<ApiDependencies> = {}): ApiDependencies {
  return {
    verifyControlPassword: (pass: string) => pass === "integration-secret",
    proxyIntelligenceRepo: {} as unknown as ApiDependencies["proxyIntelligenceRepo"],
    fleetRepo: {} as unknown as ApiDependencies["fleetRepo"],
    poolRanker: {
      syncPools: async () => ({ synced: true }),
      isSyncing: () => false,
    } as unknown as ApiDependencies["poolRanker"],
    antigravityRotator: {
      runRotation: async () => ({ rotated: true }),
      isRunning: false,
    } as unknown as ApiDependencies["antigravityRotator"],
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

test("dual router integration: scheduler ticks during unified sync cycle", async () => {
  const repo = openSyncRepository(tempDbPath());
  const r1 = createMemoryAdapter("router-1");
  const r2 = createMemoryAdapter("router-2");
  const coordinator = createDualRouterCoordinator({
    repository: repo,
    adapters: [r1.adapter, r2.adapter],
  });
  const scheduler = createDualRouterScheduler({
    repository: repo,
    coordinator,
  });

  const unified = createUnifiedSyncCoordinator({
    poolRanker: { syncPools: async () => ({ ok: true }), isSyncing: () => false },
    antigravityRotator: { runRotation: async () => ({ ok: true }), isRunning: false },
    dualRouterScheduler: scheduler,
  });

  const report = await unified.runUnifiedSyncCycle({ force: true });
  assert.equal(report.started, true);
  assert.ok(report.completedAt);
  assert.ok(report.dualRouterResult !== undefined);

  repo.close();
});

test("dual router integration: full reconciliation propagates missing resources between masters", async () => {
  const repo = openSyncRepository(tempDbPath());

  const pool1: Entity = {
    key: "pool:http://proxy1:8080",
    resource: "pool",
    localId: "p1",
    fields: { name: "Primary Proxy", active: true, latency: 50 },
    revision: "rev-1",
  };

  const r1 = createMemoryAdapter("router-1", { pool: [pool1] });
  const r2 = createMemoryAdapter("router-2", { pool: [] });

  const coordinator = createDualRouterCoordinator({
    repository: repo,
    adapters: [r1.adapter, r2.adapter],
  });

  // Step 1: Run audit (read-only) -> r2 state unchanged
  const auditReport = await coordinator.run({ mode: "audit", trigger: "manual", now: Date.now() });
  assert.equal(auditReport.status, "verified");
  assert.equal(r2.state.get("pool")!.has(pool1.key), false);

  // Step 2: Run incremental reconcile -> propagates pool1 to r2
  const reconcileReport = await coordinator.run({
    mode: "incremental",
    trigger: "manual",
    now: Date.now(),
  });
  assert.equal(reconcileReport.status, "verified");
  assert.equal(r2.state.get("pool")!.has(pool1.key), true);
  assert.equal(r2.appliedOps.length > 0, true);

  repo.close();
});

test("dual router integration: conflict detection, status API, and resolution via SDK", async () => {
  const repo = openSyncRepository(tempDbPath());

  const r1 = createMemoryAdapter("router-1", {
    pool: [
      {
        key: "pool:conflict-proxy",
        resource: "pool",
        localId: "cp",
        fields: { name: "Router 1 Name", active: true },
        revision: "rev-a",
      },
    ],
  });

  const r2 = createMemoryAdapter("router-2", {
    pool: [
      {
        key: "pool:conflict-proxy",
        resource: "pool",
        localId: "cp",
        fields: { name: "Router 2 Name", active: true },
        revision: "rev-b",
      },
    ],
  });

  const coordinator = createDualRouterCoordinator({
    repository: repo,
    adapters: [r1.adapter, r2.adapter],
  });
  const scheduler = createDualRouterScheduler({
    repository: repo,
    coordinator,
  });

  const deps = createBaseDeps({
    dualRouterRepo: repo,
    dualRouterCoordinator: coordinator,
    dualRouterScheduler: scheduler,
    dualRouterAdapters: [r1.adapter, r2.adapter],
  });
  const app = createApiApp(deps);

  // Start real HTTP server for client SDK tests
  const server = http.createServer(getRequestListener(app.fetch));
  const listenResolvers = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listenResolvers.resolve());
  await listenResolvers.promise;
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  // Patch global fetch to route relative requests to our test server
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" && input.startsWith("/") ? `${baseUrl}${input}` : input;
    return originalFetch(url, init);
  };

  try {
    // 1. Initial status: idle
    const statusBefore = await fetchDualRouterStatus("integration-secret");
    assert.equal(statusBefore.ok, true);
    assert.equal(statusBefore.routers?.length, 2);

    // 2. Run reconcile: detects divergent conflict
    const recReport = await triggerDualRouterReconcile("incremental", "integration-secret");
    assert.equal(recReport.ok, true);
    assert.equal(recReport.report.status, "conflicted");

    // 3. Status shows conflicted
    const statusConflicted = await fetchDualRouterStatus("integration-secret");
    assert.equal(statusConflicted.ok, true);
    assert.equal(statusConflicted.status, "conflicted");
    assert.equal(statusConflicted.activeConflictsCount > 0, true);

    // 4. Fetch conflicts list via SDK
    const conflictList = await fetchDualRouterConflicts("integration-secret");
    assert.equal(conflictList.ok, true);
    assert.equal(conflictList.total > 0, true);
    const targetConflict = conflictList.conflicts[0];

    // 5. Resolve conflict via SDK
    const resolveResult = await resolveDualRouterConflict(
      targetConflict.id,
      targetConflict.revision,
      "Resolved Master Proxy Name",
      "integration-secret",
    );
    assert.equal(resolveResult.ok, true);

    // 6. Conflicts count is now 0
    const conflictListAfter = await fetchDualRouterConflicts("integration-secret");
    assert.equal(conflictListAfter.ok, true);
    assert.equal(conflictListAfter.total, 0);
  } finally {
    globalThis.fetch = originalFetch;
    const closeResolvers = Promise.withResolvers<void>();
    server.close(() => closeResolvers.resolve());
    await closeResolvers.promise;
    repo.close();
  }
});
