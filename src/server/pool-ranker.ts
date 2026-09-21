import fs from "node:fs";
import path from "node:path";
import type { ParsedProxy, PoolRecord, PoolStats, RemoteState, TestState } from "../lib/types.js";
import { getSettingsSecrets } from "./app-config.js";
import { getActivitySnapshot, logActivity, resetSyncProgress, setSyncProgress } from "./activity-log.js";
import { checkMany, checkProxy as defaultCheckProxy } from "./checker.js";
import { createMetricsHistory } from "./metrics-history.js";
import {
  bulkSetActive as defaultBulkSetActive,
  createPool as defaultCreatePool,
  deletePool as defaultDeletePool,
  listPools as defaultListPools,
  nineRouterAuthMode,
  nineRouterConfigured,
  setPoolActive as defaultSetPoolActive,
  updatePool as defaultUpdatePool,
} from "./nine-router-client.js";
import { parseProxy } from "./proxy-core.js";

export interface PoolRankerDeps {
  listPools: typeof defaultListPools;
  setPoolActive: typeof defaultSetPoolActive;
  bulkSetActive: typeof defaultBulkSetActive;
  deletePool: typeof defaultDeletePool;
  createPool: typeof defaultCreatePool;
  updatePool: typeof defaultUpdatePool;
  checkProxy: typeof defaultCheckProxy;
}

const defaultDeps: PoolRankerDeps = {
  listPools: defaultListPools,
  setPoolActive: defaultSetPoolActive,
  bulkSetActive: defaultBulkSetActive,
  deletePool: defaultDeletePool,
  createPool: defaultCreatePool,
  updatePool: defaultUpdatePool,
  checkProxy: defaultCheckProxy,
};

interface PoolState {
  pools: Record<string, PoolRecord>;
  lastSyncAt: number | null;
  stats: PoolStats;
  lastError: string;
}

function normalizeRecord(raw: unknown, fallbackKey: string): PoolRecord {
  const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const localId = String(item.localId || item.id || fallbackKey);
  const rawRemoteId = item.remoteId !== undefined ? item.remoteId : item.id;
  const remoteId = rawRemoteId === null || rawRemoteId === undefined ? null : String(rawRemoteId);
  const rawRemoteState = item.remoteState as RemoteState | undefined;
  const remoteState: RemoteState =
    rawRemoteState === "removed" || rawRemoteState === "revived" || rawRemoteState === "delete_failed"
      ? rawRemoteState
      : "linked";
  const rawTestState = item.testState as TestState | undefined;
  const testState: TestState =
    rawTestState === "queued" || rawTestState === "checking" || rawTestState === "retrying"
      ? rawTestState
      : "idle";
  const tier =
    remoteState === "removed" || remoteState === "delete_failed" || remoteState === "revived"
      ? "removed"
      : item.tier === "active" || item.tier === "reserve" || item.tier === "dead"
      ? item.tier
      : "reserve";

  return {
    localId,
    remoteId,
    remoteState,
    testState,
    name: String(item.name || "Unnamed proxy"),
    proxyUrl: String(item.proxyUrl || ""),
    type: String(item.type || "http"),
    status: item.status === "usable" ? "usable" : "dead",
    tier,
    healthStatus: item.healthStatus === "pending" || item.healthStatus === "checking" ? item.healthStatus : "done",
    latency_ms: typeof item.latency_ms === "number" ? item.latency_ms : null,
    exit_ip: typeof item.exit_ip === "string" ? item.exit_ip : null,
    checked_at: typeof item.checked_at === "number" ? item.checked_at : 0,
    isActiveOnRouter: item.isActiveOnRouter === true,
    successes: Number(item.successes || 0),
    failures: Number(item.failures || 0),
    firstFailure: typeof item.firstFailure === "string" ? item.firstFailure : undefined,
    last_error: typeof item.last_error === "string" ? item.last_error : undefined,
  };
}

function validatePoolName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Pool name cannot be empty");
  const codePoints = Array.from(trimmed).length;
  if (codePoints > 100) throw new Error("Pool name cannot exceed 100 characters");
  return trimmed;
}

export function createPoolRanker(
  { dataDir }: { dataDir: string },
  injectedDeps: Partial<PoolRankerDeps> = {}
) {
  const deps: PoolRankerDeps = { ...defaultDeps, ...injectedDeps };
  const stateFile = path.join(dataDir, "pool-state.json");
  const metrics = createMetricsHistory({ dataDir });
  let syncing = false;
  let lastError = "";
  const busyIds = new Set<string>();

  function emptyState(): PoolState {
    return { pools: {}, lastSyncAt: null, stats: { total: 0, active: 0, reserve: 0, dead: 0 }, lastError: "" };
  }

  function readState(): PoolState {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<string, unknown>;
      const rawPools = (raw.pools && typeof raw.pools === "object" ? raw.pools : {}) as Record<string, unknown>;
      const pools: Record<string, PoolRecord> = {};
      for (const [key, value] of Object.entries(rawPools)) {
        const normalized = normalizeRecord(value, key);
        pools[normalized.localId] = normalized;
      }
      return {
        pools,
        lastSyncAt: typeof raw.lastSyncAt === "number" ? raw.lastSyncAt : null,
        stats: computeStats(Object.values(pools)),
        lastError: typeof raw.lastError === "string" ? raw.lastError : "",
      };
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

  function mutatePool(localId: string, mutator: (pool: PoolRecord) => void): PoolRecord {
    const state = readState();
    const pool = state.pools[localId];
    if (!pool) throw new Error(`Pool not found: ${localId}`);
    mutator(pool);
    state.stats = computeStats(Object.values(state.pools));
    writeState(state);
    return pool;
  }

  function rankUsable(entries: PoolRecord[]) {
    return [...entries].sort(
      (a, b) =>
        (a.latency_ms ?? Number.MAX_SAFE_INTEGER) - (b.latency_ms ?? Number.MAX_SAFE_INTEGER) ||
        (b.successes ?? 0) - (a.successes ?? 0) ||
        String(a.localId).localeCompare(String(b.localId))
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

  function publishPools(poolMap: Record<string, PoolRecord>, skipped: string[], lastSyncAt: number | null, error = "") {
    writeState({
      pools: poolMap,
      lastSyncAt,
      stats: computeStats(Object.values(poolMap), skipped),
      lastError: error,
    });
  }

  function assignTiers(checkedPools: PoolRecord[]) {
    const activeLimit = getSettingsSecrets().activePoolLimit;
    const eligibleUsable = checkedPools.filter(
      (pool) => pool.status === "usable" && pool.remoteState === "linked"
    );
    const ranked = rankUsable(eligibleUsable);
    const activeIds = new Set(ranked.slice(0, activeLimit).map((p) => p.localId));
    const usableIds = new Set(ranked.map((p) => p.localId));

    for (const pool of checkedPools) {
      if (pool.remoteState === "removed" || pool.remoteState === "delete_failed" || pool.remoteState === "revived") {
        pool.tier = "removed";
        pool.isActiveOnRouter = false;
        continue;
      }
      if (!usableIds.has(pool.localId)) {
        pool.tier = "dead";
        pool.isActiveOnRouter = false;
        continue;
      }
      if (activeIds.has(pool.localId)) {
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
      const remotePools = await deps.listPools();
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

      for (const [id, record] of Object.entries(previous.pools)) {
        if (record.remoteState !== "linked") {
          poolMap[id] = { ...record };
        }
      }

      const existingByRemoteId = new Map<string, PoolRecord>();
      const existingByEndpoint = new Map<string, PoolRecord>();
      for (const record of Object.values(previous.pools)) {
        if (record.remoteId) existingByRemoteId.set(record.remoteId, record);
        const parsed = parseProxy(record.proxyUrl);
        if (parsed) existingByEndpoint.set(parsed.endpoint, record);
      }

      const checkTargets: Array<{
        localId: string;
        pool: { id: string; name: string; proxyUrl: string; type?: string };
        proxy: ParsedProxy;
      }> = [];

      for (const pool of httpPools) {
        const parsed = parseProxy(pool.proxyUrl);
        const matched = existingByRemoteId.get(pool.id) ?? (parsed ? existingByEndpoint.get(parsed.endpoint) : undefined);
        const localId = matched?.localId ?? pool.id;
        const prev = previous.pools[localId] ?? matched;

        if (!parsed) {
          poolMap[localId] = {
            localId,
            remoteId: pool.id,
            remoteState: "linked",
            testState: "idle",
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
            firstFailure: "Invalid proxy URL",
            last_error: "Invalid proxy URL",
          };
          continue;
        }

        checkTargets.push({ localId, pool, proxy: parsed });
        poolMap[localId] = {
          localId,
          remoteId: pool.id,
          remoteState: "linked",
          testState: "idle",
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
          firstFailure: prev?.firstFailure,
          last_error: prev?.last_error,
        };
      }

      publishPools(poolMap, skipped, previous.lastSyncAt);
      if (checkTargets.length > 0) {
        logActivity("info", `Listed ${checkTargets.length} proxies — starting health checks…`);
        setSyncProgress({ phase: "check", total: checkTargets.length, checked: 0 });
      }

      let lastLoggedAt = 0;
      let lastPublishedAt = Date.now();
      await checkMany(checkTargets.map((item) => item.proxy), checkConcurrency, {
        onStart: (index) => {
          const { localId } = checkTargets[index];
          if (poolMap[localId]) poolMap[localId] = { ...poolMap[localId], healthStatus: "checking" };
          const now = Date.now();
          if (now - lastPublishedAt >= 150) {
            publishPools(poolMap, skipped, previous.lastSyncAt);
            lastPublishedAt = now;
          }
        },
        onResult: (index, result) => {
          const { localId } = checkTargets[index];
          const prev = previous.pools[localId] ?? { successes: 0, failures: 0 };
          poolMap[localId] = {
            ...poolMap[localId],
            healthStatus: "done",
            status: result.status,
            latency_ms: result.latency_ms,
            exit_ip: result.exit_ip,
            checked_at: result.checked_at,
            successes: (prev.successes ?? 0) + result.successes,
            failures: (prev.failures ?? 0) + result.failures,
            firstFailure: result.status === "dead" ? poolMap[localId]?.firstFailure ?? result.last_error : undefined,
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
      const usable = checkedPools.filter((pool) => pool.status === "usable" && pool.remoteState === "linked").length;
      setSyncProgress({ phase: "rank" });
      logActivity(
        "info",
        `Ranking complete: ${usable} usable, ${checkedPools.length - usable} dead/removed → top ${activePoolLimit} active`
      );

      setSyncProgress({ phase: "activate" });
      logActivity("info", `Updating pool toggle(s) on 9Router…`);
      const updates = checkedPools
        .filter((pool) => pool.remoteId && pool.remoteState === "linked")
        .map((pool) => ({ id: pool.remoteId!, isActive: pool.isActiveOnRouter }));
      const activationResults = await deps.bulkSetActive(updates);
      const failed = activationResults.filter((item) => !item.ok);

      const stats = computeStats(checkedPools, skipped);
      const state: PoolState = {
        pools: poolMap,
        lastSyncAt: Date.now(),
        stats,
        lastError: failed.length ? `${failed.length} activation update(s) failed` : "",
      };
      writeState(state);
      metrics.recordFromPools(checkedPools, stats);
      lastError = state.lastError;

      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      setSyncProgress({ phase: "done", checked: checkTargets.length, total: checkTargets.length });
      logActivity("success", `Sync finished in ${elapsed}s — ${stats.active} active, ${stats.reserve} reserve`);

      const removedToCheck = Object.values(poolMap).filter((p) => p.remoteState === "removed");
      if (removedToCheck.length > 0) {
        void testPools(removedToCheck.map((p) => p.localId)).catch(() => {});
      }

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
    if (tier === "removed") {
      return pools.filter((pool) => pool.remoteState === "removed" || pool.remoteState === "delete_failed" || pool.remoteState === "revived");
    }
    if (tier === "active" || tier === "reserve" || tier === "dead") {
      return pools.filter((pool) => pool.tier === tier && pool.remoteState === "linked");
    }
    return pools.filter((pool) => pool.remoteState === "linked" && pool.tier !== "dead");
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

  async function activatePool(localId: string, isActive: boolean) {
    const state = readState();
    const pool = state.pools[localId];
    if (!pool) throw new Error("Pool not found in local state");
    if (pool.remoteState !== "linked" || !pool.remoteId) {
      throw new Error("Only linked pools can be activated on 9Router");
    }
    const activeLimit = getSettingsSecrets().activePoolLimit;
    if (isActive) {
      const activeCount = Object.values(state.pools).filter(
        (item) => item.tier === "active" && item.isActiveOnRouter
      ).length;
      if (!pool.isActiveOnRouter && activeCount >= activeLimit) {
        throw new Error(`Active pool limit (${activeLimit}) reached`);
      }
    }
    await deps.setPoolActive(pool.remoteId, isActive);
    pool.isActiveOnRouter = isActive;
    pool.tier = isActive ? "active" : pool.status === "usable" ? "reserve" : "dead";
    state.stats = computeStats(Object.values(state.pools));
    writeState(state);
    metrics.recordFromPools(Object.values(state.pools), state.stats);
    return pool;
  }

  async function renamePool(localId: string, name: string): Promise<PoolRecord> {
    const validName = validatePoolName(name);
    const pool = readState().pools[localId];
    if (!pool) throw new Error(`Pool not found: ${localId}`);

    if (pool.remoteState === "linked" && pool.remoteId) {
      await deps.updatePool(pool.remoteId, { name: validName });
    }

    return mutatePool(localId, (target) => {
      target.name = validName;
    });
  }

  async function removePool(localId: string): Promise<PoolRecord> {
    const pool = readState().pools[localId];
    if (!pool) throw new Error(`Pool not found: ${localId}`);

    if (pool.remoteId) {
      try {
        await deps.deletePool(pool.remoteId);
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status !== 404) {
          mutatePool(localId, (target) => {
            target.remoteState = "delete_failed";
            target.tier = "removed";
            target.isActiveOnRouter = false;
            target.last_error = (error as Error).message;
          });
          throw error;
        }
      }
    }

    return mutatePool(localId, (target) => {
      target.remoteId = null;
      target.remoteState = "removed";
      target.tier = "removed";
      target.isActiveOnRouter = false;
      target.testState = "idle";
    });
  }

  async function restorePool(localId: string): Promise<PoolRecord> {
    const pool = readState().pools[localId];
    if (!pool) throw new Error(`Pool not found: ${localId}`);
    if (pool.remoteState !== "revived" && pool.remoteState !== "removed") {
      throw new Error(`Cannot restore pool in ${pool.remoteState} state`);
    }

    const remotePools = await deps.listPools();
    const parsedTarget = parseProxy(pool.proxyUrl);
    const matched = remotePools.find((r) => {
      if (r.id === pool.remoteId) return true;
      const remoteParsed = parseProxy(r.proxyUrl);
      return parsedTarget && remoteParsed && remoteParsed.endpoint === parsedTarget.endpoint;
    });

    let assignedRemoteId = matched?.id;
    if (!assignedRemoteId) {
      const created = await deps.createPool({
        name: pool.name,
        proxyUrl: pool.proxyUrl,
        type: pool.type || "http",
        isActive: false,
      });
      assignedRemoteId = created.id;
    }

    return mutatePool(localId, (target) => {
      target.remoteId = assignedRemoteId!;
      target.remoteState = "linked";
      target.tier = "reserve";
      target.isActiveOnRouter = false;
      target.testState = "idle";
    });
  }

  async function runSinglePoolTest(localId: string) {
    const pool = readState().pools[localId];
    if (!pool) return;
    const parsed = parseProxy(pool.proxyUrl);
    if (!parsed) {
      mutatePool(localId, (target) => {
        target.testState = "idle";
        target.status = "dead";
        target.failures += 1;
        target.firstFailure = "Invalid proxy URL";
        target.last_error = "Invalid proxy URL";
      });
      return;
    }

    mutatePool(localId, (target) => {
      target.testState = "checking";
    });

    let result = await deps.checkProxy(parsed);
    let firstFailMsg: string | undefined;

    if (result.status === "dead") {
      firstFailMsg = result.last_error || "Check failed";
      mutatePool(localId, (target) => {
        target.testState = "retrying";
        target.firstFailure = firstFailMsg;
        target.failures += 1;
        target.last_error = firstFailMsg;
      });
      result = await deps.checkProxy(parsed);
    }

    if (result.status === "usable") {
      mutatePool(localId, (target) => {
        target.testState = "idle";
        target.status = "usable";
        target.latency_ms = result.latency_ms;
        target.exit_ip = result.exit_ip;
        target.checked_at = result.checked_at;
        target.successes += 1;
        if (firstFailMsg) {
          target.firstFailure = firstFailMsg;
        } else {
          target.firstFailure = undefined;
          target.last_error = undefined;
        }
        if (target.remoteState === "removed") {
          target.remoteState = "revived";
        }
      });
      return;
    }

    const secondFailMsg = result.last_error || firstFailMsg || "Proxy check failed";
    mutatePool(localId, (target) => {
      target.testState = "idle";
      target.status = "dead";
      target.failures += 1;
      target.firstFailure = firstFailMsg;
      target.last_error = secondFailMsg;
    });

    if (pool.remoteState === "linked" && pool.remoteId) {
      try {
        await deps.deletePool(pool.remoteId);
        mutatePool(localId, (target) => {
          target.remoteId = null;
          target.remoteState = "removed";
          target.tier = "removed";
          target.isActiveOnRouter = false;
        });
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 404) {
          mutatePool(localId, (target) => {
            target.remoteId = null;
            target.remoteState = "removed";
            target.tier = "removed";
            target.isActiveOnRouter = false;
          });
        } else {
          mutatePool(localId, (target) => {
            target.remoteState = "delete_failed";
            target.tier = "removed";
            target.isActiveOnRouter = false;
            target.last_error = (error as Error).message;
          });
        }
      }
    }
  }

  async function testPools(ids: string[]): Promise<{ accepted: string[]; busy: string[] }> {
    const accepted: string[] = [];
    const busy: string[] = [];
    const uniqueIds = Array.from(new Set(ids));
    const current = readState().pools;

    for (const id of uniqueIds) {
      if (!current[id]) continue;
      if (busyIds.has(id)) {
        busy.push(id);
      } else {
        busyIds.add(id);
        accepted.push(id);
        mutatePool(id, (target) => {
          target.testState = "queued";
        });
      }
    }

    for (const id of accepted) {
      try {
        await runSinglePoolTest(id);
      } finally {
        busyIds.delete(id);
      }
    }

    return { accepted, busy };
  }

  function isSyncing() {
    return syncing;
  }

  function getMetrics(sinceMs?: number) {
    return metrics.list(sinceMs);
  }

  return {
    syncPools,
    listByTier,
    getStatus,
    activatePool,
    readState,
    isSyncing,
    getMetrics,
    renamePool,
    removePool,
    restorePool,
    testPools,
  };
}
