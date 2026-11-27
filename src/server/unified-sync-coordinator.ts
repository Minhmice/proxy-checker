import { logScoped } from "./activity-log.js";

export interface UnifiedSyncCycleOptions {
  force?: boolean;
  rotation?: boolean;
}

export interface UnifiedSyncReport {
  started: boolean;
  running?: boolean;
  rotatorSnapshot?: unknown;
  durationMs?: number;
  completedAt?: number;
  error?: string;
  rotationSkipped?: boolean;
  rotationSkipReason?: "already-running";
}

export interface UnifiedSyncCoordinator {
  runUnifiedSyncCycle(options?: UnifiedSyncCycleOptions): Promise<UnifiedSyncReport>;
  readonly isRunning: boolean;
}

export interface UnifiedSyncCoordinatorDeps {
  antigravityRotator: {
    runRotation(opts?: { force?: boolean }): Promise<unknown>;
    isRunning?: boolean;
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
    const start = performance.now();
    const shouldRunRotation = options.rotation !== false && !deps.antigravityRotator.isRunning;
    try {
      const report: UnifiedSyncReport = { started: true, running: false };
      if (shouldRunRotation) {
        try {
          report.rotatorSnapshot = await deps.antigravityRotator.runRotation({
            force: options.force ?? true,
          });
        } catch (error) {
          report.error = error instanceof Error ? error.message : String(error);
          logScoped(
            "UnifiedSync",
            "antigravityRotator",
            "error",
            `Antigravity rotation failed: ${report.error}`,
          );
        }
      } else {
        report.rotationSkipped = true;
        if (options.rotation !== false) {
          report.rotationSkipReason = "already-running";
        }
      }
      report.durationMs = Math.round(performance.now() - start);
      report.completedAt = Date.now();
      return report;
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
