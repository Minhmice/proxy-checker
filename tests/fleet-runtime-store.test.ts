import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createFleetRuntimeStore } from "../src/proxyfleet/runtime-store.js";
import type { FleetRuntimeSnapshot } from "../src/proxyfleet/runtime.js";

function runtime(sequence: number, sessionId = "runtime-session-alpha"): FleetRuntimeSnapshot {
  return {
    schemaVersion: 1,
    sessionId,
    sequence,
    sampledAt: sequence * 1000,
    uptimeSeconds: 10,
    activity: { kind: "idle", startedAt: 1000, revision: null, error: null },
    cpuPercent: null,
    loadAverage1m: null,
    memoryAvailableBytes: 900,
    memoryTotalBytes: 1000,
    network: {
      interfaceName: null,
      scope: "unknown",
      rxBytes: null,
      txBytes: null,
      rxBytesPerSecond: null,
      txBytesPerSecond: null,
    },
    proxy: {
      state: "unknown",
      enabledEndpoints: 0,
      listeningEndpoints: null,
      activeConnections: null,
      checkedAt: null,
      error: null,
    },
    overlay: {
      state: "unknown",
      interfacePresent: null,
      peerPresent: null,
      lastHandshakeAt: null,
      probeOk: null,
      rxBytes: null,
      txBytes: null,
      error: null,
      lastRecoveryAt: null,
    },
    unavailable: {},
  };
}
function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE fleet_nodes (id TEXT PRIMARY KEY, os TEXT, arch TEXT, updated_at INTEGER, desired_revision INTEGER DEFAULT 1, deployment_status TEXT, deployment_error TEXT); CREATE TABLE fleet_node_removals (node_id TEXT,status TEXT); CREATE TABLE fleet_events(id TEXT PRIMARY KEY,node_id TEXT,endpoint_id TEXT,event_type TEXT,level TEXT,payload_json TEXT,created_at INTEGER); INSERT INTO fleet_nodes(id) VALUES ('worker');",
  );
  return db;
}

test("newer runtime snapshots cannot be overwritten by delayed sequence or prior session", () => {
  const db = database();
  try {
    const store = createFleetRuntimeStore(db);
    store.startSession("worker", "runtime-session-alpha");
    assert.equal(store.recordRuntime("worker", runtime(2)).accepted, true);
    assert.equal(store.recordRuntime("worker", runtime(1)).accepted, false);
    store.startSession("worker", "runtime-session-alpha");
    assert.equal(store.recordRuntime("worker", runtime(1)).accepted, false);
    store.startSession("worker", "runtime-session-bravo");
    assert.equal(store.recordRuntime("worker", runtime(3)).accepted, false);
    assert.throws(() => store.startSession("worker", "runtime-session-alpha"), /retired/);
    assert.equal(store.recordRuntime("worker", runtime(1, "runtime-session-bravo")).accepted, true);
    const current = db
      .prepare("SELECT runtime_session_id,runtime_sequence FROM fleet_nodes WHERE id='worker'")
      .get();
    assert.equal(current?.runtime_session_id, "runtime-session-bravo");
    assert.equal(current?.runtime_sequence, 1);
  } finally {
    db.close();
  }
});

test("removing worker cannot publish telemetry or change capacity", () => {
  const db = database();
  try {
    const store = createFleetRuntimeStore(db);
    store.startSession("worker", "runtime-session-alpha");
    db.prepare("INSERT INTO fleet_node_removals(node_id,status) VALUES ('worker','pending')").run();
    assert.throws(() => store.recordRuntime("worker", runtime(1)), /Node not found/);
    assert.throws(() => store.startSession("worker", "runtime-session-bravo"), /Node not found/);
    assert.throws(() => store.updateCapacity("worker", { maxConnections: 100 }), /Node not found/);
  } finally {
    db.close();
  }
});

test("capacity increase needs fresh memory evidence and only actual setting changes advance revision", () => {
  const db = database();
  try {
    const store = createFleetRuntimeStore(db);
    assert.throws(
      () => store.updateCapacity("worker", { maxConnections: 100 }),
      /Fresh node measurements/,
    );
    store.startSession("worker", "runtime-session-alpha");
    store.recordRuntime("worker", runtime(1));
    store.updateCapacity("worker", { maxConnections: 100 });
    store.updateCapacity("worker", { maxConnections: 100 });
    assert.equal(
      db.prepare("SELECT desired_revision FROM fleet_nodes WHERE id='worker'").get()
        ?.desired_revision,
      2,
    );
    db.prepare("UPDATE fleet_nodes SET runtime_received_at = ? WHERE id='worker'").run(
      Date.now() - 61_000,
    );
    assert.throws(
      () => store.updateCapacity("worker", { maxConnections: 200 }),
      /Fresh node measurements/,
    );
    store.updateCapacity("worker", { maxConnections: null });
    assert.equal(
      db.prepare("SELECT desired_revision FROM fleet_nodes WHERE id='worker'").get()
        ?.desired_revision,
      3,
    );
  } finally {
    db.close();
  }
});

test("failed activity persistence rolls back accepted snapshot watermark", () => {
  const db = database();
  try {
    const store = createFleetRuntimeStore(db);
    store.startSession("worker", "runtime-session-alpha");
    db.exec(
      "CREATE TRIGGER reject_activity BEFORE INSERT ON fleet_events BEGIN SELECT RAISE(ABORT,'audit write failed'); END;",
    );
    assert.throws(() => store.recordRuntime("worker", runtime(1)), /audit write failed/);
    assert.equal(
      db.prepare("SELECT runtime_sequence,runtime_json FROM fleet_nodes WHERE id='worker'").get()
        ?.runtime_sequence,
      0,
    );
    assert.equal(
      db.prepare("SELECT runtime_json FROM fleet_nodes WHERE id='worker'").get()?.runtime_json,
      null,
    );
  } finally {
    db.close();
  }
});

test("overlay approval persists per node and ignores pending removals", () => {
  const db = database();
  try {
    const store = createFleetRuntimeStore(db);
    assert.equal(store.isOverlayApproved("worker"), false);
    assert.deepEqual(store.getApprovedNodeIds(), []);
    store.setOverlayApproved("worker", true);
    assert.equal(store.isOverlayApproved("worker"), true);
    assert.deepEqual(store.getApprovedNodeIds(), ["worker"]);
    db.prepare("INSERT INTO fleet_node_removals(node_id,status) VALUES ('worker','pending')").run();
    assert.deepEqual(store.getApprovedNodeIds(), []);
    assert.throws(() => store.setOverlayApproved("worker", false), /Node not found/);
  } finally {
    db.close();
  }
});
