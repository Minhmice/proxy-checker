import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSyncRepository } from "../src/server/dual-router/repository.js";
import {
  aggregateUsage,
  chooseWriteStrategy,
  createUsageService,
} from "../src/server/dual-router/usage.js";
import type {
  Capability,
  Operation,
  Receipt,
  RouterAdapter,
  Snapshot,
  UsageEvent,
  UsageScope,
  UsageWrite,
} from "../src/server/dual-router/types.js";

const sampleScope: UsageScope = {
  accountKey: "ag:subject-1",
  provider: "antigravity",
  model: "gemini",
  metric: "requests",
  unit: "count",
  currency: null,
  periodStart: "2026-10-01",
  periodEnd: "2026-11-01",
};

function makeEvent(
  id: string,
  amount: string,
  options: {
    provenance?: "native" | "replicated";
    accuracy?: "exact" | "approximate" | "incomplete";
    scope?: UsageScope;
    sourceRouterId?: string;
  } = {},
): UsageEvent {
  return {
    id,
    namespace: "provider-global",
    sourceRouterId: options.sourceRouterId ?? "router-a",
    scope: options.scope ?? sampleScope,
    amount,
    accuracy: options.accuracy ?? "exact",
    provenance: options.provenance ?? "native",
    generation: "1",
    cursor: id,
    observedAt: 1000,
  };
}

function createMockAdapter(
  routerId: string,
  overrides: {
    readUsage?: () => Promise<UsageEvent[]>;
    writeUsage?: (write: UsageWrite) => Promise<Receipt>;
    readReceipt?: (operationId: string) => Promise<Receipt | null>;
  } = {},
): RouterAdapter {
  const receiptCache = new Map<string, Receipt>();

  return {
    routerId,
    url: `http://${routerId}.local`,
    async capabilities(): Promise<Capability[]> {
      return [];
    },
    async readState(): Promise<Snapshot> {
      const empty = () => ({
        complete: true,
        entities: [],
        cursor: null,
        observedAt: Date.now(),
        error: null,
      });
      return {
        routerId,
        scopes: {
          pool: empty(),
          account: empty(),
          settings: empty(),
          role: empty(),
          history: empty(),
        },
      };
    },
    async apply(_operation: Operation): Promise<Receipt> {
      return { operationId: _operation.id, outcome: "applied", boundary: null, evidence: null };
    },
    async readUsage(): Promise<UsageEvent[]> {
      if (overrides.readUsage) return overrides.readUsage();
      return [];
    },
    async writeUsage(write: UsageWrite): Promise<Receipt> {
      if (overrides.writeUsage) return overrides.writeUsage(write);
      const receipt: Receipt = {
        operationId: write.operationId,
        outcome: "applied",
        boundary: "b-1",
        evidence: "written",
      };
      receiptCache.set(write.operationId, receipt);
      return receipt;
    },
    async readReceipt(operationId: string): Promise<Receipt | null> {
      if (overrides.readReceipt) return overrides.readReceipt(operationId);
      return receiptCache.get(operationId) ?? null;
    },
  };
}

test("chooseWriteStrategy selects appropriate strategy", () => {
  assert.equal(chooseWriteStrategy({ absoluteSafe: true, deltaIdempotent: true }), "absolute");
  assert.equal(chooseWriteStrategy({ absoluteSafe: true, deltaIdempotent: false }), "absolute");
  assert.equal(chooseWriteStrategy({ absoluteSafe: false, deltaIdempotent: true }), "delta");
  assert.equal(chooseWriteStrategy({ absoluteSafe: false, deltaIdempotent: false }), null);
});

test("aggregateUsage sums exact large integers without IEEE 754 precision loss", () => {
  // Beyond Number.MAX_SAFE_INTEGER (9007199254740991)
  const e1 = makeEvent("1", "9007199254740993");
  const e2 = makeEvent("2", "1");
  const result = aggregateUsage([e1, e2]);

  assert.equal(result.amount, "9007199254740994");
  assert.equal(result.accuracy, "exact");
});

test("aggregateUsage sums decimals with differing precision and trims trailing zeros", () => {
  const e1 = makeEvent("1", "100.5");
  const e2 = makeEvent("2", "200.25");
  const e3 = makeEvent("3", "0.005");
  const result = aggregateUsage([e1, e2, e3]);

  assert.equal(result.amount, "300.755");

  const e4 = makeEvent("4", "0.25");
  const e5 = makeEvent("5", "0.75");
  assert.equal(aggregateUsage([e4, e5]).amount, "1");
});

test("aggregateUsage ignores replicated provenance in native aggregate", () => {
  const e1 = makeEvent("1", "50", { provenance: "native" });
  const e2 = makeEvent("2", "1000", { provenance: "replicated" });
  const result = aggregateUsage([e1, e2]);

  assert.equal(result.amount, "50");

  const allReplicated = aggregateUsage([e2]);
  assert.equal(allReplicated.amount, "0");
});

test("aggregateUsage escalates accuracy: exact < approximate < incomplete", () => {
  const e1 = makeEvent("1", "10", { accuracy: "exact" });
  const e2 = makeEvent("2", "20", { accuracy: "approximate" });
  const e3 = makeEvent("3", "30", { accuracy: "incomplete" });

  assert.equal(aggregateUsage([e1]).accuracy, "exact");
  assert.equal(aggregateUsage([e1, e2]).accuracy, "approximate");
  assert.equal(aggregateUsage([e1, e2, e3]).accuracy, "incomplete");
  assert.equal(aggregateUsage([e1, e3]).accuracy, "incomplete");
});

test("aggregateUsage rejects mixed scopes", () => {
  const base = makeEvent("1", "10");

  const diffProvider = makeEvent("2", "10", {
    scope: { ...sampleScope, provider: "openai" },
  });
  assert.throws(() => aggregateUsage([base, diffProvider]), /Incompatible usage scopes/);

  const diffMetric = makeEvent("3", "10", {
    scope: { ...sampleScope, metric: "tokens" },
  });
  assert.throws(() => aggregateUsage([base, diffMetric]), /Incompatible usage scopes/);

  const diffCurrency = makeEvent("4", "10", {
    scope: { ...sampleScope, currency: "USD" },
  });
  assert.throws(() => aggregateUsage([base, diffCurrency]), /Incompatible usage scopes/);

  const diffPeriod = makeEvent("5", "10", {
    scope: { ...sampleScope, periodStart: "2026-11-01" },
  });
  assert.throws(() => aggregateUsage([base, diffPeriod]), /Incompatible usage scopes/);
});

test("aggregateUsage rejects invalid and negative amounts", () => {
  const negative = makeEvent("1", "-10");
  assert.throws(() => aggregateUsage([negative]), /Negative usage amount not permitted/);

  const invalid = makeEvent("2", "abc");
  assert.throws(() => aggregateUsage([invalid]), /Invalid decimal amount string/);
});

test("createUsageService ingest skips replicated events and handles duplicate events", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-sync-usage-"));
  const repo = openSyncRepository(path.join(dir, "sync.sqlite3"));

  try {
    const e1 = makeEvent("e-1", "10", { provenance: "native" });
    const e2 = makeEvent("e-2", "20", { provenance: "replicated" });

    const adapter = createMockAdapter("router-a", {
      async readUsage() {
        return [e1, e2];
      },
    });

    const service = createUsageService({ repository: repo, adapters: [adapter] });

    // First ingest: e1 inserted, e2 skipped
    const first = await service.ingest();
    assert.equal(first.inserted, 1);
    assert.equal(first.blockedScopes.length, 0);

    const listed = repo.listUsage(sampleScope);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, "e-1");

    // Second ingest with exact same event: deduplicated, inserted = 0
    const second = await service.ingest();
    assert.equal(second.inserted, 0);
    assert.equal(second.blockedScopes.length, 0);
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createUsageService ingest captures integrity conflict in blockedScopes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-sync-usage-conflict-"));
  const repo = openSyncRepository(path.join(dir, "sync.sqlite3"));

  try {
    const e1 = makeEvent("e-conflict", "10");
    repo.appendUsage(e1);

    // Same id and namespace, different amount -> integrity conflict in repository
    const conflicting = makeEvent("e-conflict", "99");
    const adapter = createMockAdapter("router-a", {
      async readUsage() {
        return [conflicting];
      },
    });

    const service = createUsageService({ repository: repo, adapters: [adapter] });
    const res = await service.ingest();

    assert.equal(res.inserted, 0);
    assert.equal(res.blockedScopes.length, 1);
    assert.ok(res.blockedScopes[0].includes("antigravity:ag:subject-1"));
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createUsageService writeBack prepares write, calls adapter, records receipts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-sync-usage-wb-"));
  const repo = openSyncRepository(path.join(dir, "sync.sqlite3"));

  try {
    let adapterWriteCalled = false;
    const adapterA = createMockAdapter("router-a", {
      async writeUsage(write) {
        adapterWriteCalled = true;
        return {
          operationId: write.operationId,
          outcome: "applied",
          boundary: "checkpoint-1",
          evidence: "applied-ok",
        };
      },
    });

    const service = createUsageService({ repository: repo, adapters: [adapterA] });

    const writeA: UsageWrite = {
      operationId: "op-wb-1",
      routerId: "router-a",
      scope: sampleScope,
      ledgerRevision: 1,
      strategy: "absolute",
      amount: "100",
      expectedBoundary: "b-0",
    };

    const writeB: UsageWrite = {
      operationId: "op-wb-2",
      routerId: "router-nonexistent",
      scope: sampleScope,
      ledgerRevision: 1,
      strategy: "delta",
      amount: "10",
      expectedBoundary: "b-0",
    };

    const receipts = await service.writeBack([writeA, writeB]);

    assert.equal(receipts.length, 2);
    assert.equal(receipts[0].operationId, "op-wb-1");
    assert.equal(receipts[0].outcome, "applied");
    assert.equal(adapterWriteCalled, true);

    // Unsupported routerId
    assert.equal(receipts[1].operationId, "op-wb-2");
    assert.equal(receipts[1].outcome, "unsupported");
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createUsageService resolveUnknown queries adapter and records receipt", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-sync-usage-resolve-"));
  const repo = openSyncRepository(path.join(dir, "sync.sqlite3"));

  try {
    const adapterA = createMockAdapter("router-a", {
      async readReceipt(opId) {
        if (opId === "op-pending-1") {
          return {
            operationId: opId,
            outcome: "applied",
            boundary: "checkpoint-res",
            evidence: "recovered",
          };
        }
        return null;
      },
    });

    const service = createUsageService({ repository: repo, adapters: [adapterA] });

    const resolved = await service.resolveUnknown("op-pending-1");
    assert.equal(resolved.outcome, "applied");
    assert.equal(resolved.boundary, "checkpoint-res");

    const unresolved = await service.resolveUnknown("op-nonexistent");
    assert.equal(unresolved.outcome, "unknown");
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
