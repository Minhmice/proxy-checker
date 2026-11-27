import test from "node:test";
import assert from "node:assert/strict";
import {
  computeRotationPlan,
  type AntigravityAccountInput,
} from "../src/server/antigravity-rotator.js";

const account = (id: string, patch: Partial<AntigravityAccountInput> = {}) => ({
  id,
  isActive: false,
  sessionPercentage: 100,
  weeklyPercentage: 80,
  resetAt: null,
  quotaAvailable: true,
  thresholdPercentage: 15,
  ...patch,
});

test("keeps healthy incumbent above its persisted threshold", () => {
  const plan = computeRotationPlan(
    [
      account("old", { isActive: true, sessionPercentage: 16, thresholdPercentage: 15 }),
      account("new"),
    ],
    { allEndpointsReadable: true },
  );
  assert.deepEqual(plan.activeIds, ["old", "new"]);
  assert.deepEqual(plan.activations, ["new"]);
  assert.deepEqual(plan.deactivations, []);
});

test("replaces incumbent and fills second slot using eligible reserves", () => {
  const plan = computeRotationPlan(
    [
      account("old", { isActive: true, sessionPercentage: 15, thresholdPercentage: 15 }),
      account("later", { resetAt: "2099-01-02T00:00:00Z" }),
      account("first", { resetAt: "2099-01-01T00:00:00Z" }),
    ],
    { allEndpointsReadable: true },
  );
  assert.deepEqual(plan.activations, ["first", "later"]);
  assert.deepEqual(plan.deactivations, ["old"]);
  assert.deepEqual(plan.activeIds, ["first", "later"]);
});

test("keeps exhausted incumbent when no successor qualifies", () => {
  const plan = computeRotationPlan(
    [
      {
        id: "https://router.example:::old",
        isActive: true,
        sessionPercentage: 10,
        weeklyPercentage: 0,
        resetAt: null,
        quotaAvailable: true,
        thresholdPercentage: 15,
      },
    ],
    { allEndpointsReadable: true },
  );
  assert.deepEqual(plan.activeIds, ["https://router.example:::old"]);
  assert.deepEqual(plan.activations, []);
  assert.deepEqual(plan.deactivations, []);
});

test("does not activate while an endpoint is unreadable", () => {
  const plan = computeRotationPlan([account("reserve")], { allEndpointsReadable: false });
  assert.deepEqual(plan.activeIds, []);
  assert.deepEqual(plan.activations, []);
  assert.equal(plan.degraded, true);
});

test("retains all observed actives without changes while an endpoint is unreadable", () => {
  const plan = computeRotationPlan(
    [
      account("first", { isActive: true }),
      account("second", { isActive: true, sessionPercentage: 5 }),
      account("third", { isActive: true }),
      account("reserve"),
    ],
    { allEndpointsReadable: false },
  );
  assert.deepEqual(plan.activeIds, ["first", "second", "third"]);
  assert.deepEqual(plan.activations, []);
  assert.deepEqual(plan.deactivations, []);
  assert.equal(plan.degraded, true);
});

test("converges multiple active accounts deterministically", () => {
  const plan = computeRotationPlan(
    [
      account("z", { isActive: true, sessionPercentage: 90, resetAt: "2099-01-02T00:00:00Z" }),
      account("a", { isActive: true, sessionPercentage: 90, resetAt: "2099-01-01T00:00:00Z" }),
    ],
    { allEndpointsReadable: true },
  );
  assert.deepEqual(plan.activeIds, ["a", "z"]);
  assert.deepEqual(plan.deactivations, []);
});

test("candidate quota requires more than twenty, no error and available telemetry", () => {
  const plan = computeRotationPlan(
    [
      account("twenty", { sessionPercentage: 20, resetAt: "2099-01-01T00:00:00Z" }),
      account("error", { lastError: "disabled", resetAt: "2099-01-01T00:00:00Z" }),
      account("unknown", { quotaAvailable: false, resetAt: "2099-01-01T00:00:00Z" }),
      account("valid", { sessionPercentage: 20.01 }),
    ],
    { allEndpointsReadable: true },
  );
  assert.deepEqual(plan.activations, ["valid"]);
});

test("equal or invalid resets use qualified ID tie-breaker", () => {
  const plan = computeRotationPlan(
    [
      account("https://b:::same", { resetAt: "invalid" }),
      account("https://a:::same", { resetAt: null }),
    ],
    { allEndpointsReadable: true },
  );
  assert.deepEqual(plan.activeIds, ["https://a:::same", "https://b:::same"]);
});

test("unhealthy startup retains qualified ID order when no successor exists", () => {
  const plan = computeRotationPlan(
    [
      account("https://b:::same", { isActive: true, sessionPercentage: 1 }),
      account("https://a:::same", { isActive: true, sessionPercentage: 1 }),
    ],
    { allEndpointsReadable: true },
  );
  assert.deepEqual(plan.activeIds, ["https://a:::same", "https://b:::same"]);
  assert.deepEqual(plan.deactivations, []);
});

test("selects empty-state successor only with fresh finite quota", () => {
  const plan = computeRotationPlan(
    [
      account("bad", { sessionPercentage: Number.NaN }),
      account("good", { resetAt: "2099-01-01T00:00:00Z" }),
    ],
    { allEndpointsReadable: true },
  );
  assert.deepEqual(plan.activations, ["good"]);
  assert.deepEqual(plan.activeIds, ["good"]);
});

test("keeps healthy peer and replaces exhausted slot with highest quota", () => {
  const plan = computeRotationPlan(
    [
      account("low", { isActive: true, sessionPercentage: 10 }),
      account("peer", { isActive: true, sessionPercentage: 70 }),
      account("early", { sessionPercentage: 50, resetAt: "2099-01-01T00:00:00Z" }),
      account("rich", { sessionPercentage: 95, resetAt: "2099-01-02T00:00:00Z" }),
    ],
    { allEndpointsReadable: true },
  );
  assert.deepEqual(plan.activations, ["rich"]);
  assert.deepEqual(plan.deactivations, ["low"]);
  assert.deepEqual(plan.activeIds, ["peer", "rich"]);
});
