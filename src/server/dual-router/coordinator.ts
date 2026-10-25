import type {
  Baseline,
  Conflict,
  DualRouterCoordinator,
  Operation,
  Outcome,
  Receipt,
  Resource,
  RouterAdapter,
  RunReport,
  RunRequest,
  RunStatus,
  Snapshot,
  SyncRepository,
  Value,
} from "./types.js";
import { planMerge } from "./merge.js";
import { logScoped } from "../activity-log.js";

function isConflicted(op: Operation, conflicts: Conflict[]): boolean {
  return conflicts.some(
    (c) =>
      c.resource === op.resource &&
      c.key === op.key &&
      (c.field === null || op.field === null || c.field === op.field),
  );
}

function advanceBaseline(repository: SyncRepository, baselines: Baseline[], op: Operation): void {
  if (op.field !== null) {
    const prev = baselines.find(
      (b) => b.resource === op.resource && b.key === op.key && b.field === op.field,
    );
    const revision = (prev?.revision ?? 0) + 1;
    const baseline: Baseline = {
      resource: op.resource,
      key: op.key,
      field: op.field,
      value: op.desired,
      deleted: op.kind === "delete",
      revision,
    };
    repository.saveBaseline(baseline);
    if (prev) {
      Object.assign(prev, baseline);
    } else {
      baselines.push(baseline);
    }
  } else if (op.kind === "create" && typeof op.desired === "object" && op.desired !== null) {
    for (const [field, val] of Object.entries(op.desired as Record<string, Value>)) {
      const prev = baselines.find(
        (b) => b.resource === op.resource && b.key === op.key && b.field === field,
      );
      const revision = (prev?.revision ?? 0) + 1;
      const baseline: Baseline = {
        resource: op.resource,
        key: op.key,
        field,
        value: val,
        deleted: false,
        revision,
      };
      repository.saveBaseline(baseline);
      if (prev) {
        Object.assign(prev, baseline);
      } else {
        baselines.push(baseline);
      }
    }
  } else if (op.kind === "delete") {
    const entityBaselines = baselines.filter((b) => b.resource === op.resource && b.key === op.key);
    if (entityBaselines.length > 0) {
      for (const b of entityBaselines) {
        const baseline: Baseline = {
          ...b,
          deleted: true,
          revision: b.revision + 1,
        };
        repository.saveBaseline(baseline);
        Object.assign(b, baseline);
      }
    } else {
      const baseline: Baseline = {
        resource: op.resource,
        key: op.key,
        field: "_deleted",
        value: null,
        deleted: true,
        revision: 1,
      };
      repository.saveBaseline(baseline);
      baselines.push(baseline);
    }
  }
}

export function createDualRouterCoordinator(input: {
  repository: SyncRepository;
  adapters: RouterAdapter[];
}): DualRouterCoordinator {
  const { repository, adapters } = input;

  return {
    async run(request: RunRequest): Promise<RunReport> {
      const runId = `run:${request.now}:${Math.random().toString(36).slice(2, 8)}`;
      const leaseTtl = 60000;
      const leaseEpoch = repository.acquireLease("dual-master", request.now, leaseTtl);

      if (leaseEpoch === null) {
        return {
          id: runId,
          status: "busy",
          operations: [],
          conflicts: [],
          unmetCapabilities: [],
          verifiedAt: null,
        };
      }

      logScoped("DualRouter", "run", "info", `Starting dual-master sync (${request.mode})`, {
        trigger: request.trigger,
        now: request.now,
      });
      try {
        if (adapters.length < 2) {
          const report: RunReport = {
            id: runId,
            status: "partial",
            operations: [],
            conflicts: [],
            unmetCapabilities: ["requires-two-adapters"],
            verifiedAt: null,
          };
          logScoped("DualRouter", "run", "warn", "Sync partial: fewer than 2 adapters available", {
            adapters: adapters.length,
          });
          repository.finishRun(report);
          return report;
        }

        // Apply pending operations if present and not in audit mode
        const pendingOutcomes = new Map<string, Outcome>();
        if (request.mode !== "audit") {
          const pendingOps = repository.pendingOperations();
          const currentBaselines = repository.listBaselines();
          for (const pop of pendingOps) {
            const target = adapters.find((a) => a.routerId === pop.routerId);
            if (!target) {
              pendingOutcomes.set(pop.id, "unsupported");
              continue;
            }
            try {
              const receipt = await target.apply(pop);
              repository.recordReceipt(receipt);
              pendingOutcomes.set(pop.id, receipt.outcome);
              if (receipt.outcome === "applied") {
                advanceBaseline(repository, currentBaselines, pop);
              }
            } catch (err) {
              const receipt: Receipt = {
                operationId: pop.id,
                outcome: "rejected",
                boundary: null,
                evidence: err instanceof Error ? err.message : String(err),
              };
              repository.recordReceipt(receipt);
              pendingOutcomes.set(pop.id, "rejected");
            }
          }
        }

        // Read states concurrently
        const settledSnapshots = await Promise.allSettled(adapters.map((a) => a.readState()));
        const hasRejected = settledSnapshots.some((s) => s.status === "rejected");
        if (hasRejected) {
          const report: RunReport = {
            id: runId,
            status: "partial",
            operations: [],
            conflicts: [],
            unmetCapabilities: ["router-unreachable-abort"],
            verifiedAt: null,
          };
          repository.finishRun(report);
          return report;
        }

        const snapshots = settledSnapshots.map(
          (s) => (s as PromiseFulfilledResult<Snapshot>).value,
        );
        const baselines = repository.listBaselines();

        // Plan merge
        const plan = planMerge({ a: snapshots[0], b: snapshots[1], baselines });

        // Record conflicts in repository
        for (const conflict of plan.conflicts) {
          repository.saveConflict(conflict);
        }

        // Audit mode: return report without mutations on remote adapters
        if (request.mode === "audit") {
          const status: RunStatus =
            plan.conflicts.length > 0
              ? "conflicted"
              : plan.incompleteScopes.length > 0
                ? "partial"
                : "verified";

          const report: RunReport = {
            id: runId,
            status,
            operations: plan.operations.map((op) => ({
              id: op.id,
              outcome: (isConflicted(op, plan.conflicts) ? "conflicted" : "unknown") as Outcome,
            })),
            conflicts: plan.conflicts,
            unmetCapabilities: plan.incompleteScopes.map((s) => `scope:${s}`),
            verifiedAt: null,
          };
          repository.finishRun(report);
          return report;
        }

        // Incremental or Full mode: apply safe operations
        const conflictedOpIds = new Set<string>();
        for (const op of plan.operations) {
          if (isConflicted(op, plan.conflicts)) {
            conflictedOpIds.add(op.id);
          }
        }

        // Propagate conflict to dependent operations
        let changed = true;
        while (changed) {
          changed = false;
          for (const op of plan.operations) {
            if (!conflictedOpIds.has(op.id) && op.dependsOn?.length) {
              if (op.dependsOn.some((depId) => conflictedOpIds.has(depId))) {
                conflictedOpIds.add(op.id);
                changed = true;
              }
            }
          }
        }

        const outcomeMap = new Map<string, Outcome>();
        const failedOpIds = new Set<string>();

        for (const op of plan.operations) {
          if (conflictedOpIds.has(op.id)) {
            outcomeMap.set(op.id, "conflicted");
            continue;
          }

          if (op.dependsOn?.some((depId) => failedOpIds.has(depId))) {
            failedOpIds.add(op.id);
            outcomeMap.set(op.id, "rejected");
            continue;
          }

          const target = adapters.find((a) => a.routerId === op.routerId);
          if (!target) {
            failedOpIds.add(op.id);
            outcomeMap.set(op.id, "unsupported");
            continue;
          }

          repository.enqueue(op);
          try {
            const receipt = await target.apply(op);
            repository.recordReceipt(receipt);
            outcomeMap.set(op.id, receipt.outcome);

            if (receipt.outcome === "applied") {
              advanceBaseline(repository, baselines, op);
            } else {
              failedOpIds.add(op.id);
            }
          } catch (err) {
            const receipt: Receipt = {
              operationId: op.id,
              outcome: "rejected",
              boundary: null,
              evidence: err instanceof Error ? err.message : String(err),
            };
            repository.recordReceipt(receipt);
            failedOpIds.add(op.id);
            outcomeMap.set(op.id, "rejected");
          }
        }

        const reportOps = plan.operations.map((op) => ({
          id: op.id,
          outcome: outcomeMap.get(op.id) ?? "unknown",
        }));

        let status: RunStatus;
        if (plan.conflicts.length > 0) {
          status = "conflicted";
        } else if (
          plan.incompleteScopes.length > 0 ||
          reportOps.some((op) => op.outcome !== "applied") ||
          Array.from(pendingOutcomes.values()).some((out) => out !== "applied")
        ) {
          status = "partial";
        } else {
          status = "verified";
        }

        const verifiedAt = status === "verified" ? request.now : null;

        const report: RunReport = {
          id: runId,
          status,
          operations: reportOps,
          conflicts: plan.conflicts,
          unmetCapabilities: plan.incompleteScopes.map((s) => `scope:${s}`),
          verifiedAt,
        };

        repository.finishRun(report);
        logScoped("DualRouter", "run", "success", `Sync finished with status=${status}`, {
          mode: request.mode,
          operations: reportOps.length,
          conflicts: plan.conflicts.length,
        });
        return report;
      } finally {
        repository.releaseLease("dual-master", leaseEpoch);
      }
    },

    async resolve(input: {
      id: string;
      revision: number;
      value: Value;
      actor: string;
    }): Promise<RunReport> {
      const success = repository.resolveConflict(input.id, input.revision, input.value);
      if (!success) {
        throw new Error(
          `Conflict resolution rejected: invalid or stale revision for conflict ${input.id}`,
        );
      }

      // Parse conflict ID to save baseline and enqueue resolution operations
      const parts = input.id.split(":");
      if (parts.length >= 4 && parts[0] === "conflict") {
        const resource = parts[1] as Resource;
        const key = parts[2];
        const field = parts[3] === "entity" ? null : parts[3];

        if (field !== null) {
          repository.saveBaseline({
            resource,
            key,
            field,
            value: input.value,
            deleted: input.value === null,
            revision: input.revision + 1,
          });

          for (const adapter of adapters) {
            repository.enqueue({
              id: `op:${adapter.routerId}:${resource}:${key}:${field}:resolve`,
              routerId: adapter.routerId,
              resource,
              key,
              field,
              kind: input.value === null ? "delete" : "update",
              expected: null,
              expectedRevision: null,
              desired: input.value,
              dependsOn: [],
            });
          }
        } else if (typeof input.value === "object" && input.value !== null) {
          for (const [f, val] of Object.entries(input.value as Record<string, Value>)) {
            repository.saveBaseline({
              resource,
              key,
              field: f,
              value: val,
              deleted: false,
              revision: input.revision + 1,
            });
          }
          for (const adapter of adapters) {
            repository.enqueue({
              id: `op:${adapter.routerId}:${resource}:${key}:create:resolve`,
              routerId: adapter.routerId,
              resource,
              key,
              field: null,
              kind: "create",
              expected: null,
              expectedRevision: null,
              desired: input.value,
              dependsOn: [],
            });
          }
        } else if (input.value === null) {
          const baselines = repository
            .listBaselines()
            .filter((b) => b.resource === resource && b.key === key);
          if (baselines.length > 0) {
            for (const b of baselines) {
              repository.saveBaseline({
                ...b,
                deleted: true,
                revision: b.revision + 1,
              });
            }
          } else {
            repository.saveBaseline({
              resource,
              key,
              field: "_deleted",
              value: null,
              deleted: true,
              revision: input.revision + 1,
            });
          }
          for (const adapter of adapters) {
            repository.enqueue({
              id: `op:${adapter.routerId}:${resource}:${key}:delete:resolve`,
              routerId: adapter.routerId,
              resource,
              key,
              field: null,
              kind: "delete",
              expected: null,
              expectedRevision: null,
              desired: null,
              dependsOn: [],
            });
          }
        }
      }

      return this.run({
        mode: "full",
        trigger: "change",
        now: Date.now(),
      });
    },

    async status(): Promise<RunReport | null> {
      return repository.lastVerifiedRun();
    },
  };
}
