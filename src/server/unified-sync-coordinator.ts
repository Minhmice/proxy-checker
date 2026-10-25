import { logActivity, logScoped } from "./activity-log.js";

export interface UnifiedSyncCycleOptions {
  force?: boolean;
  router?: boolean;
  rotation?: boolean;
}

export interface FleetMaintenanceResult {
  pendingRemovals: number;
  syncedEndpoints: number;
  skipped?: boolean;
  error?: string;
}

export interface UnifiedSyncReport {
  started: boolean;
  running?: boolean;
  syncResult?: unknown;
  rotatorSnapshot?: unknown;
  fleetResult?: FleetMaintenanceResult;
  dualRouterResult?: unknown;
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
  fleetMaintenance?: () => Promise<{ pendingRemovals: number; syncedEndpoints: number }>;
  dualRouterScheduler?: {
    tick(now: number): Promise<unknown>;
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
    const fleetStatus = deps.fleetMaintenance ? "enabled" : "disabled";
    const dualRouterStatus = deps.dualRouterScheduler ? "enabled" : "disabled";

    logScoped("UnifiedSync", "runCycle", "info", "Starting maintenance cycle", {
      router: routerStatus,
      rotation: rotationStatus,
      fleet: fleetStatus,
      dualRouter: dualRouterStatus,
      force,
    });

    let syncResult: unknown;
    let routerError: string | undefined;
    let rotatorSnapshot: unknown;
    let rotatorError: string | undefined;
    let fleetResult: FleetMaintenanceResult | undefined;
    let dualRouterResult: unknown;
    let dualRouterError: string | undefined;
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

      // Task 3: Fleet maintenance (independent toggle / dependency)
      if (deps.fleetMaintenance) {
        tasks.push(
          (async () => {
            logScoped(
              "UnifiedSync",
              "fleetMaintenance",
              "info",
              "Starting fleet peer reconciliation...",
            );
            const fleetStart = Date.now();
            const res = await deps.fleetMaintenance!();
            const fleetElapsed = Date.now() - fleetStart;
            fleetResult = {
              pendingRemovals: res.pendingRemovals,
              syncedEndpoints: res.syncedEndpoints,
            };
            logScoped("UnifiedSync", "fleetMaintenance", "success", "Reconciliation finished", {
              elapsedMs: fleetElapsed,
              synced: res.syncedEndpoints,
              pendingRemovals: res.pendingRemovals,
            });
          })(),
        );
      }

      // Task 4: Dual 9Router scheduler tick
      if (deps.dualRouterScheduler) {
        tasks.push(
          (async () => {
            logScoped("UnifiedSync", "dualRouter", "info", "Starting scheduler tick...");
            const dualStart = Date.now();
            dualRouterResult = await deps.dualRouterScheduler!.tick(Date.now());
            const dualElapsed = Date.now() - dualStart;
            let tickMode: unknown = "completed";
            if (
              dualRouterResult &&
              typeof dualRouterResult === "object" &&
              "mode" in dualRouterResult
            ) {
              tickMode = dualRouterResult.mode;
            }
            logScoped("UnifiedSync", "dualRouter", "success", "Tick completed", {
              elapsedMs: dualElapsed,
              mode: tickMode ?? "idle",
            });
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
      if (deps.fleetMaintenance) {
        const outcome = settled[taskIndex++];
        if (outcome.status === "rejected") {
          const fleetErr =
            outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
          logScoped(
            "UnifiedSync",
            "fleetMaintenance",
            "error",
            `Fleet maintenance failed: ${fleetErr}`,
          );
          fleetResult = {
            pendingRemovals: 0,
            syncedEndpoints: 0,
            error: fleetErr,
          };
        }
      }
      if (deps.dualRouterScheduler) {
        const outcome = settled[taskIndex++];
        if (outcome.status === "rejected") {
          dualRouterError =
            outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
          logScoped(
            "UnifiedSync",
            "dualRouter",
            "error",
            `Dual 9Router tick failed: ${dualRouterError}`,
          );
        }
      }

      const durationMs = Date.now() - start;
      const failedCount = [routerError, rotatorError, fleetResult?.error, dualRouterError].filter(
        Boolean,
      ).length;
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

      if (fleetResult) {
        report.fleetResult = fleetResult;
        if (fleetResult.error && !report.error) {
          report.error = fleetResult.error;
        }
      }
      if (dualRouterResult !== undefined) {
        report.dualRouterResult = dualRouterResult;
        if (dualRouterError && !report.error) {
          report.error = dualRouterError;
        }
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
