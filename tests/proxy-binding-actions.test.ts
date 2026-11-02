import test from "node:test";
import assert from "node:assert/strict";
import { calculateAutoBindPlan } from "../src/lib/proxy-binding-state.js";

test("action safety: calculateAutoBindPlan preserves healthy bindings and avoids modulo reuse", () => {
  const connections = [
    {
      id: "acc-1",
      email: "a1@example.com",
      providerSpecificData: { proxyPoolId: "pool-existing" },
    },
    { id: "acc-2", email: "a2@example.com" },
    { id: "acc-3", email: "a3@example.com" },
    { id: "acc-4", email: "a4@example.com" },
  ];

  const pools = [
    { id: "pool-existing", name: "Existing Pool", proxyUrl: "http://1.1.1.1:8080", isActive: true },
    { id: "pool-free-1", name: "Free Pool 1", proxyUrl: "http://2.2.2.2:8080", isActive: true },
    { id: "pool-free-2", name: "Free Pool 2", proxyUrl: "http://3.3.3.3:8080", isActive: true },
    {
      id: "pool-inactive",
      name: "Inactive Pool",
      proxyUrl: "http://4.4.4.4:8080",
      isActive: false,
    },
  ];

  // With onlyUnassigned = true (default safety rule)
  const plan = calculateAutoBindPlan(connections, pools, { onlyUnassigned: true });

  // acc-1 is skipped because it already has a healthy binding
  assert.equal(plan.skippedCount, 1);

  // acc-2 and acc-3 get pool-free-1 and pool-free-2
  // acc-4 has no available pool (pool-inactive is excluded, and modulo reuse is forbidden)
  assert.equal(plan.assignments.length, 2);
  assert.equal(
    plan.unmetCapacity,
    1,
    "Must report unmet capacity instead of modulo over-subscribing",
  );

  // Verify unique pool assignment (1:1 disjoint invariant)
  const assignedPoolIds = plan.assignments.map((a) => a.poolId);
  const uniquePoolIds = new Set(assignedPoolIds);
  assert.equal(
    uniquePoolIds.size,
    assignedPoolIds.length,
    "Each assigned pool must be strictly unique",
  );
  assert.equal(
    assignedPoolIds.includes("pool-existing"),
    false,
    "Existing in-use pool must not be stolen",
  );
  assert.equal(
    assignedPoolIds.includes("pool-inactive"),
    false,
    "Inactive pool must not be assigned",
  );
});

test("action safety: calculateAutoBindPlan handles zero active pools gracefully", () => {
  const connections = [{ id: "acc-1" }, { id: "acc-2" }];
  const pools = [
    { id: "pool-1", name: "Inactive 1", proxyUrl: "http://0.0.0.0:8080", isActive: false },
  ];

  const plan = calculateAutoBindPlan(connections, pools, { onlyUnassigned: true });
  assert.equal(plan.assignments.length, 0);
  assert.equal(plan.unmetCapacity, 2);
  assert.equal(plan.skippedCount, 0);
});
