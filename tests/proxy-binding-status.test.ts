import test from "node:test";
import assert from "node:assert/strict";
import {
  resolvePoolLifecycleBadge,
  resolvePoolLatencyDisplay,
} from "../src/lib/proxy-binding-state.js";

test("status separation: failed manual ping does NOT alter audited pool lifecycle badge", () => {
  const healthyPool = {
    id: "pool-1",
    name: "Primary US",
    proxyUrl: "http://1.1.1.1:8080",
    isActive: true,
  };

  // Even if testResult failed, the lifecycle badge remains Active
  const badge = resolvePoolLifecycleBadge(healthyPool);
  assert.equal(badge.label, "Active");
  assert.equal(badge.tone, "success");

  // Inactive pool
  const inactivePool = {
    id: "pool-2",
    name: "Disabled US",
    proxyUrl: "http://2.2.2.2:8080",
    isActive: false,
  };
  const inactiveBadge = resolvePoolLifecycleBadge(inactivePool);
  assert.equal(inactiveBadge.label, "Inactive");
  assert.equal(inactiveBadge.tone, "muted");

  // Fallback pool
  const fallbackPool = {
    id: "pool-3",
    name: "Fallback Reserve",
    proxyUrl: "http://3.3.3.3:8080",
    type: "fallback",
    isActive: true,
  };
  const fallbackBadge = resolvePoolLifecycleBadge(fallbackPool);
  assert.equal(fallbackBadge.label, "Fallback");
  assert.equal(fallbackBadge.tone, "warning");

  // Dead pool from backend
  const deadPool = {
    id: "pool-4",
    name: "Dead Route",
    proxyUrl: "http://4.4.4.4:8080",
    type: "dead",
    isActive: true,
  };
  const deadBadge = resolvePoolLifecycleBadge(deadPool);
  assert.equal(deadBadge.label, "Dead");
  assert.equal(deadBadge.tone, "error");
});

test("status separation: latency display handles in-flight ping and failed ping accurately", () => {
  const pool = {
    id: "pool-1",
    name: "Primary US",
    proxyUrl: "http://1.1.1.1:8080",
    latencyMs: 120,
    isActive: true,
  };

  // 1. In-flight testing
  const testing = resolvePoolLatencyDisplay(pool, true, undefined);
  assert.equal(testing.state, "testing");
  assert.equal(testing.label, "Pinging...");

  // 2. Successful test
  const okTest = resolvePoolLatencyDisplay(pool, false, { ok: true, elapsedMs: 45 });
  assert.equal(okTest.state, "ok");
  assert.equal(okTest.label, "45ms");

  // 3. Failed test
  const failTest = resolvePoolLatencyDisplay(pool, false, { ok: false, error: "ETIMEDOUT" });
  assert.equal(failTest.state, "failed");
  assert.equal(failTest.label, "Timeout");

  // 4. Untested pool with recorded latency
  const recorded = resolvePoolLatencyDisplay(pool, false, undefined);
  assert.equal(recorded.state, "recorded");
  assert.equal(recorded.label, "120ms");

  // 5. Untested pool without recorded latency
  const freshPool = { ...pool, latencyMs: undefined };
  const untested = resolvePoolLatencyDisplay(freshPool, false, undefined);
  assert.equal(untested.state, "untested");
  assert.equal(untested.label, "—");
});
