import test from "node:test";
import assert from "node:assert/strict";
import {
  createInitialBindingState,
  reduceNodeSwitch,
  reduceNodeLoadSuccess,
  reduceNodeLoadError,
  filterConnections,
  filterPools,
  resolveSelectionVisibility,
} from "../src/lib/proxy-binding-state.js";

test("proxy binding state: node switch increments generation and clears stale selections", () => {
  const initial = createInitialBindingState("server-lan");
  initial.connections = [{ id: "acc-1", email: "alice@example.com" }];
  initial.pools = [{ id: "pool-1", name: "Alpha", proxyUrl: "http://1.1.1.1:8080" }];
  initial.selectedConnectionId = "acc-1";
  initial.testResults = { "pool-1": { ok: true, elapsedMs: 50 } };
  initial.testingMap = { "pool-1": false };
  initial.loadState = "ready";

  const next = reduceNodeSwitch(initial, "server-lan-next");

  assert.equal(next.selectedNode, "server-lan-next");
  assert.equal(next.generation, 1);
  assert.equal(next.selectedConnectionId, null, "Selection must be cleared on node switch");
  assert.deepEqual(next.testResults, {}, "Test results must be cleared on node switch");
  assert.deepEqual(next.testingMap, {});
  assert.deepEqual(next.connections, [], "Stale connections must be cleared on node switch");
  assert.deepEqual(next.pools, [], "Stale pools must be cleared on node switch");
  assert.equal(next.loadState, "loading");
  assert.equal(next.loadError, null);
});

test("proxy binding state: out-of-order stale response is discarded", () => {
  const state0 = createInitialBindingState("server-lan");
  const state1 = reduceNodeSwitch(state0, "server-lan-next"); // gen = 1, next node state

  // Stale response from server-lan with gen = 0 arrives late
  const stateAfterStale = reduceNodeLoadSuccess(state1, {
    generation: 0,
    nodeId: "server-lan",
    connections: [{ id: "stale-conn", email: "stale@example.com" }],
    pools: [{ id: "stale-pool", name: "Stale", proxyUrl: "http://0.0.0.0:8080" }],
  });

  assert.equal(
    stateAfterStale.connections.length,
    0,
    "Stale response must NOT overwrite new node state",
  );
  assert.equal(stateAfterStale.selectedNode, "server-lan-next");
  assert.equal(stateAfterStale.loadState, "loading");

  // Valid response from next node with gen = 1 arrives
  const stateAfterValid = reduceNodeLoadSuccess(stateAfterStale, {
    generation: 1,
    nodeId: "server-lan-next",
    connections: [{ id: "next-conn", email: "next@example.com" }],
    pools: [{ id: "next-pool", name: "Next", proxyUrl: "http://2.2.2.2:8080" }],
  });

  assert.equal(stateAfterValid.connections.length, 1);
  assert.equal(stateAfterValid.connections[0].id, "next-conn");
  assert.equal(stateAfterValid.loadState, "ready");
});

test("proxy binding state: load error sets loadState: error without spoofing empty dataset", () => {
  const state = createInitialBindingState("server-lan");
  const failed = reduceNodeLoadError(state, {
    generation: 0,
    nodeId: "server-lan",
    error: "Connection timeout to 9Router daemon",
  });

  assert.equal(failed.loadState, "error");
  assert.equal(failed.loadError, "Connection timeout to 9Router daemon");
  assert.deepEqual(failed.connections, []);
  assert.deepEqual(failed.pools, []);
});

test("proxy binding state: selection visibility detects when active filter conceals selected target", () => {
  const connections = [
    { id: "acc-1", email: "alice@example.com", providerSpecificData: { proxyPoolId: "pool-1" } },
    { id: "acc-2", email: "bob@example.com" },
  ];

  // When query is 'bob', acc-1 is filtered out
  const filtered = filterConnections(connections, { query: "bob", filter: "all" });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, "acc-2");

  const visibility = resolveSelectionVisibility(filtered, "acc-1");
  assert.equal(visibility.hasSelection, true);
  assert.equal(visibility.isVisibleInView, false, "acc-1 is selected but hidden by filter query");
  assert.equal(visibility.selectedId, "acc-1");
});
