import { logActivity } from "./activity-log.js";
import type { AntigravityRotator } from "./antigravity-rotator.js";
export interface UnifiedSyncReport {
  started: boolean;
  running?: boolean;
  syncResult?: unknown;
  rotatorSnapshot?: unknown;
  durationMs?: number;
  completedAt?: number;
  error?: string;
}

export interface UnifiedSyncCoordinator {
  runUnifiedSyncCycle(options?: { force?: boolean }): Promise<UnifiedSyncReport>;
  readonly isRunning: boolean;
}

export function createUnifiedSyncCoordinator(deps: {
  poolRanker: { syncPools(opts?: { force?: boolean }): Promise<unknown>; isSyncing?: () => boolean };
  antigravityRotator: { runRotation(opts?: { force?: boolean }): Promise<unknown>; isRunning?: boolean };
}): UnifiedSyncCoordinator {
  let isRunning = false;

  async function runUnifiedSyncCycle(options: { force?: boolean } = {}): Promise<UnifiedSyncReport> {
    if (isRunning || (deps.poolRanker.isSyncing && deps.poolRanker.isSyncing()) || deps.antigravityRotator.isRunning) {
      logActivity("warn", "Unified Sync: already running, skipping overlapping cycle");
      return { started: false, running: true };
    }

    isRunning = true;
    const start = Date.now();
    logActivity("info", "Unified Sync Cycle: starting 9Router health check, auto-evict & account sync...");

    try {
      // 1. Run 9Router Sync: check health via testPool, evict dead, rank & reverse-rename
      const syncResult = await deps.poolRanker.syncPools({ force: options.force ?? true });

      // 2. Immediately run Antigravity rotation: replenish dead proxies for accounts
      const rotatorSnapshot = await deps.antigravityRotator.runRotation({ force: options.force ?? true });

      const durationMs = Date.now() - start;
      logActivity("success", `Unified Sync Cycle: finished in ${Math.round(durationMs / 1000)}s`);

      return {
        started: true,
        running: false,
        syncResult,
        rotatorSnapshot,
        durationMs,
        completedAt: Date.now(),
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logActivity("error", `Unified Sync Cycle failed: ${errMsg}`);
      return {
        started: false,
        running: false,
        durationMs: Date.now() - start,
        error: errMsg,
      };
    } finally {
      isRunning = false;
    }
  }

  return {
    runUnifiedSyncCycle,
    get isRunning() {
      return isRunning;
    },
  };
}
