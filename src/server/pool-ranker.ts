import fs from "node:fs";
import path from "node:path";
import type { DetailedDiagnosticResult, ParsedProxy, PoolRecord, PoolStats, RemoteState, TestState } from "../lib/types.js";
import { getSettingsSecrets } from "./app-config.js";
import { getActivitySnapshot, logActivity, logActivityThrottled, resetSyncProgress, setSyncProgress } from "./activity-log.js";
import { createMetricsHistory } from "./metrics-history.js";
import {
  bulkSetActive as defaultBulkSetActive,
  createPool as defaultCreatePool,
  deletePool as defaultDeletePool,
  listPools as defaultListPools,
  nineRouterAuthMode,
  nineRouterConfigured,
  setPoolActive as defaultSetPoolActive,
  testPool as defaultTestPool,
  updatePool as defaultUpdatePool,
  renamePool as defaultRenamePool,
} from "./nine-router-client.js";
import { parseProxy } from "./proxy-core.js";

export class PoolConflictError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "PoolConflictError";
  }
}

export interface PoolRankerDeps {
  listPools: typeof defaultListPools;
  setPoolActive: typeof defaultSetPoolActive;
  bulkSetActive: typeof defaultBulkSetActive;
  deletePool: typeof defaultDeletePool;
  createPool: typeof defaultCreatePool;
  updatePool: typeof defaultUpdatePool;
  testPool: typeof defaultTestPool;
  renamePool?: (id: string, name: string) => Promise<unknown> | unknown;
  onSoftDelete?: (proxyKey: string, error?: string) => Promise<void> | void;
  onTestResult?: (proxyKey: string, ok: boolean, latencyMs?: number, error?: string) => Promise<void> | void;
  checkProxy?: unknown;
}

const defaultDeps: PoolRankerDeps = {
  listPools: defaultListPools,
  setPoolActive: defaultSetPoolActive,
  bulkSetActive: defaultBulkSetActive,
  deletePool: defaultDeletePool,
  createPool: defaultCreatePool,
  updatePool: defaultUpdatePool,
  testPool: defaultTestPool,
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
    remoteTestStatus: typeof item.remoteTestStatus === "string" ? item.remoteTestStatus : null,
    remoteLastError: typeof item.remoteLastError === "string" ? item.remoteLastError : null,
    remoteLastTestedAt: typeof item.remoteLastTestedAt === "number" ? item.remoteLastTestedAt : null,
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
  options: { dataDir?: string; repo?: unknown; onSoftDelete?: (key: string, err?: string) => Promise<void> | void; onTestResult?: (key: string, ok: boolean, latencyMs?: number, err?: string) => Promise<void> | void } | Partial<PoolRankerDeps> = {},
  injectedDeps: Partial<PoolRankerDeps> = {}
) {
  let dataDir = path.resolve(process.cwd(), "data");
  let combinedDeps: Partial<PoolRankerDeps> = {};
  if (options && typeof options === "object" && "dataDir" in options && typeof options.dataDir === "string") {
    dataDir = options.dataDir;
    if (options.onSoftDelete) combinedDeps.onSoftDelete = options.onSoftDelete;
    if (options.onTestResult) combinedDeps.onTestResult = options.onTestResult;
    combinedDeps = { ...combinedDeps, ...injectedDeps };
  } else {
    combinedDeps = { ...(options as Partial<PoolRankerDeps>), ...injectedDeps };
  }
  const deps: PoolRankerDeps = { ...defaultDeps, ...combinedDeps };
  const stateFile = path.join(dataDir, "pool-state.json");
  const metrics = createMetricsHistory({ dataDir });
  let lastRemoteRefreshAt = 0;
  let refreshPromise: Promise<{ refreshed: boolean; skipped: boolean; error?: string }> | null = null;
  let lastAutoSyncAttemptAt = 0;
  let syncing = false;
  let lastError = "";

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

  async function refreshRemoteTrackingInternal(): Promise<{ refreshed: boolean; skipped: boolean; error?: string }> {
    if (syncing) return { refreshed: false, skipped: true };
    try {
      const remotePools = await deps.listPools();
      lastRemoteRefreshAt = Date.now();
      const current = readState();
      const previousPools = current.pools;
      const nextPools: Record<string, PoolRecord> = {};

      const existingByRemoteId = new Map<string, PoolRecord>();
      const existingByEndpoint = new Map<string, PoolRecord>();
      for (const record of Object.values(previousPools)) {
        if (record.remoteId) existingByRemoteId.set(record.remoteId, record);
        const parsed = parseProxy(record.proxyUrl);
        if (parsed) existingByEndpoint.set(parsed.endpoint, record);
      }

      for (const remote of remotePools) {
        const parsed = parseProxy(remote.proxyUrl);
        const matched = existingByRemoteId.get(remote.id) ?? (parsed ? existingByEndpoint.get(parsed.endpoint) : undefined);
        const localId = matched?.localId ?? remote.id;
        const prev = previousPools[localId] ?? matched;

        const hasActiveBool = typeof remote.isActive === "boolean";
        const isActiveOnRouter = hasActiveBool ? Boolean(remote.isActive) : (prev?.isActiveOnRouter ?? false);
        let tier: PoolRecord["tier"] = prev?.tier ?? "reserve";
        if (hasActiveBool) {
          if (remote.isActive === true) {
            tier = "active";
          } else if (tier === "active") {
            tier = "reserve";
          }
        }

        let remoteLastTestedAt: number | null = null;
        if (remote.lastTestedAt) {
          const parsedTime = new Date(remote.lastTestedAt).getTime();
          if (!Number.isNaN(parsedTime)) remoteLastTestedAt = parsedTime;
        }

        nextPools[localId] = {
          localId,
          remoteId: remote.id,
          remoteState: "linked",
          testState: prev?.testState ?? "idle",
          name: remote.name || prev?.name || "Unnamed proxy",
          proxyUrl: remote.proxyUrl || prev?.proxyUrl || "",
          type: remote.type || prev?.type || "http",
          status: prev?.status ?? "usable",
          tier,
          healthStatus: prev?.healthStatus ?? "done",
          latency_ms: prev?.latency_ms ?? null,
          exit_ip: prev?.exit_ip ?? null,
          checked_at: prev?.checked_at ?? 0,
          isActiveOnRouter,
          remoteTestStatus: remote.testStatus ?? null,
          remoteLastError: remote.lastError ?? null,
          remoteLastTestedAt: remoteLastTestedAt ?? prev?.remoteLastTestedAt ?? null,
          successes: prev?.successes ?? 0,
          failures: prev?.failures ?? 0,
          firstFailure: prev?.firstFailure,
          last_error: prev?.last_error,
        };
      }

      // Any local linked pool not in remote list becomes removed
      for (const [id, record] of Object.entries(previousPools)) {
        if (!nextPools[id]) {
          if (record.remoteState === "linked") {
            nextPools[id] = {
              ...record,
              remoteId: null,
              remoteState: "removed",
              tier: "removed",
              isActiveOnRouter: false,
            };
          } else {
            nextPools[id] = { ...record };
          }
        }
      }

      current.pools = nextPools;
      current.stats = computeStats(Object.values(nextPools));
      writeState(current);
      return { refreshed: true, skipped: false };
    } catch (err: unknown) {
      const message = (err as Error).message;
      logActivityThrottled("remote-track-fail", "warn", `Remote tracking refresh failed: ${message}`);
      return { refreshed: false, skipped: false, error: message };
    }
  }

  async function refreshRemoteTracking(): Promise<{ refreshed: boolean; skipped: boolean; error?: string }> {
    if (syncing) return { refreshed: false, skipped: true };
    if (refreshPromise) return refreshPromise;
    if (Date.now() - lastRemoteRefreshAt < 60_000) {
      return { refreshed: false, skipped: true };
    }
    refreshPromise = refreshRemoteTrackingInternal();
    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  }



  async function syncPools(options: { force?: boolean } = {}) {
    if (syncing) {
      logActivity("warn", "Sync already running — skipped duplicate request");
      return { started: false, running: true };
    }
    if (!nineRouterConfigured()) throw new Error("9Router password is not configured in Settings");

    const force = options.force === true;
    const intervalMs = Math.max(1, getSettingsSecrets().nineRouterSyncMinutes) * 60_000;
    const currentForCheck = readState();
    if (!force && typeof currentForCheck.lastSyncAt === "number" && Date.now() - currentForCheck.lastSyncAt < intervalMs) {
      await refreshRemoteTracking();
      return { started: false, running: false, stale: false, tracked: true };
    }

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
      const httpPools = remotePools.filter((pool) => !pool.type || ["http", "socks", "socks5"].includes(pool.type.toLowerCase()));
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

      const targetsToSync: string[] = [];

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

        targetsToSync.push(localId);
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
      if (targetsToSync.length > 0) {
        logActivity("info", `Listed ${targetsToSync.length} proxies — starting 9Router health checks…`);
        setSyncProgress({ phase: "check", total: targetsToSync.length, checked: 0 });
      }

      const verifiedSurvivorIds = new Set<string>();
      let checkCursor = 0;
      let completedCount = 0;

      async function syncWorker() {
        while (checkCursor < targetsToSync.length) {
          const idx = checkCursor++;
          const localId = targetsToSync[idx];
          const pool = readState().pools[localId];
          if (!pool || !pool.remoteId) {
            completedCount++;
            setSyncProgress({ phase: "check", checked: completedCount, total: targetsToSync.length });
            continue;
          }

          mutatePool(localId, (t) => {
            t.testState = "checking";
            t.healthStatus = "checking";
          });

          try {
            const res = await deps.testPool(pool.remoteId);
            if (res.ok) {
              verifiedSurvivorIds.add(localId);
              mutatePool(localId, (t) => {
                t.testState = "idle";
                t.healthStatus = "done";
                t.status = "usable";
                t.latency_ms = typeof res.elapsedMs === "number" ? res.elapsedMs : t.latency_ms;
                t.checked_at = res.testedAt ? new Date(res.testedAt).getTime() : Date.now();
                t.remoteTestStatus = "active";
                t.remoteLastError = null;
                t.successes += 1;
              });
              if (deps.onTestResult) {
                try {
                  await deps.onTestResult(pool.proxyUrl || localId, true, res.elapsedMs);
                } catch {}
              }
            } else {
              if (res.failureKind === "transport") {
                const errMsg = res.error || "9Router transport failure";
                logActivity("error", `Infrastructure test error for ${pool.name} (${localId}): ${errMsg}`);
                mutatePool(localId, (t) => {
                  t.testState = "idle";
                  t.healthStatus = "done";
                  t.last_error = errMsg;
                });
                continue;
              }
              // Explicit 9Router test failure: deactivate, then delete from 9Router
              const errMsg = res.error || `HTTP ${res.status || "FAIL"}`;
              logActivity("warn", `9Router health check failed for ${pool.name} (${localId}): ${errMsg} — removing from 9Router…`);
              await deps.setPoolActive(pool.remoteId, false).catch((err) => {
                logActivity("warn", `Deactivate failed before delete for ${pool.name}: ${(err as Error).message}`);
              });

              try {
                await deps.deletePool(pool.remoteId);
                mutatePool(localId, (t) => {
                  t.remoteId = null;
                  t.remoteState = "removed";
                  t.tier = "removed";
                  t.isActiveOnRouter = false;
                  t.testState = "idle";
                  t.healthStatus = "done";
                  t.status = "dead";
                  t.last_error = errMsg;
                  t.remoteLastError = errMsg;
                  t.remoteTestStatus = "failed";
                  t.failures += 1;
                });
                if (deps.onSoftDelete) {
                  try {
                    await deps.onSoftDelete(pool.proxyUrl || localId, errMsg);
                  } catch {}
                }
                if (deps.onTestResult) {
                  try {
                    await deps.onTestResult(pool.proxyUrl || localId, false, undefined, errMsg);
                  } catch {}
                }
                logActivity("info", `Removed dead proxy ${pool.name} (${localId}) from 9Router; kept locally`);
              } catch (delErr) {
                const status = delErr && typeof delErr === "object" && "status" in delErr ? delErr.status : undefined;
                if (status === 404) {
                  mutatePool(localId, (t) => {
                    t.remoteId = null;
                    t.remoteState = "removed";
                    t.tier = "removed";
                    t.isActiveOnRouter = false;
                    t.testState = "idle";
                    t.healthStatus = "done";
                    t.status = "dead";
                    t.last_error = errMsg;
                  });
                } else {
                  mutatePool(localId, (t) => {
                    t.remoteState = "delete_failed";
                    t.tier = "removed";
                    t.isActiveOnRouter = false;
                    t.testState = "idle";
                    t.healthStatus = "done";
                    t.status = "dead";
                    t.last_error = (delErr as Error).message;
                  });
                }
              }
            }
          } catch (infraErr) {
            // Infrastructure error (e.g. network/auth throw): do NOT delete, leave linked
            const msg = (infraErr as Error).message;
            logActivity("error", `Infrastructure test error for ${pool.name} (${localId}): ${msg}`);
            mutatePool(localId, (t) => {
              t.testState = "idle";
              t.healthStatus = "done";
              t.last_error = msg;
            });
          } finally {
            completedCount++;
            setSyncProgress({ phase: "check", checked: completedCount, total: targetsToSync.length });
          }
        }
      }

      const workerCount = Math.max(1, Math.min(checkConcurrency, targetsToSync.length || 1));
      await Promise.all(Array.from({ length: workerCount }, () => syncWorker()));

      // Ranking survivors
      const latestState = readState();
      const allPools = Object.values(latestState.pools);
      const eligibleUsable = allPools.filter(
        (p) => verifiedSurvivorIds.has(p.localId) && p.status === "usable" && p.remoteState === "linked"
      );
      const rankedUsable = rankUsable(eligibleUsable);
      const activeIds = new Set(rankedUsable.slice(0, activePoolLimit).map((p) => p.localId));

      setSyncProgress({ phase: "rank" });
      logActivity(
        "info",
        `Ranking complete: ${rankedUsable.length} usable, ${allPools.length - rankedUsable.length} dead/removed → top ${activePoolLimit} active`
      );

      setSyncProgress({ phase: "activate" });
      logActivity("info", `Updating pool toggle(s) on 9Router…`);
      const updates = rankedUsable
        .filter((pool) => pool.remoteId && pool.remoteState === "linked")
        .map((pool) => ({ id: pool.remoteId!, isActive: activeIds.has(pool.localId) }));
      const activationResults = await deps.bulkSetActive(updates);
      const activationById = new Map(activationResults.map((r) => [r.id, r]));

      for (const pool of rankedUsable) {
        if (!pool.remoteId) continue;
        const res = activationById.get(pool.remoteId);
        mutatePool(pool.localId, (t) => {
          if (res?.ok) {
            t.isActiveOnRouter = res.isActive;
            t.tier = res.isActive ? "active" : "reserve";
          } else if (res) {
            t.tier = t.isActiveOnRouter ? "active" : "reserve";
            t.last_error = res.error || "Activation update failed";
          }
        });
      }

      const afterActivation = readState();
      const afterPools = Object.values(afterActivation.pools);
      const stats = computeStats(afterPools, skipped);
      const failedActivations = activationResults.filter((item) => !item.ok);

      const state: PoolState = {
        pools: afterActivation.pools,
        lastSyncAt: Date.now(),
        stats,
        lastError: failedActivations.length ? `${failedActivations.length} activation update(s) failed` : "",
      };
      writeState(state);
      metrics.recordFromPools(afterPools, stats);
      lastError = state.lastError;

      // Rename from highest rank to rank 1
      for (let i = rankedUsable.length - 1; i >= 0; i--) {
        const targetName = String(i + 1);
        const pool = rankedUsable[i];
        if (pool.name === targetName) continue;
        try {
          await renamePool(pool.localId, targetName);
        } catch (error) {
          logActivity(
            "warn",
            `Auto-rename skipped for pool ${pool.localId} to "${targetName}": ${(error as Error).message}`
          );
        }
      }

      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      setSyncProgress({ phase: "done", checked: targetsToSync.length, total: targetsToSync.length });
      logActivity("success", `Sync finished in ${elapsed}s — ${stats.active} active, ${stats.reserve} reserve`);

      return {
        started: true,
        running: false,
        activated: stats.active,
        reserve: stats.reserve,
        dead: stats.dead,
        skipped: skipped.length,
        errors: failedActivations,
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

  async function startSyncIfStale(): Promise<{ started: boolean; running: boolean; stale: boolean; tracked: boolean }> {
    if (syncing) return { started: false, running: true, stale: false, tracked: false };

    const { nineRouterAutoSync, nineRouterSyncMinutes } = getSettingsSecrets();
    if (nineRouterAutoSync === false) {
      return { started: false, running: false, stale: false, tracked: false };
    }

    const intervalMs = Math.max(1, nineRouterSyncMinutes) * 60_000;
    const currentState = readState();
    const lastSyncAt = currentState.lastSyncAt;
    const automaticReference = Math.max(lastSyncAt ?? 0, lastAutoSyncAttemptAt ?? 0);
    const isRecent = automaticReference > 0 && Date.now() - automaticReference < intervalMs;

    if (isRecent) {
      await refreshRemoteTracking();
      return { started: false, running: false, stale: false, tracked: true };
    }

    lastAutoSyncAttemptAt = Date.now();
    syncPools({ force: false }).catch((err) => {
      logActivity("error", `Scheduled sync failed: ${(err as Error).message}`);
    });

    return { started: true, running: false, stale: true, tracked: false };
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
    const { nineRouterAutoSync, nineRouterSyncMinutes, activePoolLimit } = getSettingsSecrets();
    const { entries, progress } = getActivitySnapshot();
    return {
      running: syncing,
      configured: nineRouterConfigured(),
      authMode: nineRouterAuthMode(),
      lastSyncAt: state.lastSyncAt,
      lastError: state.lastError || lastError,
      stats: state.stats,
      autoSync: nineRouterAutoSync !== false,
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
    logActivity("info", `${isActive ? "Activated" : "Deactivated"} pool ${pool.name} (${localId}) on 9Router`);
    return pool;
  }

  async function renamePool(localId: string, name: string): Promise<PoolRecord> {
    const validName = validatePoolName(name);
    const pool = readState().pools[localId];
    if (!pool) throw new Error(`Pool not found: ${localId}`);

    if ((pool.remoteState === "linked" || pool.remoteState === "delete_failed") && pool.remoteId) {
      try {
        if (deps.renamePool) {
          await deps.renamePool(pool.remoteId, validName);
        } else {
          await deps.updatePool(pool.remoteId, { name: validName });
        }
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 404) {
          try {
            const currentRemotes = await deps.listPools();
            const existingRemote = currentRemotes.find((r) => r.id === pool.remoteId);
            if (existingRemote) {
              // Remote ID exists
            } else {
              const parsedTarget = parseProxy(pool.proxyUrl);
              const matchedByEndpoint = currentRemotes.find((r) => {
                const parsedRemote = parseProxy(r.proxyUrl);
                return parsedTarget && parsedRemote && parsedRemote.endpoint === parsedTarget.endpoint;
              });
              if (matchedByEndpoint) {
                mutatePool(localId, (target) => {
                  target.remoteId = matchedByEndpoint.id;
                  target.remoteState = "linked";
                });
                logActivity("info", `Reconciled pool ${localId} with reappeared remote ID ${matchedByEndpoint.id}`);
              } else {
                mutatePool(localId, (target) => {
                  target.remoteId = null;
                  target.remoteState = "removed";
                  target.tier = "removed";
                  target.isActiveOnRouter = false;
                });
                logActivity("info", `Remote pool ${pool.remoteId} gone from 9Router (404); marked ${pool.name} (${localId}) removed`);
              }
            }
          } catch {
            // Ignore list error
          }
          logActivity("error", `Rename conflict: remote pool ${pool.remoteId} not found on 9Router (404)`);
          throw new PoolConflictError(`Proxy pool ${localId} no longer exists on 9Router`);
        }
        throw error;
      }
    }

    const updated = mutatePool(localId, (target) => {
      target.name = validName;
    });
    logActivity("info", `Renamed pool ${localId} to "${validName}"`);
    return updated;
  }

  async function removePool(localId: string): Promise<PoolRecord> {
    const pool = readState().pools[localId];
    if (!pool) throw new Error(`Pool not found: ${localId}`);

    if (pool.remoteId) {
      try {
        await deps.deletePool(pool.remoteId);
        logActivity("info", `Manually removed ${pool.name} (${localId}) from 9Router`);
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status !== 404) {
          mutatePool(localId, (target) => {
            target.remoteState = "delete_failed";
            target.tier = "removed";
            target.isActiveOnRouter = false;
            target.last_error = (error as Error).message;
          });
          logActivity("error", `Failed manual removal of ${pool.name} (${localId}): ${(error as Error).message}`);
          throw error;
        } else {
          logActivity("info", `Manual removal: remote pool ${pool.remoteId} already removed (404); updated local state`);
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


  async function promoteDiagnostics(results: DetailedDiagnosticResult[]) {
    const remotePools = await deps.listPools();
    const remoteByEndpoint = new Map(remotePools.map((pool) => [parseProxy(pool.proxyUrl)?.endpoint, pool]));
    const promoted: string[] = [];
    const skipped: string[] = [];
    for (const result of results) {
      const matched = remoteByEndpoint.get(result.endpoint);
      try {
        if (matched) {
          await deps.setPoolActive(matched.id, true);
          const state = readState();
          const existing = Object.values(state.pools).find((pool) => pool.remoteId === matched.id || parseProxy(pool.proxyUrl)?.endpoint === result.endpoint);
          if (existing) {
            existing.isActiveOnRouter = true;
            existing.remoteState = "linked";
            existing.tier = "active";
            writeState(state);
          }
        } else {
          const remote = await deps.createPool({
            name: `Diagnostic ${result.endpoint}`,
            proxyUrl: `${result.protocol}://${result.endpoint}`, 
            type: result.protocol,
            isActive: false,
          });
          await deps.setPoolActive(remote.id, true);
          const state = readState();
          state.pools[remote.id] = {
            localId: remote.id,
            remoteId: remote.id,
            remoteState: "linked",
            testState: "idle",
            name: remote.name || `Diagnostic ${result.endpoint}`,
            proxyUrl: remote.proxyUrl,
            type: remote.type || result.protocol,
            status: "usable",
            tier: "active",
            healthStatus: "done",
            latency_ms: result.latencyMs,
            exit_ip: result.exitIp,
            checked_at: result.checkedAt,
            isActiveOnRouter: true,
            successes: 1,
            failures: 0,
          };
          state.stats = computeStats(Object.values(state.pools));
          writeState(state);
        }
        promoted.push(result.id);
      } catch (error) {
        skipped.push(result.id);
        logActivity("warn", `Diagnostic promotion skipped for ${result.endpoint}: ${(error as Error).message}`);
      }
    }
    return { promoted: promoted.length, skipped: skipped.length, results: promoted, skippedIds: skipped };
  }

  function isSyncing(): boolean {
    return syncing;
  }

  function getMetrics(sinceMs?: number) {
    return metrics.list(sinceMs);
  }
  function exportActiveProxies(options: {
    format?: "txt" | "csv";
    includeCredentials?: boolean;
    scope?: "active" | "usable" | "all";
  } = {}) {
    const format = options.format ?? "txt";
    const includeCreds = Boolean(options.includeCredentials);
    const scope = options.scope ?? "active";

    let pools = listByTier(scope === "all" ? "all" : scope === "usable" ? null : "active");
    if (scope === "active") {
      pools = pools.filter((p) => p.isActiveOnRouter && p.status === "usable");
    }

    pools.sort((a, b) => (a.latency_ms ?? Number.MAX_SAFE_INTEGER) - (b.latency_ms ?? Number.MAX_SAFE_INTEGER));

    const dateStr = new Date().toISOString().slice(0, 10);

    if (format === "csv") {
      const header = "protocol,host,port,username,password\n";
      const rows = pools.map((p) => {
        try {
          const url = new URL(p.proxyUrl);
          const proto = url.protocol.replace(/:$/, "");
          const host = url.hostname;
          const port = url.port || (proto === "http" ? "80" : proto === "https" ? "443" : "1080");
          const u = includeCreds ? decodeURIComponent(url.username || "") : "";
          const pass = includeCreds ? decodeURIComponent(url.password || "") : "";
          return `"${proto}","${host}",${port},"${u}","${pass}"`;
        } catch {
          return `"${p.type || "http"}","${p.proxyUrl}",,"",""`;
        }
      });
      return {
        filename: `active-proxies-${dateStr}.csv`,
        contentType: "text/csv; charset=utf-8",
        body: header + rows.join("\n"),
        count: rows.length,
      };
    }

    const lines = pools.map((p) => {
      try {
        const url = new URL(p.proxyUrl);
        if (!includeCreds) {
          url.username = "";
          url.password = "";
        }
        return url.toString().replace(/\/$/, "");
      } catch {
        return p.proxyUrl;
      }
    });

    return {
      filename: `active-proxies-${dateStr}.txt`,
      contentType: "text/plain; charset=utf-8",
      body: lines.join("\n"),
      count: lines.length,
    };
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
    promoteDiagnostics,
    refreshRemoteTracking,
    startSyncIfStale,
    exportActiveProxies,
  };
}

export type PoolRanker = ReturnType<typeof createPoolRanker>;
