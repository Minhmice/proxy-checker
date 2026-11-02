import test from "node:test";
import assert from "node:assert/strict";
import {
  resolvePoolAssignmentState,
  resolveBindingContext,
} from "../src/lib/proxy-binding-state.js";

test("binding UX: resolvePoolAssignmentState marks current assigned pool as non-duplicable", () => {
  const currentPool = {
    id: "pool-alpha",
    name: "US East 1",
    proxyUrl: "http://1.2.3.4:8080",
    isActive: true,
  };

  const otherPool = {
    id: "pool-beta",
    name: "EU West 1",
    proxyUrl: "http://5.6.7.8:8080",
    isActive: true,
  };

  const inactivePool = {
    id: "pool-gamma",
    name: "AP South 1",
    proxyUrl: "http://9.10.11.12:8080",
    isActive: false,
  };

  // 1. Current pool
  const currentStatus = resolvePoolAssignmentState(currentPool, "pool-alpha");
  assert.equal(currentStatus.isCurrent, true);
  assert.equal(currentStatus.canAssign, false);
  assert.equal(currentStatus.label, "Currently Assigned");

  // 2. Active candidate pool
  const otherStatus = resolvePoolAssignmentState(otherPool, "pool-alpha");
  assert.equal(otherStatus.isCurrent, false);
  assert.equal(otherStatus.canAssign, true);
  assert.equal(otherStatus.label, "Assign");

  // 3. Inactive candidate pool
  const inactiveStatus = resolvePoolAssignmentState(inactivePool, "pool-alpha");
  assert.equal(inactiveStatus.isCurrent, false);
  assert.equal(inactiveStatus.canAssign, true);
  assert.equal(inactiveStatus.isInactive, true);
});

test("binding UX: resolveBindingContext formats account and current pool safely", () => {
  const account = {
    id: "acc-1234567890abcdef",
    email: "operator@enterprise.com",
    name: "Primary Bot",
    providerSpecificData: { proxyPoolId: "pool-alpha" },
  };

  const poolMap = {
    "pool-alpha": { name: "Residential US", url: "http://1.1.1.1:8080", index: 1 },
  };

  const ctx = resolveBindingContext(account, poolMap, "Master Node");
  assert.ok(ctx);
  assert.equal(ctx.accountLabel, "operator@enterprise.com");
  assert.equal(ctx.accountSub, "ID: acc-1234567890...");
  assert.equal(ctx.poolName, "Residential US");
  assert.equal(ctx.isBound, true);
  assert.equal(ctx.nodeName, "Master Node");

  // Test Direct account (no proxy)
  const directAccount = {
    id: "acc-direct-999",
    name: "Fallback Account",
  };
  const directCtx = resolveBindingContext(directAccount, poolMap, "Tailscale Node");
  assert.ok(directCtx);
  assert.equal(directCtx.accountLabel, "Fallback Account");
  assert.equal(directCtx.poolName, "Direct (No Proxy)");
  assert.equal(directCtx.isBound, false);
});
