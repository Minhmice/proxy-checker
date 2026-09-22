import type {
  ParsedProxyInput,
  RotationResult,
  StabilityResult,
} from "../types.js";
import { probeExitIp, type ProbeOptions } from "./exit-ip.js";

export interface StabilityProbeOptions extends ProbeOptions {
  now?: () => number;
  sample?: (attemptIndex: number) => Promise<{ ip?: string }>;
}

function roundTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  const clamped = Math.max(0, Math.min(index, sorted.length - 1));
  return sorted[clamped]!;
}

function calculateJitter(latencies: number[]): number {
  if (latencies.length < 2) return 0;
  let sumDiffs = 0;
  for (let i = 1; i < latencies.length; i += 1) {
    sumDiffs += Math.abs(latencies[i]! - latencies[i - 1]!);
  }
  return roundTwo(sumDiffs / (latencies.length - 1));
}

export async function probeStabilityAndRotation(
  proxy: ParsedProxyInput,
  attempts: number,
  options: StabilityProbeOptions = {}
): Promise<{ stability: StabilityResult; rotation: RotationResult }> {
  const boundedAttempts = Math.max(1, Math.min(attempts, 20));
  const now = options.now ?? (() => Date.now());
  const sample =
    options.sample ??
    (async () => {
      const observation = await probeExitIp(proxy, options);
      if (!observation.ip && observation.observations.length > 0) {
        const firstError = observation.observations.find((o) => o.error)?.error;
        if (firstError) throw new Error(firstError);
      }
      return { ip: observation.ip };
    });

  let succeeded = 0;
  const latencies: number[] = [];
  const observedIps: string[] = [];
  let distinctIps: string[] = [];
  let changesObserved = 0;
  let lastIp: string | undefined;
  for (let index = 0; index < boundedAttempts; index += 1) {
    const start = now();
    try {
      const response = await sample(index);
      const elapsed = Math.max(0, now() - start);
      succeeded += 1;
      latencies.push(elapsed);

      if (response?.ip) {
        observedIps.push(response.ip);
        if (!distinctIps.includes(response.ip)) {
          distinctIps.push(response.ip);
        }
        if (lastIp && lastIp !== response.ip) {
          changesObserved += 1;
        }
        lastIp = response.ip;
      }
    } catch {
      now();
    }
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const successRate = roundTwo((succeeded / boundedAttempts) * 100);
  const packetLossPercent = roundTwo(100 - successRate);
  const avgLatencyMs =
    sorted.length > 0
      ? roundTwo(sorted.reduce((acc, v) => acc + v, 0) / sorted.length)
      : undefined;

  const stability: StabilityResult = {
    stable: successRate >= 80 && (sorted.length === 0 || percentile(sorted, 95) <= 3000),
    samplesAttempted: boundedAttempts,
    samplesSucceeded: succeeded,
    successRate,
    packetLossPercent,
    minLatencyMs: sorted[0],
    avgLatencyMs,
    p50LatencyMs: sorted.length > 0 ? percentile(sorted, 50) : undefined,
    p95LatencyMs: sorted.length > 0 ? percentile(sorted, 95) : undefined,
    maxLatencyMs: sorted[sorted.length - 1],
    jitterMs: sorted.length > 0 ? calculateJitter(latencies) : undefined,
  };

  const supported = distinctIps.length > 1;
  const rotation: RotationResult = {
    supported,
    exitIpChanged: changesObserved > 0,
    changesObserved,
    distinctIpsObserved: distinctIps,
  };

  return { stability, rotation };
}
