import type {
  ParsedProxyInput,
  RotationResult,
  StabilityResult,
} from "../types.js";
import { probeExitIp, type ProbeOptions } from "./exit-ip.js";

export interface StabilityProbeOptions extends ProbeOptions {
  now?: () => number;
  sample?: (attemptIndex: number) => Promise<{ ip?: string; observations?: Array<{ ip?: string }> }>;
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
  const configuredEndpoints =
    options.endpoints !== undefined
      ? options.endpoints
      : options.endpoint
        ? [options.endpoint]
        : undefined;

  const sample =
    options.sample ??
    (async () => {
      if (configuredEndpoints && configuredEndpoints.length === 0) {
        throw new Error("No endpoints configured for stability probe");
      }
      const observation = await probeExitIp(proxy, options);
      if (observation.observations.length === 0) {
        throw new Error("No endpoints configured for exit IP probe");
      }
      const validObservations = observation.observations.filter((o) => Boolean(o.ip));
      if (validObservations.length === 0) {
        const firstError = observation.observations.find((o) => o.error)?.error;
        throw new Error(firstError || "No successful exit IP observations");
      }
      return { ip: observation.ip, observations: observation.observations };
    });

  let succeeded = 0;
  const latencies: number[] = [];
  const observedIps: string[] = [];
  let changesObserved = 0;
  let lastIp: string | undefined;

  for (let index = 0; index < boundedAttempts; index += 1) {
    const start = now();
    try {
      const response = await sample(index);
      const elapsed = Math.max(0, now() - start);
      succeeded += 1;
      latencies.push(elapsed);

      const ipsInSample: string[] = [];
      if (response?.ip) ipsInSample.push(response.ip);
      if (response?.observations) {
        for (const obs of response.observations) {
          if (obs.ip) ipsInSample.push(obs.ip);
        }
      }
      for (const ip of ipsInSample) {
        observedIps.push(ip);
        if (lastIp && lastIp !== ip) changesObserved += 1;
        lastIp = ip;
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

  const distinctIps: string[] = [];
  for (const ip of observedIps) {
    if (!distinctIps.includes(ip)) distinctIps.push(ip);
  }
  const rotation: RotationResult = {
    supported: distinctIps.length > 1,
    exitIpChanged: changesObserved > 0,
    changesObserved,
    distinctIpsObserved: distinctIps,
  };

  return { stability, rotation };
}
