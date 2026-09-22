import assert from "node:assert/strict";
import test from "node:test";
import { probeStabilityAndRotation } from "../../src/auditor/probes/stability.js";
import type { ParsedProxyInput } from "../../src/auditor/types.js";

const proxy: ParsedProxyInput = { protocol: "http", host: "127.0.0.1", port: 8080 };

function clock(values: number[]): () => number {
  let index = 0;
  return () => values[index++]!;
}

test("stability reports bounded latency distribution, jitter, and success rate", async () => {
  let calls = 0;
  const timestamps: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    timestamps.push(i * 100);
    timestamps.push(i * 100 + (i + 1));
  }
  const result = await probeStabilityAndRotation(proxy, 100, {
    now: clock(timestamps),
    sample: async () => {
      calls += 1;
      if (calls === 4) throw new Error("temporary failure");
      return { ip: "198.51.100.10" };
    },
  });

  assert.equal(calls, 20);
  assert.equal(result.stability.samplesAttempted, 20);
  assert.equal(result.stability.samplesSucceeded, 19);
  assert.equal(result.stability.successRate, 95);
  assert.equal(result.stability.packetLossPercent, 5);
  assert.equal(result.stability.minLatencyMs, 1);
  assert.equal(result.stability.avgLatencyMs, 10.84);
  assert.equal(result.stability.p50LatencyMs, 11);
  assert.equal(result.stability.p95LatencyMs, 20);
  assert.equal(result.stability.maxLatencyMs, 20);
  assert.equal(result.stability.jitterMs, 1.06);
});

test("rotation counts exit IP transitions separately from distinct IPs", async () => {
  const ips = ["198.51.100.1", "198.51.100.1", "198.51.100.2", "198.51.100.1"];
  const result = await probeStabilityAndRotation(proxy, ips.length, {
    now: clock([0, 10, 10, 20, 20, 30, 30, 40]),
    sample: async () => ({ ip: ips.shift() }),
  });

  assert.deepEqual(result.rotation.distinctIpsObserved, ["198.51.100.1", "198.51.100.2"]);
  assert.equal(result.rotation.supported, true);
  assert.equal(result.rotation.exitIpChanged, true);
  assert.equal(result.rotation.changesObserved, 2);
});

test("rotation preserves all observed IPs across endpoints without single consensus", async () => {
  const result = await probeStabilityAndRotation(proxy, 2, {
    now: clock([0, 10, 10, 20]),
    sample: async () => ({
      observations: [
        { endpoint: "http://ep1.test", ip: "198.51.100.10" },
        { endpoint: "http://ep2.test", ip: "198.51.100.20" },
      ],
    }),
  });

  assert.deepEqual(result.rotation.distinctIpsObserved, ["198.51.100.10", "198.51.100.20"]);
  assert.equal(result.rotation.supported, true);
  assert.equal(result.rotation.exitIpChanged, true);
});

test("stability reports failure when no endpoints are configured", async () => {
  const result = await probeStabilityAndRotation(proxy, 2, { endpoints: [] });
  assert.equal(result.stability.samplesSucceeded, 0);
  assert.equal(result.stability.successRate, 0);
  assert.equal(result.stability.packetLossPercent, 100);
  assert.equal(result.stability.stable, false);
});

test("rotation counts repeated observation transitions before deduplicating distinct IPs", async () => {
  const result = await probeStabilityAndRotation(proxy, 1, {
    now: clock([0, 1]),
    sample: async () => ({
      observations: [
        { ip: "198.51.100.1" },
        { ip: "198.51.100.2" },
        { ip: "198.51.100.1" },
      ],
    }),
  });

  assert.deepEqual(result.rotation.distinctIpsObserved, ["198.51.100.1", "198.51.100.2"]);
  assert.equal(result.rotation.changesObserved, 2);
});

test("stability handles every request failing without invalid numeric metrics", async () => {
  const result = await probeStabilityAndRotation(proxy, 2, {
    now: clock([0, 5, 5, 10]),
    sample: async () => { throw new Error("offline"); },
  });

  assert.equal(result.stability.samplesSucceeded, 0);
  assert.equal(result.stability.successRate, 0);
  assert.equal(result.stability.packetLossPercent, 100);
  assert.equal(result.stability.avgLatencyMs, undefined);
  assert.deepEqual(result.rotation.distinctIpsObserved, []);
  assert.equal(result.rotation.supported, false);
});
