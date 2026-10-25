import type {
  DualRouterCoordinator,
  DualRouterScheduler,
  RunReport,
  SyncRepository,
} from "./types.js";

const FULL_SYNC_INTERVAL_MS = 48 * 3600 * 1000;
const INCREMENTAL_SYNC_INTERVAL_MS = 10 * 60 * 1000;

export function createDualRouterScheduler(input: {
  repository: SyncRepository;
  coordinator: DualRouterCoordinator;
}): DualRouterScheduler {
  const { repository, coordinator } = input;

  return {
    async tick(now: number): Promise<RunReport | null> {
      const policy = repository.getPolicy();
      if (!policy.enabled) {
        return null;
      }

      if (now >= policy.nextFullAt) {
        const report = await coordinator.run({
          mode: "full",
          trigger: "scheduled",
          now,
        });
        policy.nextFullAt = now + FULL_SYNC_INTERVAL_MS;
        if (now >= policy.nextIncrementalAt) {
          policy.nextIncrementalAt = now + INCREMENTAL_SYNC_INTERVAL_MS;
        }
        repository.savePolicy(policy);
        return report;
      }

      if (now >= policy.nextIncrementalAt) {
        const report = await coordinator.run({
          mode: "incremental",
          trigger: "scheduled",
          now,
        });
        policy.nextIncrementalAt = now + INCREMENTAL_SYNC_INTERVAL_MS;
        repository.savePolicy(policy);
        return report;
      }

      return null;
    },
  };
}
