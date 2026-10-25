import test from "node:test";
import assert from "node:assert/strict";
import { planMerge, isEqual, categorizeConflictReason } from "../src/server/dual-router/merge.js";
import type {
  Baseline,
  Entity,
  Resource,
  ScopeSnapshot,
  Snapshot,
} from "../src/server/dual-router/types.js";

// Helper creators
function makeScope(
  entities: Entity[] = [],
  complete = true,
  error: string | null = null,
): ScopeSnapshot {
  return {
    complete,
    entities,
    cursor: null,
    observedAt: 1000,
    error,
  };
}

function makeSnapshot(
  routerId: string,
  scopesPartial: Partial<Record<Resource, ScopeSnapshot>> = {},
): Snapshot {
  return {
    routerId,
    scopes: {
      pool: scopesPartial.pool ?? makeScope([], true),
      account: scopesPartial.account ?? makeScope([], true),
      settings: scopesPartial.settings ?? makeScope([], true),
      role: scopesPartial.role ?? makeScope([], true),
      history: scopesPartial.history ?? makeScope([], true),
    },
  };
}
// ---------------------------------------------------------------------------
// 0. Plan contract verbatim assertion
// ---------------------------------------------------------------------------
test("plan contract verbatim specification", () => {
  const scope = (value: string): ScopeSnapshot => ({
    complete: true,
    entities: [
      {
        key: "pool-1",
        resource: "pool",
        localId: "local-1",
        fields: { name: value },
        revision: null,
      },
    ],
    cursor: null,
    observedAt: 1,
    error: null,
  });
  const empty = (): ScopeSnapshot => ({
    complete: true,
    entities: [],
    cursor: null,
    observedAt: 1,
    error: null,
  });
  const snapshot = (id: string, value: string): Snapshot => ({
    routerId: id,
    scopes: {
      pool: scope(value),
      account: empty(),
      settings: empty(),
      role: empty(),
      history: empty(),
    },
  });
  const base: Baseline[] = [
    {
      resource: "pool",
      key: "pool-1",
      field: "name",
      value: "old",
      deleted: false,
      revision: 1,
    },
  ];
  const one = planMerge({ a: snapshot("A", "new"), b: snapshot("B", "old"), baselines: base });
  assert.deepEqual(
    one.operations.map((o) => [o.routerId, o.field, o.desired]),
    [["B", "name", "new"]],
  );
  assert.deepEqual(one.conflicts, []);
  const both = planMerge({ a: snapshot("A", "left"), b: snapshot("B", "right"), baselines: base });
  assert.equal(both.operations.length, 0);
  assert.equal(both.conflicts[0].reason, "divergent");
});

// ---------------------------------------------------------------------------
// 1. One-sided edit
// ---------------------------------------------------------------------------
test("one-sided edit: change on A applies to B when B matches baseline", () => {
  const scopeA = makeScope([
    {
      key: "pool-1",
      resource: "pool",
      localId: "local-1",
      fields: { name: "new-name" },
      revision: "rev-a1",
    },
  ]);
  const scopeB = makeScope([
    {
      key: "pool-1",
      resource: "pool",
      localId: "local-1",
      fields: { name: "old-name" },
      revision: "rev-b1",
    },
  ]);
  const base: Baseline[] = [
    {
      resource: "pool",
      key: "pool-1",
      field: "name",
      value: "old-name",
      deleted: false,
      revision: 1,
    },
  ];

  const plan = planMerge({
    a: makeSnapshot("router-A", { pool: scopeA }),
    b: makeSnapshot("router-B", { pool: scopeB }),
    baselines: base,
  });

  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.operations.length, 1);
  const op = plan.operations[0];
  assert.equal(op.routerId, "router-B");
  assert.equal(op.resource, "pool");
  assert.equal(op.key, "pool-1");
  assert.equal(op.field, "name");
  assert.equal(op.kind, "update");
  assert.equal(op.expected, "old-name");
  assert.equal(op.expectedRevision, "rev-b1");
  assert.equal(op.desired, "new-name");
});

test("one-sided edit: change on B applies to A when A matches baseline", () => {
  const scopeA = makeScope([
    {
      key: "pool-1",
      resource: "pool",
      localId: "local-1",
      fields: { name: "old-name" },
      revision: "rev-a1",
    },
  ]);
  const scopeB = makeScope([
    {
      key: "pool-1",
      resource: "pool",
      localId: "local-1",
      fields: { name: "updated-from-b" },
      revision: "rev-b2",
    },
  ]);
  const base: Baseline[] = [
    {
      resource: "pool",
      key: "pool-1",
      field: "name",
      value: "old-name",
      deleted: false,
      revision: 1,
    },
  ];

  const plan = planMerge({
    a: makeSnapshot("router-A", { pool: scopeA }),
    b: makeSnapshot("router-B", { pool: scopeB }),
    baselines: base,
  });

  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.operations.length, 1);
  const op = plan.operations[0];
  assert.equal(op.routerId, "router-A");
  assert.equal(op.field, "name");
  assert.equal(op.desired, "updated-from-b");
  assert.equal(op.expected, "old-name");
  assert.equal(op.expectedRevision, "rev-a1");
});

// ---------------------------------------------------------------------------
// 2. Different-field merges
// ---------------------------------------------------------------------------
test("different-field merge: concurrent non-overlapping edits merge both ways without conflict", () => {
  const scopeA = makeScope([
    {
      key: "pool-1",
      resource: "pool",
      localId: "local-1",
      fields: { name: "renamed-by-a", rank: 10 },
      revision: "rev-a2",
    },
  ]);
  const scopeB = makeScope([
    {
      key: "pool-1",
      resource: "pool",
      localId: "local-1",
      fields: { name: "original-name", rank: 99 },
      revision: "rev-b2",
    },
  ]);
  const base: Baseline[] = [
    {
      resource: "pool",
      key: "pool-1",
      field: "name",
      value: "original-name",
      deleted: false,
      revision: 1,
    },
    {
      resource: "pool",
      key: "pool-1",
      field: "rank",
      value: 10,
      deleted: false,
      revision: 1,
    },
  ];

  const plan = planMerge({
    a: makeSnapshot("router-A", { pool: scopeA }),
    b: makeSnapshot("router-B", { pool: scopeB }),
    baselines: base,
  });

  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.operations.length, 2);

  // Operation 1: Apply name change to B
  const opToB = plan.operations.find((o) => o.routerId === "router-B");
  assert.ok(opToB);
  assert.equal(opToB.field, "name");
  assert.equal(opToB.desired, "renamed-by-a");

  // Operation 2: Apply rank change to A
  const opToA = plan.operations.find((o) => o.routerId === "router-A");
  assert.ok(opToA);
  assert.equal(opToA.field, "rank");
  assert.equal(opToA.desired, 99);
});

// ---------------------------------------------------------------------------
// 3. Divergent conflicts
// ---------------------------------------------------------------------------
test("divergent conflict: same field edited differently on A and B flags divergent conflict", () => {
  const scopeA = makeScope([
    {
      key: "pool-1",
      resource: "pool",
      localId: "local-1",
      fields: { name: "left-edit" },
      revision: "rev-a1",
    },
  ]);
  const scopeB = makeScope([
    {
      key: "pool-1",
      resource: "pool",
      localId: "local-1",
      fields: { name: "right-edit" },
      revision: "rev-b1",
    },
  ]);
  const base: Baseline[] = [
    {
      resource: "pool",
      key: "pool-1",
      field: "name",
      value: "base-value",
      deleted: false,
      revision: 1,
    },
  ];

  const plan = planMerge({
    a: makeSnapshot("router-A", { pool: scopeA }),
    b: makeSnapshot("router-B", { pool: scopeB }),
    baselines: base,
  });

  assert.equal(plan.operations.length, 0);
  assert.equal(plan.conflicts.length, 1);
  const conflict = plan.conflicts[0];
  assert.equal(conflict.reason, "divergent");
  assert.equal(conflict.resource, "pool");
  assert.equal(conflict.key, "pool-1");
  assert.equal(conflict.field, "name");
  assert.equal(conflict.base, "base-value");
  assert.equal(conflict.a, "left-edit");
  assert.equal(conflict.b, "right-edit");
});

test("divergent conflict: A == B converges without operations or conflicts", () => {
  const scopeA = makeScope([
    {
      key: "pool-1",
      resource: "pool",
      localId: "local-1",
      fields: { name: "identical-value" },
      revision: "rev-a1",
    },
  ]);
  const scopeB = makeScope([
    {
      key: "pool-1",
      resource: "pool",
      localId: "local-1",
      fields: { name: "identical-value" },
      revision: "rev-b1",
    },
  ]);
  const base: Baseline[] = [
    {
      resource: "pool",
      key: "pool-1",
      field: "name",
      value: "base-value",
      deleted: false,
      revision: 1,
    },
  ];

  const plan = planMerge({
    a: makeSnapshot("router-A", { pool: scopeA }),
    b: makeSnapshot("router-B", { pool: scopeB }),
    baselines: base,
  });

  assert.equal(plan.operations.length, 0);
  assert.equal(plan.conflicts.length, 0);
});

// ---------------------------------------------------------------------------
// 4. Incomplete scope safety
// ---------------------------------------------------------------------------
test("incomplete scope safety: complete === false on either router prevents deletion inference", () => {
  // Router A has complete listing without pool-1
  const scopeA = makeScope([], true);
  // Router B has incomplete listing (e.g. pagination or fetch error)
  const scopeB = makeScope([], false, "Fetch timed out");
  const base: Baseline[] = [
    {
      resource: "pool",
      key: "pool-1",
      field: "name",
      value: "persistent-pool",
      deleted: false,
      revision: 1,
    },
  ];

  const plan = planMerge({
    a: makeSnapshot("router-A", { pool: scopeA }),
    b: makeSnapshot("router-B", { pool: scopeB }),
    baselines: base,
  });

  assert.ok(plan.incompleteScopes.includes("pool"));
  // Incomplete scope MUST NOT infer deletion on pool-1
  const deleteOps = plan.operations.filter((o) => o.kind === "delete");
  assert.equal(deleteOps.length, 0);
});

test("incomplete scope safety: entity present on A is NOT deleted on A if B scope is incomplete", () => {
  const scopeA = makeScope(
    [
      {
        key: "pool-1",
        resource: "pool",
        localId: "local-1",
        fields: { name: "pool-name" },
        revision: "rev-1",
      },
    ],
    true,
  );
  // Scope B is incomplete and missing pool-1
  const scopeB = makeScope([], false);
  const base: Baseline[] = [
    {
      resource: "pool",
      key: "pool-1",
      field: "name",
      value: "pool-name",
      deleted: false,
      revision: 1,
    },
  ];

  const plan = planMerge({
    a: makeSnapshot("router-A", { pool: scopeA }),
    b: makeSnapshot("router-B", { pool: scopeB }),
    baselines: base,
  });

  assert.ok(plan.incompleteScopes.includes("pool"));
  assert.equal(plan.operations.length, 0);
  assert.equal(plan.conflicts.length, 0);
});

// ---------------------------------------------------------------------------
// 5. Deletion & tombstones
// ---------------------------------------------------------------------------
test("deletion: clean deletion on B applies delete operation to A when A is unmodified", () => {
  // A has pool-1 exactly as in baseline
  const scopeA = makeScope(
    [
      {
        key: "pool-1",
        resource: "pool",
        localId: "local-1",
        fields: { name: "pool-alpha" },
        revision: "rev-a1",
      },
    ],
    true,
  );
  // B has complete listing and pool-1 is absent (B deleted it)
  const scopeB = makeScope([], true);
  const base: Baseline[] = [
    {
      resource: "pool",
      key: "pool-1",
      field: "name",
      value: "pool-alpha",
      deleted: false,
      revision: 2,
    },
  ];

  const plan = planMerge({
    a: makeSnapshot("router-A", { pool: scopeA }),
    b: makeSnapshot("router-B", { pool: scopeB }),
    baselines: base,
  });

  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.operations.length, 1);
  const op = plan.operations[0];
  assert.equal(op.routerId, "router-A");
  assert.equal(op.kind, "delete");
  assert.equal(op.key, "pool-1");
  assert.equal(op.desired, null);
  assert.deepEqual(op.expected, { name: "pool-alpha" });
});

test("delete-edit conflict: deletion on B + edit on A flags delete-edit conflict", () => {
  // A edited name
  const scopeA = makeScope(
    [
      {
        key: "pool-1",
        resource: "pool",
        localId: "local-1",
        fields: { name: "edited-by-a" },
        revision: "rev-a2",
      },
    ],
    true,
  );
  // B deleted pool-1
  const scopeB = makeScope([], true);
  const base: Baseline[] = [
    {
      resource: "pool",
      key: "pool-1",
      field: "name",
      value: "original",
      deleted: false,
      revision: 1,
    },
  ];

  const plan = planMerge({
    a: makeSnapshot("router-A", { pool: scopeA }),
    b: makeSnapshot("router-B", { pool: scopeB }),
    baselines: base,
  });

  assert.equal(plan.operations.length, 0);
  assert.equal(plan.conflicts.length, 1);
  const conflict = plan.conflicts[0];
  assert.equal(conflict.reason, "delete-edit");
  assert.equal(conflict.resource, "pool");
  assert.equal(conflict.key, "pool-1");
  assert.deepEqual(conflict.base, { name: "original" });
  assert.deepEqual(conflict.a, { name: "edited-by-a" });
  assert.equal(conflict.b, null);
});

test("tombstones: resurrected tombstone with modified fields flags delete-edit conflict", () => {
  // Baseline marked as deleted
  const base: Baseline[] = [
    {
      resource: "pool",
      key: "pool-1",
      field: "name",
      value: "dead-pool",
      deleted: true,
      revision: 3,
    },
  ];
  // A has resurrected pool-1 with new content
  const scopeA = makeScope(
    [
      {
        key: "pool-1",
        resource: "pool",
        localId: "local-1",
        fields: { name: "resurrected" },
        revision: "rev-new",
      },
    ],
    true,
  );
  const scopeB = makeScope([], true);

  const plan = planMerge({
    a: makeSnapshot("router-A", { pool: scopeA }),
    b: makeSnapshot("router-B", { pool: scopeB }),
    baselines: base,
  });

  assert.equal(plan.operations.length, 0);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].reason, "delete-edit");
});

test("tombstones: resurrected tombstone with unmodified fields creates entity on other router", () => {
  const base: Baseline[] = [
    {
      resource: "pool",
      key: "pool-recreated",
      field: "url",
      value: "http://proxy.host:8080",
      deleted: true,
      revision: 1,
    },
  ];
  const scopeA = makeScope([], true);
  const scopeB = makeScope(
    [
      {
        key: "pool-recreated",
        resource: "pool",
        localId: "local-rec-1",
        fields: { url: "http://proxy.host:8080" },
        revision: "rev-1",
      },
    ],
    true,
  );

  const plan = planMerge({
    a: makeSnapshot("router-A", { pool: scopeA }),
    b: makeSnapshot("router-B", { pool: scopeB }),
    baselines: base,
  });

  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].kind, "create");
  assert.equal(plan.operations[0].routerId, "router-A");
  assert.deepEqual(plan.operations[0].desired, { url: "http://proxy.host:8080" });
});

test("tombstones: resurrected tombstone with allowRecreate resolves conflict and creates on other router", () => {
  const base: Baseline[] = [
    {
      resource: "pool",
      key: "pool-recreated",
      field: "url",
      value: "http://proxy.old:8080",
      deleted: true,
      revision: 1,
    },
  ];
  const scopeA = makeScope([], true);
  const scopeB = makeScope(
    [
      {
        key: "pool-recreated",
        resource: "pool",
        localId: "local-rec-1",
        fields: { url: "http://proxy.new:8080" },
        revision: "rev-rec-1",
      },
    ],
    true,
  );

  // Without allowRecreate: flags delete-edit conflict
  const planWithoutFlag = planMerge({
    a: makeSnapshot("router-A", { pool: scopeA }),
    b: makeSnapshot("router-B", { pool: scopeB }),
    baselines: base,
  });
  assert.equal(planWithoutFlag.conflicts.length, 1);
  assert.equal(planWithoutFlag.conflicts[0].reason, "delete-edit");
  assert.equal(planWithoutFlag.operations.length, 0);

  // With allowRecreate: resolves and creates on router A
  const planWithFlag = planMerge({
    a: makeSnapshot("router-A", { pool: scopeA }),
    b: makeSnapshot("router-B", { pool: scopeB }),
    baselines: base,
    allowRecreate: true,
  });
  assert.equal(planWithFlag.conflicts.length, 0);
  assert.equal(planWithFlag.operations.length, 1);
  assert.equal(planWithFlag.operations[0].kind, "create");
  assert.equal(planWithFlag.operations[0].routerId, "router-A");
  assert.deepEqual(planWithFlag.operations[0].desired, { url: "http://proxy.new:8080" });
});

// ---------------------------------------------------------------------------
// 6. Missing baseline (First Enrollment & Additions)
// ---------------------------------------------------------------------------
test("missing baseline: union identifiable additions creates entity on other router", () => {
  const scopeA = makeScope(
    [
      {
        key: "pool-new",
        resource: "pool",
        localId: "local-new",
        fields: { name: "brand-new", rank: 1 },
        revision: "rev-1",
      },
    ],
    true,
  );
  const scopeB = makeScope([], true);

  const plan = planMerge({
    a: makeSnapshot("router-A", { pool: scopeA }),
    b: makeSnapshot("router-B", { pool: scopeB }),
    baselines: [],
  });

  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.operations.length, 1);
  const op = plan.operations[0];
  assert.equal(op.routerId, "router-B");
  assert.equal(op.kind, "create");
  assert.equal(op.key, "pool-new");
  assert.deepEqual(op.desired, { name: "brand-new", rank: 1 });
});

test("missing baseline: disagreeing shared fields conflict without baseline", () => {
  const scopeA = makeScope(
    [
      {
        key: "pool-shared",
        resource: "pool",
        localId: "local-shared",
        fields: { name: "name-a" },
        revision: null,
      },
    ],
    true,
  );
  const scopeB = makeScope(
    [
      {
        key: "pool-shared",
        resource: "pool",
        localId: "local-shared",
        fields: { name: "name-b" },
        revision: null,
      },
    ],
    true,
  );

  const plan = planMerge({
    a: makeSnapshot("router-A", { pool: scopeA }),
    b: makeSnapshot("router-B", { pool: scopeB }),
    baselines: [],
  });

  assert.equal(plan.operations.length, 0);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].reason, "divergent");
  assert.equal(plan.conflicts[0].base, null);
});

// ---------------------------------------------------------------------------
// 7. Account activation & Credential conflict reasons
// ---------------------------------------------------------------------------
test("conflict reason: account activation conflict flags ownership", () => {
  const scopeA = makeScope(
    [
      {
        key: "acc-1",
        resource: "account",
        localId: "loc-acc-1",
        fields: { active: true },
        revision: "1",
      },
    ],
    true,
  );
  const scopeB = makeScope(
    [
      {
        key: "acc-1",
        resource: "account",
        localId: "loc-acc-1",
        fields: { active: false },
        revision: "1",
      },
    ],
    true,
  );
  const base: Baseline[] = [
    {
      resource: "account",
      key: "acc-1",
      field: "active",
      value: null,
      deleted: false,
      revision: 1,
    },
  ];

  const plan = planMerge({
    a: makeSnapshot("router-A", { account: scopeA }),
    b: makeSnapshot("router-B", { account: scopeB }),
    baselines: base,
  });

  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].reason, "ownership");
});

test("conflict reason: account-to-proxy binding conflict flags ownership", () => {
  const scopeA = makeScope(
    [
      {
        key: "acc-1",
        resource: "account",
        localId: "loc-acc-1",
        fields: { proxyId: "proxy-alpha" },
        revision: "1",
      },
    ],
    true,
  );
  const scopeB = makeScope(
    [
      {
        key: "acc-1",
        resource: "account",
        localId: "loc-acc-1",
        fields: { proxyId: "proxy-beta" },
        revision: "1",
      },
    ],
    true,
  );
  const base: Baseline[] = [
    {
      resource: "account",
      key: "acc-1",
      field: "proxyId",
      value: "proxy-old",
      deleted: false,
      revision: 1,
    },
  ];

  const plan = planMerge({
    a: makeSnapshot("router-A", { account: scopeA }),
    b: makeSnapshot("router-B", { account: scopeB }),
    baselines: base,
  });

  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].reason, "ownership");
});

test("conflict reason: credential refreshToken conflict flags credential", () => {
  const scopeA = makeScope(
    [
      {
        key: "acc-1",
        resource: "account",
        localId: "loc-acc-1",
        fields: { refreshToken: "tok-A" },
        revision: "1",
      },
    ],
    true,
  );
  const scopeB = makeScope(
    [
      {
        key: "acc-1",
        resource: "account",
        localId: "loc-acc-1",
        fields: { refreshToken: "tok-B" },
        revision: "1",
      },
    ],
    true,
  );
  const base: Baseline[] = [
    {
      resource: "account",
      key: "acc-1",
      field: "refreshToken",
      value: "tok-old",
      deleted: false,
      revision: 1,
    },
  ];

  const plan = planMerge({
    a: makeSnapshot("router-A", { account: scopeA }),
    b: makeSnapshot("router-B", { account: scopeB }),
    baselines: base,
  });

  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].reason, "credential");
});

// ---------------------------------------------------------------------------
// 8. Coupled activation dependencies
// ---------------------------------------------------------------------------
test("coupled activation: activation operation depends on deactivation operation", () => {
  // Router A has acc-1 inactive, acc-2 active
  // Router B has acc-1 active, acc-2 inactive
  // Baseline has acc-1 active, acc-2 inactive
  // Therefore: A deactivated acc-1 (B needs deactivation), and A activated acc-2 (B needs activation).
  const scopeA = makeScope(
    [
      {
        key: "acc-1",
        resource: "account",
        localId: "loc-1",
        fields: { active: false },
        revision: "1",
      },
      {
        key: "acc-2",
        resource: "account",
        localId: "loc-2",
        fields: { active: true },
        revision: "1",
      },
    ],
    true,
  );
  const scopeB = makeScope(
    [
      {
        key: "acc-1",
        resource: "account",
        localId: "loc-1",
        fields: { active: true },
        revision: "1",
      },
      {
        key: "acc-2",
        resource: "account",
        localId: "loc-2",
        fields: { active: false },
        revision: "1",
      },
    ],
    true,
  );

  const base: Baseline[] = [
    {
      resource: "account",
      key: "acc-1",
      field: "active",
      value: true,
      deleted: false,
      revision: 1,
    },
    {
      resource: "account",
      key: "acc-2",
      field: "active",
      value: false,
      deleted: false,
      revision: 1,
    },
  ];

  const plan = planMerge({
    a: makeSnapshot("router-A", { account: scopeA }),
    b: makeSnapshot("router-B", { account: scopeB }),
    baselines: base,
  });

  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.operations.length, 2);

  const deactOp = plan.operations.find((o) => o.key === "acc-1" && o.desired === false);
  const actOp = plan.operations.find((o) => o.key === "acc-2" && o.desired === true);

  assert.ok(deactOp);
  assert.ok(actOp);
  // Activation MUST depend on deactivation
  assert.ok(actOp.dependsOn.includes(deactOp.id));
});

// ---------------------------------------------------------------------------
// 9. Identity conflict (ambiguous account keys)
// ---------------------------------------------------------------------------
test("identity conflict: distinct keys with identical localId flag identity conflict", () => {
  const scopeA = makeScope(
    [
      {
        key: "acc-key-1",
        resource: "account",
        localId: "same-local-id",
        fields: { email: "user@example.com" },
        revision: "1",
      },
    ],
    true,
  );
  const scopeB = makeScope(
    [
      {
        key: "acc-key-2",
        resource: "account",
        localId: "same-local-id",
        fields: { email: "user@example.com" },
        revision: "1",
      },
    ],
    true,
  );

  const plan = planMerge({
    a: makeSnapshot("router-A", { account: scopeA }),
    b: makeSnapshot("router-B", { account: scopeB }),
    baselines: [],
  });

  const identityConflict = plan.conflicts.find((c) => c.reason === "identity");
  assert.ok(identityConflict);
  assert.equal(identityConflict.resource, "account");
});

// ---------------------------------------------------------------------------
// 10. Conflict isolation (valid conflict not blocking another entity)
// ---------------------------------------------------------------------------
test("conflict isolation: conflict on entity 1 does not block independent entity 2 sync", () => {
  const scopeA = makeScope(
    [
      {
        key: "pool-conflicted",
        resource: "pool",
        localId: "loc-c",
        fields: { name: "val-a" },
        revision: "1",
      },
      {
        key: "pool-clean",
        resource: "pool",
        localId: "loc-ok",
        fields: { name: "clean-new" },
        revision: "1",
      },
    ],
    true,
  );

  const scopeB = makeScope(
    [
      {
        key: "pool-conflicted",
        resource: "pool",
        localId: "loc-c",
        fields: { name: "val-b" },
        revision: "1",
      },
      {
        key: "pool-clean",
        resource: "pool",
        localId: "loc-ok",
        fields: { name: "clean-old" },
        revision: "1",
      },
    ],
    true,
  );

  const base: Baseline[] = [
    {
      resource: "pool",
      key: "pool-conflicted",
      field: "name",
      value: "val-base",
      deleted: false,
      revision: 1,
    },
    {
      resource: "pool",
      key: "pool-clean",
      field: "name",
      value: "clean-old",
      deleted: false,
      revision: 1,
    },
  ];

  const plan = planMerge({
    a: makeSnapshot("router-A", { pool: scopeA }),
    b: makeSnapshot("router-B", { pool: scopeB }),
    baselines: base,
  });

  // pool-conflicted has 1 conflict
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].key, "pool-conflicted");

  // pool-clean has 1 operation applied to B
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].key, "pool-clean");
  assert.equal(plan.operations[0].desired, "clean-new");
});

// ---------------------------------------------------------------------------
// 11. Unchanged rerun is idempotent
// ---------------------------------------------------------------------------
test("idempotence: identical snapshots matching baseline produce no operations or conflicts", () => {
  const scopeA = makeScope(
    [
      {
        key: "pool-1",
        resource: "pool",
        localId: "loc-1",
        fields: { name: "stable" },
        revision: "1",
      },
    ],
    true,
  );
  const scopeB = makeScope(
    [
      {
        key: "pool-1",
        resource: "pool",
        localId: "loc-1",
        fields: { name: "stable" },
        revision: "1",
      },
    ],
    true,
  );
  const base: Baseline[] = [
    {
      resource: "pool",
      key: "pool-1",
      field: "name",
      value: "stable",
      deleted: false,
      revision: 1,
    },
  ];

  const plan = planMerge({
    a: makeSnapshot("router-A", { pool: scopeA }),
    b: makeSnapshot("router-B", { pool: scopeB }),
    baselines: base,
  });

  assert.equal(plan.operations.length, 0);
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.incompleteScopes.length, 0);
});
