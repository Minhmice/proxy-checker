import fs from "node:fs";
import path from "node:path";
import type { MetricsHistory, MetricsSnapshot, PoolRecord } from "../lib/types.js";

const MAX_SNAPSHOTS = 500;

export function createMetricsHistory({ dataDir }: { dataDir: string }) {
  const historyFile = path.join(dataDir, "metrics-history.json");

  function read(): MetricsHistory {
    try {
      const data = JSON.parse(fs.readFileSync(historyFile, "utf8")) as MetricsHistory;
      return { snapshots: data.snapshots ?? [] };
    } catch {
      return { snapshots: [] };
    }
  }

  function write(history: MetricsHistory) {
    fs.mkdirSync(dataDir, { recursive: true });
    const temp = `${historyFile}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(history, null, 2));
    fs.renameSync(temp, historyFile);
  }

  function recordFromPools(pools: PoolRecord[], stats: { active: number; reserve: number; dead: number }) {
    const usable = pools.filter((p) => p.status === "usable" && p.latency_ms !== null);
    const avgLatencyMs =
      usable.length > 0
        ? Math.round(usable.reduce((sum, p) => sum + (p.latency_ms ?? 0), 0) / usable.length)
        : null;

    const snapshot: MetricsSnapshot = {
      timestamp: Date.now(),
      active: stats.active,
      reserve: stats.reserve,
      dead: stats.dead,
      avgLatencyMs,
    };

    const history = read();
    history.snapshots.push(snapshot);
    if (history.snapshots.length > MAX_SNAPSHOTS) {
      history.snapshots = history.snapshots.slice(-MAX_SNAPSHOTS);
    }
    write(history);
    return snapshot;
  }

  function list(sinceMs?: number): MetricsSnapshot[] {
    const snapshots = read().snapshots;
    if (!sinceMs) return snapshots;
    return snapshots.filter((s) => s.timestamp >= sinceMs);
  }

  return { recordFromPools, list, read };
}
