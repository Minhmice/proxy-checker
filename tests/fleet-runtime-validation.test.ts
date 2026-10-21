import test from "node:test";
import assert from "node:assert/strict";
import { parseFleetCapacity, parseFleetDevice, parseFleetRuntime, type FleetRuntimeSnapshot } from "../src/proxyfleet/runtime.js";

function snapshot(): FleetRuntimeSnapshot {
  return {
    schemaVersion: 1, sessionId: "runtime-session-0001", sequence: 1, sampledAt: 1000,
    uptimeSeconds: 10, cpuPercent: null, loadAverage1m: null,
    memoryAvailableBytes: 512, memoryTotalBytes: 1024,
    activity: { kind: "idle", startedAt: 1000, revision: null, error: null },
    network: { interfaceName: null, scope: "unknown", rxBytes: null, txBytes: null, rxBytesPerSecond: null, txBytesPerSecond: null },
    proxy: { state: "unknown", enabledEndpoints: 1, listeningEndpoints: null, activeConnections: null, checkedAt: null, error: null },
    overlay: { state: "unknown", interfacePresent: null, peerPresent: null, lastHandshakeAt: null, probeOk: null, rxBytes: null, txBytes: null, error: null, lastRecoveryAt: null },
    unavailable: {},
  };
}

test("runtime distinguishes unavailable measurements from valid idle zero", () => {
  const unavailable = parseFleetRuntime(snapshot());
  assert.equal(unavailable.cpuPercent, null);
  const idle = parseFleetRuntime({ ...snapshot(), cpuPercent: 0 });
  assert.equal(idle.cpuPercent, 0);
  assert.equal(idle.network.rxBytesPerSecond, null);
});

test("runtime rejects nonfinite counters, impossible memory and endpoint counts", () => {
  for (const change of [
    { cpuPercent: Number.NaN }, { cpuPercent: 101 }, { sequence: 0 },
    { memoryAvailableBytes: 1025 }, { memoryTotalBytes: -1 },
    { network: { ...snapshot().network, rxBytes: Number.MAX_SAFE_INTEGER + 1 } },
    { proxy: { ...snapshot().proxy, listeningEndpoints: 2 } },
  ]) assert.throws(() => parseFleetRuntime({ ...snapshot(), ...change }));
});

test("runtime rejects unknown schema and oversized untrusted maps", () => {
  assert.throws(() => parseFleetRuntime({ ...snapshot(), schemaVersion: 2 }));
  assert.throws(() => parseFleetRuntime({ ...snapshot(), unavailable: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`metric${i}`, "denied"])) }));
  assert.throws(() => parseFleetRuntime({ ...snapshot(), activity: { ...snapshot().activity, kind: "shell" } }));
});

test("device identity preserves unknown hardware instead of inferring from hostname", () => {
  const device = parseFleetDevice({ schemaVersion: 1, hostname: "pi-arm7", osFamily: "linux", osVersion: null, kernel: null, osArch: null, agentArch: "arm64", model: null, vendor: null, cpuModel: null, logicalCpus: null, memoryTotalBytes: null, virtualization: null, sources: {} });
  assert.equal(device.agentArch, "arm64");
  assert.equal(device.model, null);
  assert.equal(device.osArch, null);
});

test("capacity accepts engine default or positive explicit ceiling only", () => {
  assert.deepEqual(parseFleetCapacity({ maxConnections: null }), { maxConnections: null });
  assert.deepEqual(parseFleetCapacity({ maxConnections: 512 }), { maxConnections: 512 });
  for (const value of [0, -1, 1.5, Number.POSITIVE_INFINITY, 1_000_001, "512", undefined]) {
    assert.throws(() => parseFleetCapacity({ maxConnections: value }));
  }
});

test("runtime rejects non-positive or future sampledAt timestamps", () => {
  assert.throws(() => parseFleetRuntime({ ...snapshot(), sampledAt: 0 }));
  assert.throws(() => parseFleetRuntime({ ...snapshot(), sampledAt: -1000 }));
  assert.throws(() => parseFleetRuntime({ ...snapshot(), sampledAt: Date.now() + 600_000 }));
  assert.doesNotThrow(() => parseFleetRuntime({ ...snapshot(), sampledAt: Date.now() - 1000 }));
});
