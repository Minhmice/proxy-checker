import { logActivity } from "./activity-log.js";

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
  antigravityRotator: { runRotation(opts?: { force?: boolean }): Promise<unknown>; isRunning?: boolean };
  proxyIntelligenceRepo?: {
    syncWorkingPools(pools: Array<{
      proxyUrl: string;
      remoteId?: string | null;
      tier?: string;
      status?: string;
      isActiveOnRouter?: boolean;
      latency_ms?: number | null;
      exit_ip?: string | null;
    }>): Promise<unknown>;
  };
  fleetMaintenance?: () => Promise<{ pendingRemovals: number; syncedEndpoints: number }>;
}

export function createUnifiedSyncCoordinator(deps: UnifiedSyncCoordinatorDeps): UnifiedSyncCoordinator {
  let isRunning = false;

  async function runUnifiedSyncCycle(options: UnifiedSyncCycleOptions = {}): Promise<UnifiedSyncReport> {
    if (isRunning) {
      logActivity("warn", "Unified Sync: already running, skipping overlapping cycle");
      return { started: false, running: true };
    }

    isRunning = true;
    const start = Date.now();
    logActivity("info", "Unified Sync Cycle: starting concurrent maintenance tick...");

    const force = options.force ?? true;
    const routerRequested = options.router !== false;
    const rotationRequested = options.rotation !== false;

    const routerBusy = routerRequested && Boolean(deps.poolRanker.isSyncing && deps.poolRanker.isSyncing());
    const rotatorBusy = rotationRequested && Boolean(deps.antigravityRotator.isRunning);

    const shouldRunRouter = routerRequested && !routerBusy;
    const shouldRunRotation = rotationRequested && !rotatorBusy;

    let syncResult: unknown;
    let routerError: string | undefined;
    let rotatorSnapshot: unknown;
    let rotatorError: string | undefined;
    let fleetResult: FleetMaintenanceResult | undefined;

    try {
      const tasks: Promise<void>[] = [];

      // Task 1: 9Router Sync + DB reconcile
      if (shouldRunRouter) {
        tasks.push(
          (async () => {
            syncResult = await deps.poolRanker.syncPools({ force });
            if (deps.proxyIntelligenceRepo && typeof deps.poolRanker.listByTier === "function") {
              try {
                const survivors = deps.poolRanker.listByTier("all").filter(
                  (p) => p.status === "usable" && Boolean(p.remoteId)
                );
                await deps.proxyIntelligenceRepo.syncWorkingPools(survivors);
                logActivity("info", `Unified Sync Cycle: reconciled ${survivors.length} active pool(s) into database`);
              } catch (reconcileErr) {
                logActivity("warn", `Unified Sync Cycle: DB reconcile skipped: ${(reconcileErr as Error).message}`);
              }
            }
          })()
        );
      }

      // Task 2: Antigravity rotation
      if (shouldRunRotation) {
        tasks.push(
          (async () => {
            rotatorSnapshot = await deps.antigravityRotator.runRotation({ force });
          })()
        );
      }

      // Task 3: Fleet maintenance (independent toggle / dependency)
      if (deps.fleetMaintenance) {
        tasks.push(
          (async () => {
            const res = await deps.fleetMaintenance!();
            fleetResult = {
              pendingRemovals: res.pendingRemovals,
              syncedEndpoints: res.syncedEndpoints,
            };
          })()
        );
      }

      const settled = await Promise.allSettled(tasks);

      let taskIndex = 0;
      if (shouldRunRouter) {
        const outcome = settled[taskIndex++];
        if (outcome.status === "rejected") {
          routerError = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
          logActivity("error", `Unified Sync Cycle: 9Router sync failed: ${routerError}`);
        }
      }
      if (shouldRunRotation) {
        const outcome = settled[taskIndex++];
        if (outcome.status === "rejected") {
          rotatorError = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
          logActivity("error", `Unified Sync Cycle: Antigravity rotation failed: ${rotatorError}`);
        }
      }
      if (deps.fleetMaintenance) {
        const outcome = settled[taskIndex++];
        if (outcome.status === "rejected") {
          const fleetErr = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
          logActivity("error", `Unified Sync Cycle: Fleet maintenance failed: ${fleetErr}`);
          fleetResult = {
            pendingRemovals: 0,
            syncedEndpoints: 0,
            error: fleetErr,
          };
        }
      }

      const durationMs = Date.now() - start;
      logActivity("success", `Unified Sync Cycle: finished in ${Math.round(durationMs / 1000)}s`);

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

      return report;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logActivity("error", `Unified Sync Cycle critical failure: ${errMsg}`);
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
