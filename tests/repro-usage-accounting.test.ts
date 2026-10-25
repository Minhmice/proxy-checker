import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSyncRepository } from "../src/server/dual-router/repository.js";
import { aggregateUsage, createUsageService } from "../src/server/dual-router/usage.js";
import type { RouterAdapter, UsageEvent, UsageScope } from "../src/server/dual-router/types.js";

const agQuotaScope: UsageScope = {
  accountKey: "ag:account-1",
  provider: "antigravity",
  model: "gemini-session",
  metric: "quota_remaining",
  unit: "percent",
  currency: null,
  periodStart: "2026-10-23T00:00:00Z",
  periodEnd: "2026-10-23T23:59:59Z",
};

test("Ca 1: aggregateUsage khong cong don gauge quota % qua cac vong poll (lay max observedAt: 80%)", () => {
  // 3 vong poll dinh ky deu quan sat thay quota la 80%
  const poll1: UsageEvent = {
    id: "poll-1",
    namespace: "antigravity-quota",
    sourceRouterId: "router-a",
    scope: agQuotaScope,
    amount: "80",
    accuracy: "exact",
    provenance: "native",
    generation: "1",
    cursor: "cursor-1",
    observedAt: 1000,
  };

  const poll2: UsageEvent = {
    id: "poll-2",
    namespace: "antigravity-quota",
    sourceRouterId: "router-a",
    scope: agQuotaScope,
    amount: "80",
    accuracy: "exact",
    provenance: "native",
    generation: "2",
    cursor: "cursor-2",
    observedAt: 2000,
  };

  const poll3: UsageEvent = {
    id: "poll-3",
    namespace: "antigravity-quota",
    sourceRouterId: "router-a",
    scope: agQuotaScope,
    amount: "80",
    accuracy: "exact",
    provenance: "native",
    generation: "3",
    cursor: "cursor-3",
    observedAt: 3000,
  };

  const aggregated = aggregateUsage([poll1, poll2, poll3]);
  console.log(`[Ca 1] aggregateUsage amount: ${aggregated.amount}% (expected gauge: 80%)`);
  assert.equal(aggregated.amount, "80");
});

test("Ca 2: Polling dinh ky cap nhat amount moi cung event id refresh thanh cong va khong block scope", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-sync-repro-ca2-"));
  const dbFile = path.join(dir, "sync.sqlite3");

  try {
    const repo = openSyncRepository(dbFile);

    const eventT1: UsageEvent = {
      id: "quota-ag-1",
      namespace: "antigravity-quota",
      sourceRouterId: "router-a",
      scope: agQuotaScope,
      amount: "80",
      accuracy: "exact",
      provenance: "native",
      generation: "1",
      cursor: "cursor-1",
      observedAt: 1000,
    };

    const insertedT1 = repo.appendUsage(eventT1);
    assert.equal(insertedT1, true);

    // Vong poll 2: cung namespace + id, nhung quota giam xuong 70, observedAt: 2000 (moi hon)
    const eventT2: UsageEvent = {
      id: "quota-ag-1",
      namespace: "antigravity-quota",
      sourceRouterId: "router-a",
      scope: agQuotaScope,
      amount: "70",
      accuracy: "exact",
      provenance: "native",
      generation: "2",
      cursor: "cursor-2",
      observedAt: 2000,
    };

    // 1. Kiem tra repo.appendUsage() refresh thanh cong, khong nem Integrity conflict
    const updatedT2 = repo.appendUsage(eventT2);
    assert.equal(updatedT2, true);

    const listAfterUpdate = repo.listUsage(agQuotaScope);
    assert.equal(listAfterUpdate.length, 1);
    assert.equal(listAfterUpdate[0].amount, "70");
    assert.equal(listAfterUpdate[0].observedAt, 2000);

    // 2. Kiem tra ingest() trong UsageService khong bi blockedScopes
    const mockAdapter = {
      routerId: "router-a",
      async readUsage() {
        return [eventT2];
      },
      async writeUsage() {
        throw new Error("not implemented");
      },
      async readReceipt() {
        return null;
      },
    } as unknown as RouterAdapter;

    const usageService = createUsageService({
      repository: repo,
      adapters: [mockAdapter],
    });

    const ingestResult = await usageService.ingest();
    console.log(
      `[Ca 2] ingest result: inserted=${ingestResult.inserted}, blockedScopes=${JSON.stringify(ingestResult.blockedScopes)}`,
    );
    // Do eventT2 da o trong DB voi payload y het, ingest coi la duplicate (added = false) -> inserted = 0, nhung blockedScopes = 0
    assert.equal(ingestResult.blockedScopes.length, 0);

    repo.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Ca 3: Router A va Router B cung sinh event co id cuc bo giong nhau (id: 101) khong bi conflict nho sourceRouterId", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-sync-repro-ca3-"));
  const dbFile = path.join(dir, "sync.sqlite3");

  try {
    const repo = openSyncRepository(dbFile);

    const eventRouterA: UsageEvent = {
      id: "101",
      namespace: "requests",
      sourceRouterId: "router-a",
      scope: {
        accountKey: "acc-1",
        provider: "openai",
        model: "gpt-4o",
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
      cursor: "req-101",
      observedAt: 1000,
    };

    const eventRouterB: UsageEvent = {
      id: "101", // Cung ID cuc bo 101 sinh ra tren Router B
      namespace: "requests",
      sourceRouterId: "router-b",
      scope: {
        accountKey: "acc-1",
        provider: "openai",
        model: "gpt-4o",
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
      cursor: "req-101",
      observedAt: 1000,
    };

    // Router A luu truoc -> thanh cong
    const insertedA = repo.appendUsage(eventRouterA);
    assert.equal(insertedA, true);

    // Router B luu cung id 101 nhung sourceRouterId khac -> thanh cong, khong bi conflict
    const insertedB = repo.appendUsage(eventRouterB);
    assert.equal(insertedB, true);

    // Cung sourceRouterId va event giong het thi bi coi la duplicate va tra ve false
    const duplicateA = repo.appendUsage(eventRouterA);
    assert.equal(duplicateA, false);

    // Ca 2 event deu ton tai trong database
    const events = repo.listUsage(eventRouterA.scope);
    assert.equal(events.length, 2);

    repo.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
