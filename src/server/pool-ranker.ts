import fs from "node:fs";
import path from "node:path";
import type { PoolRecord, PoolStats } from "../lib/types.js";
import { getSettingsSecrets } from "./app-config.js";
import { getActivitySnapshot, logActivity, resetSyncProgress, setSyncProgress } from "./activity-log.js";
import { checkMany } from "./checker.js";
import { createMetricsHistory } from "./metrics-history.js";
import { bulkSetActive, listPools, nineRouterAuthMode, nineRouterConfigured, setPoolActive } from "./nine-router-client.js";
import { parseProxy } from "./proxy-core.js";

interface PoolState {
  pools: Record<string, PoolRecord>;
  lastSyncAt: number | null;
  stats: PoolStats;
  lastError: string;
}

export function createPoolRanker({ dataDir }: { dataDir: string }) {
  const stateFile = path.join(dataDir, "pool-state.json");
  const metrics = createMetricsHistory({ dataDir });
  let syncing = false;
  let lastError = "";

  function emptyState(): PoolState {
    return { pools: {}, lastSyncAt: null, stats: { total: 0, active: 0, reserve: 0, dead: 0 }, lastError: "" };
  }

  function readState(): PoolState {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as PoolState;
      return { ...emptyState(), ...state, pools: state.pools ?? {} };
    } catch {
      return emptyState();
    }
  }

  function writeState(state: PoolState) {
    fs.mkdirSync(dataDir, { recursive: true });
    const temp = `${stateFile}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2));
    fs.renameSync(temp, stateFile);
  }

  function rankUsable(entries: PoolRecord[]) {
    return [...entries].sort(
      (a, b) =>
        (a.latency_ms ?? Number.MAX_SAFE_INTEGER) - (b.latency_ms ?? Number.MAX_SAFE_INTEGER) ||
        (b.successes ?? 0) - (a.successes ?? 0) ||
        String(a.id).localeCompare(String(b.id))
    );
  }

  function computeStats(pools: PoolRecord[], skipped: string[] = []): PoolStats {
    const pending = pools.filter((pool) => pool.healthStatus === "pending").length;
    const checking = pools.filter((pool) => pool.healthStatus === "checking").length;
    return {
      total: pools.length,
      active: pools.filter((pool) => pool.tier === "active").length,
      reserve: pools.filter((pool) => pool.tier === "reserve").length,
      dead: pools.filter((pool) => pool.tier === "dead").length,
      pending,
      checking,
      skipped,
    };
  }

  function publishPools(poolMap: Record<string, PoolRecord>, skipped: string[], lastSyncAt: number | null, lastError = "") {
    writeState({
      pools: poolMap,
      lastSyncAt,
      stats: computeStats(Object.values(poolMap), skipped),
      lastError,
    });
  }

  function assignTiers(checkedPools: PoolRecord[]) {
    const activeLimit = getSettingsSecrets().activePoolLimit;
    const usable = rankUsable(checkedPools.filter((pool) => pool.status === "usable"));
    const usableIds = new Set(usable.map((pool) => pool.id));
    for (const pool of checkedPools) {
      if (!usableIds.has(pool.id)) {
        pool.tier = "dead";
        pool.isActiveOnRouter = false;
        continue;
      }
      const rank = usable.findIndex((item) => item.id === pool.id);
      if (rank < activeLimit) {
        pool.tier = "active";
        pool.isActiveOnRouter = true;
      } else {
        pool.tier = "reserve";
        pool.isActiveOnRouter = false;
      }
    }
    return checkedPools;
  }

  async function syncPools() {
    if (syncing) {
      logActivity("warn", "Sync already running — skipped duplicate request");
      return { started: false, running: true };
    }
    if (!nineRouterConfigured()) throw new Error("9Router password is not configured in Settings");
    syncing = true;
    lastError = "";
    resetSyncProgress();
    const { activePoolLimit, checkConcurrency } = getSettingsSecrets();
    logActivity("info", "Sync started");
    const startedAt = Date.now();
    try {
      const previous = readState();
      setSyncProgress({ phase: "login" });
      logActivity("info", "Logging into 9Router…");
      const remotePools = await listPools();
      logActivity("info", `9Router login OK — connected to ${getSettingsSecrets().nineRouterUrl}`);
      const httpPools = remotePools.filter((pool) => pool.type === "http" || !pool.type);
      const skipped: string[] = [];
      const poolMap: Record<string, PoolRecord> = {};

      for (const pool of remotePools) {
        if (pool.type && pool.type !== "http") skipped.push(pool.id);
      }

      setSyncProgress({ phase: "fetch", remoteTotal: remotePools.length });
      logActivity(
        "info",
        `Fetched ${remotePools.length} pool(s) from 9Router (${httpPools.length} HTTP/SOCKS, ${skipped.length} relay skipped)`
      );

      if (remotePools.length === 0) {
        logActivity("warn", "9Router returned 0 proxy pools — add proxies in 9Router → Proxy Pools first");
      }

      const checkTargets: Array<{ pool: (typeof remotePools)[0]; proxy: NonNullable<ReturnType<typeof parseProxy>> }> =
        [];

      for (const pool of httpPools) {
        const prev = previous.pools[pool.id];
        const proxy = parseProxy(pool.proxyUrl);
        if (!proxy) {
          poolMap[pool.id] = {
            id: pool.id,
            name: pool.name,
            proxyUrl: pool.proxyUrl,
            type: pool.type ?? "http",
            status: "dead",
            tier: "dead",
            healthStatus: "done",
            latency_ms: null,
            exit_ip: null,
            checked_at: Date.now(),
            isActiveOnRouter: false,
            successes: prev?.successes ?? 0,
            failures: (prev?.failures ?? 0) + 1,
            last_error: "Invalid proxy URL",
          };
          continue;
        }
        checkTargets.push({ pool, proxy });
        poolMap[pool.id] = {
          id: pool.id,
          name: pool.name,
          proxyUrl: pool.proxyUrl,
          type: pool.type ?? "http",
          status: prev?.status ?? "dead",
          tier: prev?.tier ?? "reserve",
          healthStatus: "pending",
          latency_ms: prev?.latency_ms ?? null,
          exit_ip: prev?.exit_ip ?? null,
          checked_at: prev?.checked_at ?? 0,
          isActiveOnRouter: prev?.isActiveOnRouter ?? false,
          successes: prev?.successes ?? 0,
          failures: prev?.failures ?? 0,
          last_error: prev?.last_error,
        };
      }

      publishPools(poolMap, skipped, previous.lastSyncAt);
      if (checkTargets.length > 0) {
        logActivity("info", `Listed ${checkTargets.length} proxies — starting health checks…`);
      }

      if (checkTargets.length === 0) {
        logActivity("warn", "Nothing to health-check — no valid HTTP/SOCKS proxy URLs");
      } else {
        setSyncProgress({ phase: "check", total: checkTargets.length, checked: 0 });
        logActivity("info", `Health-checking ${checkTargets.length} proxies (concurrency ${checkConcurrency})…`);
      }

      let lastLoggedAt = 0;
      let lastPublishedAt = Date.now();
      await checkMany(checkTargets.map((item) => item.proxy), checkConcurrency, {
        onStart: (index) => {
          const id = checkTargets[index].pool.id;
          if (poolMap[id]) poolMap[id] = { ...poolMap[id], healthStatus: "checking" };
          const now = Date.now();
          if (now - lastPublishedAt >= 150) {
            publishPools(poolMap, skipped, previous.lastSyncAt);
            lastPublishedAt = now;
          }
        },
        onResult: (index, result) => {
          const { pool } = checkTargets[index];
          const prev = previous.pools[pool.id] ?? { successes: 0, failures: 0 };
          if (result.latency_ms >= 5000) {
            logActivity(
              "warn",
              `Slow check ${result.latency_ms}ms: ${pool.name} (${result.last_error || result.status})`
            );
          }
          poolMap[pool.id] = {
            ...poolMap[pool.id],
            healthStatus: "done",
            status: result.status,
            latency_ms: result.latency_ms,
            exit_ip: result.exit_ip,
            checked_at: result.checked_at,
            successes: (prev.successes ?? 0) + result.successes,
            failures: (prev.failures ?? 0) + result.failures,
            last_error: result.last_error,
          };
          const now = Date.now();
          if (now - lastPublishedAt >= 250 || index === checkTargets.length - 1) {
            publishPools(poolMap, skipped, previous.lastSyncAt);
            lastPublishedAt = now;
          }
        },
        onProgress: (checked, total) => {
          setSyncProgress({ phase: "check", checked, total });
          const now = Date.now();
          if (checked === total || checked === 1 || now - lastLoggedAt > 5000) {
            lastLoggedAt = now;
            logActivity("info", `Checked ${checked}/${total} proxies…`);
          }
        },
      });

      const checkedPools = Object.values(poolMap);
      assignTiers(checkedPools);
      for (const pool of checkedPools) pool.healthStatus = "done";
      const usable = checkedPools.filter((pool) => pool.status === "usable").length;
      setSyncProgress({ phase: "rank" });
      logActivity(
        "info",
        `Ranking complete: ${usable} usable, ${checkedPools.length - usable} dead → top ${activePoolLimit} active`
      );

      setSyncProgress({ phase: "activate" });
      logActivity("info", `Updating ${checkedPools.length} pool toggle(s) on 9Router…`);
      const updates = checkedPools.map((pool) => ({ id: pool.id, isActive: pool.isActiveOnRouter }));
      const activationResults = await bulkSetActive(updates);
      const failed = activationResults.filter((item) => !item.ok);

      const pools: Record<string, PoolRecord> = {};
      for (const pool of checkedPools) pools[pool.id] = pool;

      const stats = computeStats(checkedPools, skipped);
      const state: PoolState = {
        pools,
        lastSyncAt: Date.now(),
        stats,
        lastError: failed.length ? `${failed.length} activation update(s) failed` : "",
      };
      writeState(state);
      metrics.recordFromPools(checkedPools, stats);
      lastError = state.lastError;

      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      setSyncProgress({ phase: "done", checked: checkTargets.length, total: checkTargets.length });
      if (stats.active === 0 && stats.total > 0) {
        logActivity("warn", `Sync finished in ${elapsed}s — 0 active proxies (all failed or too slow)`);
      } else if (stats.total === 0) {
        logActivity("warn", `Sync finished in ${elapsed}s — no proxies to manage`);
      } else {
        logActivity(
          "success",
          `Sync finished in ${elapsed}s — ${stats.active} active, ${stats.reserve} reserve, ${stats.dead} dead`
        );
      }
      if (failed.length) logActivity("warn", `${failed.length} activation update(s) failed on 9Router`);

      return {
        started: true,
        running: false,
        activated: stats.active,
        reserve: stats.reserve,
        dead: stats.dead,
        skipped: skipped.length,
        errors: failed,
      };
    } catch (error) {
      lastError = (error as Error).message;
      logActivity("error", `Sync failed: ${lastError}`);
      setSyncProgress({ phase: "idle" });
      const state = readState();
      state.lastError = (error as Error).message;
      writeState(state);
      throw error;
    } finally {
      syncing = false;
      const { progress: current } = getActivitySnapshot();
      if (current.phase !== "idle" && current.phase !== "done") {
        setSyncProgress({ phase: "idle" });
      }
    }
  }

  function listByTier(tier?: string | null) {
    const state = readState();
    const pools = Object.values(state.pools);
    if (tier === "all") return pools;
    if (syncing) {
      return pools.filter(
        (pool) =>
          pool.healthStatus === "pending" ||
          pool.healthStatus === "checking" ||
          pool.tier !== "dead"
      );
    }
    if (!tier) return pools.filter((pool) => pool.tier !== "dead");
    return pools.filter((pool) => pool.tier === tier);
  }

  function getStatus() {
    const state = readState();
    const { nineRouterSyncMinutes, activePoolLimit } = getSettingsSecrets();
    const { entries, progress } = getActivitySnapshot();
    return {
      running: syncing,
      configured: nineRouterConfigured(),
      authMode: nineRouterAuthMode(),
      lastSyncAt: state.lastSyncAt,
      lastError: state.lastError || lastError,
      stats: state.stats,
      syncIntervalMinutes: nineRouterSyncMinutes,
      activeLimit: activePoolLimit,
      activity: entries.slice(0, 20),
      syncProgress: progress,
    };
  }

  async function activatePool(id: string, isActive: boolean) {
    const state = readState();
    const pool = state.pools[id];
    if (!pool) throw new Error("Pool not found in local state");
    const activeLimit = getSettingsSecrets().activePoolLimit;
    if (isActive) {
      const activeCount = Object.values(state.pools).filter(
        (item) => item.tier === "active" && item.isActiveOnRouter
      ).length;
      if (!pool.isActiveOnRouter && activeCount >= activeLimit) {
        throw new Error(`Active pool limit (${activeLimit}) reached`);
      }
    }
    await setPoolActive(id, isActive);
    pool.isActiveOnRouter = isActive;
    pool.tier = isActive ? "active" : pool.status === "usable" ? "reserve" : "dead";
    state.stats.active = Object.values(state.pools).filter((item) => item.tier === "active").length;
    state.stats.reserve = Object.values(state.pools).filter((item) => item.tier === "reserve").length;
    writeState(state);
    metrics.recordFromPools(Object.values(state.pools), state.stats);
    return pool;
  }

  function isSyncing() {
    return syncing;
  }

  function getMetrics(sinceMs?: number) {
    return metrics.list(sinceMs);
  }

  return { syncPools, listByTier, getStatus, activatePool, readState, isSyncing, getMetrics };
}
