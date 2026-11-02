import { logActivity, logScoped } from "./activity-log.js";

export interface UnifiedSyncCycleOptions {
  force?: boolean;
  router?: boolean;
  rotation?: boolean;
}

export interface UnifiedSyncReport {
  started: boolean;
  running?: boolean;
  syncResult?: unknown;
  rotatorSnapshot?: unknown;
  durationMs?: number;
  completedAt?: number;
  error?: string;
  routerSkipped?: boolean;
  rotationSkipped?: boolean;
}

export interface UnifiedSyncCoordinator {
  runUnifiedSyncCycle(options?: UnifiedSyncCycleOptions): Promise<UnifiedSyncReport>;
  readonly isRunning: boolean;
}

export interface UnifiedSyncCoordinatorDeps {
  poolRanker: {
    syncPools(opts?: { force?: boolean }): Promise<unknown>;
    isSyncing?: () => boolean;
    listByTier?: (tier?: string | null) => Array<{
      proxyUrl: string;
      remoteId?: string | null;
      tier?: string;
      status?: string;
      isActiveOnRouter?: boolean;
      latency_ms?: number | null;
      exit_ip?: string | null;
    }>;
  };
  antigravityRotator: {
    runRotation(opts?: { force?: boolean }): Promise<unknown>;
    isRunning?: boolean;
  };
  proxyIntelligenceRepo?: {
    syncWorkingPools(
      pools: Array<{
        proxyUrl: string;
        remoteId?: string | null;
        tier?: string;
        status?: string;
        isActiveOnRouter?: boolean;
        latency_ms?: number | null;
        exit_ip?: string | null;
      }>,
    ): Promise<unknown>;
  };
}

export function createUnifiedSyncCoordinator(
  deps: UnifiedSyncCoordinatorDeps,
): UnifiedSyncCoordinator {
  let isRunning = false;

  async function runUnifiedSyncCycle(
    options: UnifiedSyncCycleOptions = {},
  ): Promise<UnifiedSyncReport> {
    if (isRunning) {
      logScoped("UnifiedSync", "runCycle", "warn", "Already running, skipping overlapping cycle");
      return { started: false, running: true };
    }

    isRunning = true;
    const start = Date.now();

    const force = options.force ?? true;
    const routerRequested = options.router !== false;
    const rotationRequested = options.rotation !== false;

    const routerBusy =
      routerRequested && Boolean(deps.poolRanker.isSyncing && deps.poolRanker.isSyncing());
    const rotatorBusy = rotationRequested && Boolean(deps.antigravityRotator.isRunning);

    const shouldRunRouter = routerRequested && !routerBusy;
    const shouldRunRotation = rotationRequested && !rotatorBusy;

    const routerStatus = !routerRequested ? "off" : routerBusy ? "busy(skip)" : "due";
    const rotationStatus = !rotationRequested ? "off" : rotatorBusy ? "busy(skip)" : "due";

    logScoped("UnifiedSync", "runCycle", "info", "Starting maintenance cycle", {
      router: routerStatus,
      rotation: rotationStatus,
      force,
    });

    let syncResult: unknown;
    let routerError: string | undefined;
    let rotatorSnapshot: unknown;
    let rotatorError: string | undefined;
    try {
      const tasks: Promise<void>[] = [];

      // Task 1: 9Router Sync + DB reconcile
      if (shouldRunRouter) {
        tasks.push(
          (async () => {
            logScoped("UnifiedSync", "poolRanker", "info", "Starting pool sync...", { force });
            const syncStart = Date.now();
            syncResult = await deps.poolRanker.syncPools({ force });
            const syncElapsed = Date.now() - syncStart;
            logScoped("UnifiedSync", "poolRanker", "success", "Pool sync completed", {
              elapsedMs: syncElapsed,
            });

            if (deps.proxyIntelligenceRepo && typeof deps.poolRanker.listByTier === "function") {
              try {
                const survivors = deps.poolRanker
                  .listByTier("all")
                  .filter((p) => p.status === "usable" && Boolean(p.remoteId));
                await deps.proxyIntelligenceRepo.syncWorkingPools(survivors);
                logScoped(
                  "UnifiedSync",
                  "poolRanker",
                  "info",
                  `Reconciled ${survivors.length} active pool(s) into database`,
                  { count: survivors.length },
                );
              } catch (reconcileErr) {
                logScoped(
                  "UnifiedSync",
                  "poolRanker",
                  "warn",
                  `DB reconcile skipped: ${(reconcileErr as Error).message}`,
                );
              }
            }
          })(),
        );
      }

      // Task 2: Antigravity rotation
      if (shouldRunRotation) {
        tasks.push(
          (async () => {
            logScoped("UnifiedSync", "antigravityRotator", "info", "Starting account rotation...", {
              force,
            });
            const rotStart = Date.now();
            rotatorSnapshot = await deps.antigravityRotator.runRotation({ force });
            const rotElapsed = Date.now() - rotStart;
            logScoped(
              "UnifiedSync",
              "antigravityRotator",
              "success",
              "Account rotation completed",
              {
                elapsedMs: rotElapsed,
              },
            );
          })(),
        );
      }

      const settled = await Promise.allSettled(tasks);

      let taskIndex = 0;
      if (shouldRunRouter) {
        const outcome = settled[taskIndex++];
        if (outcome.status === "rejected") {
          routerError =
            outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
          logScoped("UnifiedSync", "poolRanker", "error", `9Router sync failed: ${routerError}`);
        }
      }
      if (shouldRunRotation) {
        const outcome = settled[taskIndex++];
        if (outcome.status === "rejected") {
          rotatorError =
            outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
          logScoped(
            "UnifiedSync",
            "antigravityRotator",
            "error",
            `Antigravity rotation failed: ${rotatorError}`,
          );
        }
      }

      const durationMs = Date.now() - start;
      const failedCount = [routerError, rotatorError].filter(Boolean).length;
      const totalTasks = tasks.length;
      const executedCount = totalTasks;
      logScoped(
        "UnifiedSync",
        "runCycle",
        failedCount > 0 ? "warn" : "success",
        `Cycle finished in ${Math.round(durationMs / 1000)}s`,
        {
          durationMs,
          executed: `${executedCount}/${totalTasks}`,
          failed: failedCount,
        },
      );

      const report: UnifiedSyncReport = {
        started: true,
        running: false,
        durationMs,
        completedAt: Date.now(),
      };

      if (shouldRunRouter) {
        report.syncResult = syncResult;
        if (routerError) report.error = routerError;
      } else {
        report.routerSkipped = true;
      }

      if (shouldRunRotation) {
        report.rotatorSnapshot = rotatorSnapshot;
        if (rotatorError && !report.error) report.error = rotatorError;
      } else {
        report.rotationSkipped = true;
      }

      return report;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logScoped("UnifiedSync", "runCycle", "error", `Critical failure: ${errMsg}`);
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
