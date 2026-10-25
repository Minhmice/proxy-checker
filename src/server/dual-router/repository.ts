import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { openSyncDb, type SyncDbClient } from "../../db/sync/client.js";
import * as schema from "../../db/sync/schema.js";
import type {
  Accuracy,
  Baseline,
  Conflict,
  Operation,
  Receipt,
  Resource,
  RunReport,
  SyncPolicy,
  SyncRepository,
  UsageEvent,
  UsageScope,
  UsageWrite,
  Value,
} from "./types.js";

export type { SyncRepository };

export function openSyncRepository(filePath: string): SyncRepository {
  const client: SyncDbClient = openSyncDb(filePath);

  return {
    appendUsage(event: UsageEvent): boolean {
      return client.raw.transaction(() => {
        const existing = client.db
          .select()
          .from(schema.usageEvents)
          .where(
            and(
              eq(schema.usageEvents.sourceRouterId, event.sourceRouterId),
              eq(schema.usageEvents.namespace, event.namespace),
              eq(schema.usageEvents.id, event.id),
            ),
          )
          .get();

        if (existing) {
          const isSame =
            existing.sourceRouterId === event.sourceRouterId &&
            existing.accountKey === event.scope.accountKey &&
            existing.provider === event.scope.provider &&
            existing.model === event.scope.model &&
            existing.metric === event.scope.metric &&
            existing.unit === event.scope.unit &&
            (existing.currency ?? null) === (event.scope.currency ?? null) &&
            existing.periodStart === event.scope.periodStart &&
            existing.periodEnd === event.scope.periodEnd &&
            existing.amount === event.amount &&
            existing.accuracy === event.accuracy &&
            existing.provenance === event.provenance &&
            existing.generation === event.generation &&
            existing.cursor === event.cursor &&
            existing.observedAt === event.observedAt;

          if (isSame) {
            return false;
          }

          if (event.observedAt > existing.observedAt) {
            client.db
              .update(schema.usageEvents)
              .set({
                accountKey: event.scope.accountKey,
                provider: event.scope.provider,
                model: event.scope.model,
                metric: event.scope.metric,
                unit: event.scope.unit,
                currency: event.scope.currency,
                periodStart: event.scope.periodStart,
                periodEnd: event.scope.periodEnd,
                amount: event.amount,
                accuracy: event.accuracy,
                provenance: event.provenance,
                generation: event.generation,
                cursor: event.cursor,
                observedAt: event.observedAt,
              })
              .where(
                and(
                  eq(schema.usageEvents.sourceRouterId, event.sourceRouterId),
                  eq(schema.usageEvents.namespace, event.namespace),
                  eq(schema.usageEvents.id, event.id),
                ),
              )
              .run();
            return true;
          }

          throw new Error(
            `Integrity conflict: usage event ${event.namespace}:${event.id} already exists with different payload`,
          );
        }

        client.db
          .insert(schema.usageEvents)
          .values({
            id: event.id,
            namespace: event.namespace,
            sourceRouterId: event.sourceRouterId,
            accountKey: event.scope.accountKey,
            provider: event.scope.provider,
            model: event.scope.model,
            metric: event.scope.metric,
            unit: event.scope.unit,
            currency: event.scope.currency,
            periodStart: event.scope.periodStart,
            periodEnd: event.scope.periodEnd,
            amount: event.amount,
            accuracy: event.accuracy,
            provenance: event.provenance,
            generation: event.generation,
            cursor: event.cursor,
            observedAt: event.observedAt,
          })
          .run();

        return true;
      })();
    },

    listUsage(scope: UsageScope): UsageEvent[] {
      const conditions = [
        eq(schema.usageEvents.accountKey, scope.accountKey),
        eq(schema.usageEvents.provider, scope.provider),
        eq(schema.usageEvents.model, scope.model),
        eq(schema.usageEvents.metric, scope.metric),
        eq(schema.usageEvents.unit, scope.unit),
        eq(schema.usageEvents.periodStart, scope.periodStart),
        eq(schema.usageEvents.periodEnd, scope.periodEnd),
      ];

      if (scope.currency !== null && scope.currency !== undefined) {
        conditions.push(eq(schema.usageEvents.currency, scope.currency));
      } else {
        conditions.push(isNull(schema.usageEvents.currency));
      }

      const rows = client.db
        .select()
        .from(schema.usageEvents)
        .where(and(...conditions))
        .orderBy(asc(schema.usageEvents.observedAt), asc(schema.usageEvents.id))
        .all();

      return rows.map((row) => ({
        id: row.id,
        namespace: row.namespace,
        sourceRouterId: row.sourceRouterId,
        scope: {
          accountKey: row.accountKey,
          provider: row.provider,
          model: row.model,
          metric: row.metric,
          unit: row.unit,
          currency: row.currency,
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
        },
        amount: row.amount,
        accuracy: row.accuracy as Accuracy,
        provenance: row.provenance as "native" | "replicated",
        generation: row.generation,
        cursor: row.cursor,
        observedAt: row.observedAt,
      }));
    },

    saveBaseline(baseline: Baseline): void {
      client.db
        .insert(schema.baselines)
        .values({
          resource: baseline.resource,
          key: baseline.key,
          field: baseline.field,
          value: JSON.stringify(baseline.value),
          deleted: baseline.deleted ? 1 : 0,
          revision: baseline.revision,
          updatedAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: [schema.baselines.resource, schema.baselines.key, schema.baselines.field],
          set: {
            value: JSON.stringify(baseline.value),
            deleted: baseline.deleted ? 1 : 0,
            revision: baseline.revision,
            updatedAt: Date.now(),
          },
        })
        .run();
    },

    listBaselines(): Baseline[] {
      const rows = client.db
        .select()
        .from(schema.baselines)
        .orderBy(
          asc(schema.baselines.resource),
          asc(schema.baselines.key),
          asc(schema.baselines.field),
        )
        .all();

      return rows.map((row) => ({
        resource: row.resource as Resource,
        key: row.key,
        field: row.field,
        value: JSON.parse(row.value) as Value,
        deleted: row.deleted === 1,
        revision: row.revision,
      }));
    },

    enqueue(operation: Operation): void {
      client.db
        .insert(schema.operations)
        .values({
          id: operation.id,
          routerId: operation.routerId,
          resource: operation.resource,
          key: operation.key,
          field: operation.field,
          kind: operation.kind,
          expected:
            operation.expected === null || operation.expected === undefined
              ? null
              : JSON.stringify(operation.expected),
          expectedRevision: operation.expectedRevision,
          desired:
            operation.desired === null || operation.desired === undefined
              ? null
              : JSON.stringify(operation.desired),
          dependsOn: JSON.stringify(operation.dependsOn ?? []),
          status: "pending",
          createdAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: schema.operations.id,
          set: {
            routerId: operation.routerId,
            resource: operation.resource,
            key: operation.key,
            field: operation.field,
            kind: operation.kind,
            expected:
              operation.expected === null || operation.expected === undefined
                ? null
                : JSON.stringify(operation.expected),
            expectedRevision: operation.expectedRevision,
            desired:
              operation.desired === null || operation.desired === undefined
                ? null
                : JSON.stringify(operation.desired),
            dependsOn: JSON.stringify(operation.dependsOn ?? []),
          },
        })
        .run();
    },

    pendingOperations(): Operation[] {
      const rows = client.db
        .select()
        .from(schema.operations)
        .where(eq(schema.operations.status, "pending"))
        .orderBy(asc(schema.operations.createdAt), asc(schema.operations.id))
        .all();

      return rows.map((row) => ({
        id: row.id,
        routerId: row.routerId,
        resource: row.resource as Resource,
        key: row.key,
        field: row.field,
        kind: row.kind as "create" | "update" | "delete",
        expected: row.expected ? (JSON.parse(row.expected) as Value) : null,
        expectedRevision: row.expectedRevision,
        desired: row.desired ? (JSON.parse(row.desired) as Value) : null,
        dependsOn: row.dependsOn ? (JSON.parse(row.dependsOn) as string[]) : [],
      }));
    },

    saveConflict(conflict: Conflict): void {
      client.db
        .insert(schema.conflicts)
        .values({
          id: conflict.id,
          resource: conflict.resource,
          key: conflict.key,
          field: conflict.field,
          revision: conflict.revision,
          reason: conflict.reason,
          base:
            conflict.base === null || conflict.base === undefined
              ? null
              : JSON.stringify(conflict.base),
          a: conflict.a === null || conflict.a === undefined ? null : JSON.stringify(conflict.a),
          b: conflict.b === null || conflict.b === undefined ? null : JSON.stringify(conflict.b),
          resolved: 0,
          resolvedValue: null,
          resolvedAt: null,
          createdAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: schema.conflicts.id,
          set: {
            resource: conflict.resource,
            key: conflict.key,
            field: conflict.field,
            revision: conflict.revision,
            reason: conflict.reason,
            base:
              conflict.base === null || conflict.base === undefined
                ? null
                : JSON.stringify(conflict.base),
            a: conflict.a === null || conflict.a === undefined ? null : JSON.stringify(conflict.a),
            b: conflict.b === null || conflict.b === undefined ? null : JSON.stringify(conflict.b),
          },
        })
        .run();
    },
    listConflicts(): Conflict[] {
      const rows = client.db
        .select()
        .from(schema.conflicts)
        .where(eq(schema.conflicts.resolved, 0))
        .all();

      return rows.map((row) => ({
        id: row.id,
        resource: row.resource as Resource,
        key: row.key,
        field: row.field,
        revision: row.revision,
        reason: row.reason as Conflict["reason"],
        base: row.base ? JSON.parse(row.base) : null,
        a: row.a ? JSON.parse(row.a) : null,
        b: row.b ? JSON.parse(row.b) : null,
      }));
    },

    resolveConflict(id: string, expectedRevision: number, value: Value): boolean {
      return client.raw.transaction(() => {
        const row = client.db
          .select()
          .from(schema.conflicts)
          .where(eq(schema.conflicts.id, id))
          .get();

        if (!row) return false;
        if (row.resolved === 1) return false;
        if (row.revision !== expectedRevision) return false;

        client.db
          .update(schema.conflicts)
          .set({
            resolved: 1,
            resolvedValue: JSON.stringify(value),
            resolvedAt: Date.now(),
            revision: row.revision + 1,
          })
          .where(
            and(
              eq(schema.conflicts.id, id),
              eq(schema.conflicts.revision, expectedRevision),
              eq(schema.conflicts.resolved, 0),
            ),
          )
          .run();

        return true;
      })();
    },

    prepareWrite(write: UsageWrite): void {
      client.db
        .insert(schema.usageWrites)
        .values({
          operationId: write.operationId,
          routerId: write.routerId,
          accountKey: write.scope.accountKey,
          provider: write.scope.provider,
          model: write.scope.model,
          metric: write.scope.metric,
          unit: write.scope.unit,
          currency: write.scope.currency,
          periodStart: write.scope.periodStart,
          periodEnd: write.scope.periodEnd,
          ledgerRevision: write.ledgerRevision,
          strategy: write.strategy,
          amount: write.amount,
          expectedBoundary: write.expectedBoundary,
          status: "prepared",
          createdAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: schema.usageWrites.operationId,
          set: {
            routerId: write.routerId,
            accountKey: write.scope.accountKey,
            provider: write.scope.provider,
            model: write.scope.model,
            metric: write.scope.metric,
            unit: write.scope.unit,
            currency: write.scope.currency,
            periodStart: write.scope.periodStart,
            periodEnd: write.scope.periodEnd,
            ledgerRevision: write.ledgerRevision,
            strategy: write.strategy,
            amount: write.amount,
            expectedBoundary: write.expectedBoundary,
          },
        })
        .run();
    },

    recordReceipt(receipt: Receipt): void {
      client.raw.transaction(() => {
        client.db
          .insert(schema.receipts)
          .values({
            operationId: receipt.operationId,
            outcome: receipt.outcome,
            boundary: receipt.boundary,
            evidence: receipt.evidence,
            createdAt: Date.now(),
          })
          .onConflictDoUpdate({
            target: schema.receipts.operationId,
            set: {
              outcome: receipt.outcome,
              boundary: receipt.boundary,
              evidence: receipt.evidence,
            },
          })
          .run();

        client.db
          .update(schema.operations)
          .set({ status: receipt.outcome })
          .where(eq(schema.operations.id, receipt.operationId))
          .run();

        client.db
          .update(schema.usageWrites)
          .set({ status: receipt.outcome })
          .where(eq(schema.usageWrites.operationId, receipt.operationId))
          .run();
      })();
    },

    acquireLease(owner: string, now: number, ttl: number): number | null {
      return client.raw.transaction(() => {
        const current = client.db
          .select()
          .from(schema.leases)
          .where(eq(schema.leases.name, "sync_master"))
          .get();

        if (!current) {
          client.db
            .insert(schema.leases)
            .values({
              name: "sync_master",
              owner,
              epoch: 1,
              expiresAt: now + ttl,
            })
            .run();
          return 1;
        }

        if (current.expiresAt <= now) {
          const nextEpoch = current.epoch + 1;
          client.db
            .update(schema.leases)
            .set({
              owner,
              epoch: nextEpoch,
              expiresAt: now + ttl,
            })
            .where(eq(schema.leases.name, "sync_master"))
            .run();
          return nextEpoch;
        }

        if (current.owner === owner) {
          client.db
            .update(schema.leases)
            .set({
              expiresAt: now + ttl,
            })
            .where(eq(schema.leases.name, "sync_master"))
            .run();
          return current.epoch;
        }

        return null;
      })();
    },

    renewLease(owner: string, epoch: number, now: number, ttl: number): boolean {
      return client.raw.transaction(() => {
        const current = client.db
          .select()
          .from(schema.leases)
          .where(eq(schema.leases.name, "sync_master"))
          .get();

        if (!current) return false;
        if (current.owner !== owner || current.epoch !== epoch || current.expiresAt <= now) {
          return false;
        }

        client.db
          .update(schema.leases)
          .set({
            expiresAt: now + ttl,
          })
          .where(
            and(
              eq(schema.leases.name, "sync_master"),
              eq(schema.leases.owner, owner),
              eq(schema.leases.epoch, epoch),
            ),
          )
          .run();

        return true;
      })();
    },

    releaseLease(owner: string, epoch: number): void {
      client.db
        .update(schema.leases)
        .set({ expiresAt: 0 })
        .where(
          and(
            eq(schema.leases.name, "sync_master"),
            eq(schema.leases.owner, owner),
            eq(schema.leases.epoch, epoch),
          ),
        )
        .run();
    },

    getPolicy(): SyncPolicy {
      const row = client.db
        .select()
        .from(schema.syncPolicy)
        .where(eq(schema.syncPolicy.id, "default"))
        .get();

      if (!row) {
        return {
          enabled: true,
          usageWriteBackAuthorized: false,
          nextIncrementalAt: 0,
          nextFullAt: 0,
        };
      }

      return {
        enabled: row.enabled === 1,
        usageWriteBackAuthorized: row.usageWriteBackAuthorized === 1,
        nextIncrementalAt: row.nextIncrementalAt,
        nextFullAt: row.nextFullAt,
      };
    },

    savePolicy(policy: SyncPolicy): void {
      client.db
        .insert(schema.syncPolicy)
        .values({
          id: "default",
          enabled: policy.enabled ? 1 : 0,
          usageWriteBackAuthorized: policy.usageWriteBackAuthorized ? 1 : 0,
          nextIncrementalAt: policy.nextIncrementalAt,
          nextFullAt: policy.nextFullAt,
          updatedAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: schema.syncPolicy.id,
          set: {
            enabled: policy.enabled ? 1 : 0,
            usageWriteBackAuthorized: policy.usageWriteBackAuthorized ? 1 : 0,
            nextIncrementalAt: policy.nextIncrementalAt,
            nextFullAt: policy.nextFullAt,
            updatedAt: Date.now(),
          },
        })
        .run();
    },

    finishRun(report: RunReport): void {
      client.db
        .insert(schema.runReports)
        .values({
          id: report.id,
          status: report.status,
          reportJson: JSON.stringify(report),
          verifiedAt: report.verifiedAt,
          createdAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: schema.runReports.id,
          set: {
            status: report.status,
            reportJson: JSON.stringify(report),
            verifiedAt: report.verifiedAt,
          },
        })
        .run();
    },

    lastVerifiedRun(): RunReport | null {
      const row = client.db
        .select()
        .from(schema.runReports)
        .where(
          and(eq(schema.runReports.status, "verified"), isNotNull(schema.runReports.verifiedAt)),
        )
        .orderBy(desc(schema.runReports.verifiedAt), desc(schema.runReports.createdAt))
        .limit(1)
        .get();

      if (!row) return null;
      return JSON.parse(row.reportJson) as RunReport;
    },

    close(): void {
      client.close();
    },
  };
}
