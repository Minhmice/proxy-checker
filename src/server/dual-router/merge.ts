import type {
  Baseline,
  Conflict,
  Entity,
  MergePlan,
  Operation,
  Resource,
  Snapshot,
  Value,
} from "./types.js";

const KNOWN_RESOURCES: Resource[] = ["pool", "account", "settings", "role", "history"];

/**
 * Deep equality for dual-router Value types.
 */
export function isEqual(a: Value | undefined, b: Value | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return a === b;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object" || typeof b !== "object") return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.hasOwn(b, k)) return false;
    if (!isEqual(a[k], b[k])) return false;
  }
  return true;
}

/**
 * Categorize conflict reason according to safety & domain rules:
 * - credential fields -> "credential"
 * - account activation & account-proxy binding fields -> "ownership"
 * - otherwise "divergent"
 */
export function categorizeConflictReason(
  resource: Resource,
  field: string | null,
): "divergent" | "ownership" | "credential" {
  if (!field) return "divergent";

  // Credential sensitivity
  if (
    /(?:token|secret|password|credential|apiKey|api_key|refreshToken|refresh_token)/i.test(field)
  ) {
    return "credential";
  }

  // Account activation and account-to-proxy binding
  if (
    resource === "account" &&
    /(?:active|isActive|enabled|status|proxy|proxyId|proxyKey|assignedProxy|binding|owner|ownership)/i.test(
      field,
    )
  ) {
    return "ownership";
  }

  // Any resource proxy binding or ownership field
  if (/(?:proxy|proxyId|proxyKey|assignedProxy|binding)/i.test(field)) {
    return "ownership";
  }

  return "divergent";
}

function makeOperationId(
  routerId: string,
  resource: Resource,
  key: string,
  field: string | null,
  kind: "create" | "update" | "delete",
): string {
  return `op:${routerId}:${resource}:${key}:${field ?? kind}`;
}

function makeConflictId(resource: Resource, key: string, field: string | null): string {
  return `conflict:${resource}:${key}:${field ?? "entity"}`;
}

function shouldAllowRecreate(
  key: string,
  allowRecreate?: boolean | string[] | Set<string>,
): boolean {
  if (!allowRecreate) return false;
  if (allowRecreate === true) return true;
  if (Array.isArray(allowRecreate)) return allowRecreate.includes(key);
  if (allowRecreate instanceof Set) return allowRecreate.has(key);
  return false;
}
/**
 * Pure Three-Way Merge Engine for Dual 9Router Synchronization.
 */
export function planMerge(input: {
  a: Snapshot;
  b: Snapshot;
  baselines: Baseline[];
  allowRecreate?: boolean | string[] | Set<string>;
}): MergePlan {
  const { a, b, baselines, allowRecreate } = input;
  const operations: Operation[] = [];
  const conflicts: Conflict[] = [];
  const incompleteScopes: Resource[] = [];

  // Index baselines by `${resource}:${key}`
  const baselinesByEntity = new Map<string, Baseline[]>();
  for (const bl of baselines) {
    const k = `${bl.resource}:${bl.key}`;
    const list = baselinesByEntity.get(k);
    if (list) {
      list.push(bl);
    } else {
      baselinesByEntity.set(k, [bl]);
    }
  }

  // Discover all distinct resources across snapshots and baselines
  const allResources = new Set<Resource>(KNOWN_RESOURCES);
  if (a.scopes) {
    for (const r of Object.keys(a.scopes) as Resource[]) allResources.add(r);
  }
  if (b.scopes) {
    for (const r of Object.keys(b.scopes) as Resource[]) allResources.add(r);
  }

  for (const resource of allResources) {
    const scopeA = a.scopes?.[resource];
    const scopeB = b.scopes?.[resource];

    const completeA = Boolean(scopeA && scopeA.complete === true);
    const completeB = Boolean(scopeB && scopeB.complete === true);
    const isResourceComplete = completeA && completeB;

    if (!completeA || !completeB) {
      incompleteScopes.push(resource);
    }

    const entitiesA = scopeA?.entities ?? [];
    const entitiesB = scopeB?.entities ?? [];

    const mapA = new Map<string, Entity>();
    for (const e of entitiesA) mapA.set(e.key, e);

    const mapB = new Map<string, Entity>();
    for (const e of entitiesB) mapB.set(e.key, e);

    // Check for ambiguous identity: distinct keys with identical localId
    const seenLocalIdsA = new Map<string, string>();
    for (const e of entitiesA) {
      if (e.localId) seenLocalIdsA.set(e.localId, e.key);
    }
    for (const eB of entitiesB) {
      if (eB.localId && seenLocalIdsA.has(eB.localId)) {
        const keyA = seenLocalIdsA.get(eB.localId)!;
        if (keyA !== eB.key) {
          conflicts.push({
            id: `conflict:${resource}:${keyA}:${eB.key}:identity`,
            resource,
            key: keyA,
            field: null,
            revision: 0,
            reason: "identity",
            base: null,
            a: mapA.get(keyA)?.fields ?? null,
            b: eB.fields,
          });
        }
      }
    }

    // Collect all entity keys for this resource
    const allKeys = new Set<string>();
    for (const k of mapA.keys()) allKeys.add(k);
    for (const k of mapB.keys()) allKeys.add(k);
    for (const bl of baselines) {
      if (bl.resource === resource) allKeys.add(bl.key);
    }

    for (const key of allKeys) {
      const entityA = mapA.get(key);
      const entityB = mapB.get(key);
      const baseKey = `${resource}:${key}`;
      const entityBaselines = baselinesByEntity.get(baseKey) ?? [];
      const activeBaselines = entityBaselines.filter((bl) => !bl.deleted);
      const isBaseDeleted = entityBaselines.length > 0 && activeBaselines.length === 0;

      // Map baseline fields
      const baseFieldMap = new Map<string, Baseline>();
      for (const bl of activeBaselines) {
        baseFieldMap.set(bl.field, bl);
      }

      const entityBaselineRevision =
        activeBaselines.length > 0 ? Math.max(...activeBaselines.map((bl) => bl.revision)) : 0;

      // -------------------------------------------------------------
      // Case 1: Entity exists in BOTH snapshots
      // -------------------------------------------------------------
      if (entityA && entityB) {
        const allFields = new Set<string>();
        for (const f of Object.keys(entityA.fields)) allFields.add(f);
        for (const f of Object.keys(entityB.fields)) allFields.add(f);
        for (const f of baseFieldMap.keys()) allFields.add(f);

        for (const field of allFields) {
          const valA = entityA.fields[field];
          const valB = entityB.fields[field];
          const baseObj = baseFieldMap.get(field);
          const hasFieldBaseline = baseObj !== undefined;
          const valBase = baseObj ? baseObj.value : undefined;
          const fieldRevision = baseObj ? baseObj.revision : entityBaselineRevision;

          if (valA !== undefined && valB !== undefined) {
            if (isEqual(valA, valB)) {
              // Converged: A == B. Record baseline acknowledgment, no op needed.
              continue;
            }

            if (!hasFieldBaseline) {
              // Missing baseline: disagreeing shared fields conflict
              conflicts.push({
                id: makeConflictId(resource, key, field),
                resource,
                key,
                field,
                revision: 0,
                reason: categorizeConflictReason(resource, field),
                base: null,
                a: valA,
                b: valB,
              });
              continue;
            }

            // Three-way comparison against verified baseline
            const aEqBase = isEqual(valA, valBase);
            const bEqBase = isEqual(valB, valBase);

            if (aEqBase && !bEqBase) {
              // Apply B to A
              operations.push({
                id: makeOperationId(a.routerId, resource, key, field, "update"),
                routerId: a.routerId,
                resource,
                key,
                field,
                kind: "update",
                expected: valA,
                expectedRevision: entityA.revision,
                desired: valB,
                dependsOn: [],
              });
            } else if (!aEqBase && bEqBase) {
              // Apply A to B
              operations.push({
                id: makeOperationId(b.routerId, resource, key, field, "update"),
                routerId: b.routerId,
                resource,
                key,
                field,
                kind: "update",
                expected: valB,
                expectedRevision: entityB.revision,
                desired: valA,
                dependsOn: [],
              });
            } else {
              // Both modified away from base with divergent values
              conflicts.push({
                id: makeConflictId(resource, key, field),
                resource,
                key,
                field,
                revision: fieldRevision,
                reason: categorizeConflictReason(resource, field),
                base: valBase ?? null,
                a: valA,
                b: valB,
              });
            }
          } else if (valA !== undefined && valB === undefined) {
            // Present in A, absent in B
            if (!hasFieldBaseline) {
              // Missing baseline: identifiable addition on A -> apply to B
              operations.push({
                id: makeOperationId(b.routerId, resource, key, field, "update"),
                routerId: b.routerId,
                resource,
                key,
                field,
                kind: "update",
                expected: null,
                expectedRevision: entityB.revision,
                desired: valA,
                dependsOn: [],
              });
            } else {
              // B removed or omitted field present in baseline
              if (completeB && completeA) {
                if (isEqual(valA, valBase)) {
                  // A unmodified: B's removal applies to A
                  operations.push({
                    id: makeOperationId(a.routerId, resource, key, field, "update"),
                    routerId: a.routerId,
                    resource,
                    key,
                    field,
                    kind: "update",
                    expected: valA,
                    expectedRevision: entityA.revision,
                    desired: null,
                    dependsOn: [],
                  });
                } else {
                  // Delete on B vs edit on A
                  conflicts.push({
                    id: makeConflictId(resource, key, field),
                    resource,
                    key,
                    field,
                    revision: fieldRevision,
                    reason: "delete-edit",
                    base: valBase ?? null,
                    a: valA,
                    b: null,
                  });
                }
              }
              // If B scope incomplete, infer no deletion
            }
          } else if (valA === undefined && valB !== undefined) {
            // Present in B, absent in A
            if (!hasFieldBaseline) {
              // Missing baseline: identifiable addition on B -> apply to A
              operations.push({
                id: makeOperationId(a.routerId, resource, key, field, "update"),
                routerId: a.routerId,
                resource,
                key,
                field,
                kind: "update",
                expected: null,
                expectedRevision: entityA.revision,
                desired: valB,
                dependsOn: [],
              });
            } else {
              // A removed or omitted field present in baseline
              if (completeA && completeB) {
                if (isEqual(valB, valBase)) {
                  // B unmodified: A's removal applies to B
                  operations.push({
                    id: makeOperationId(b.routerId, resource, key, field, "update"),
                    routerId: b.routerId,
                    resource,
                    key,
                    field,
                    kind: "update",
                    expected: valB,
                    expectedRevision: entityB.revision,
                    desired: null,
                    dependsOn: [],
                  });
                } else {
                  // Delete on A vs edit on B
                  conflicts.push({
                    id: makeConflictId(resource, key, field),
                    resource,
                    key,
                    field,
                    revision: fieldRevision,
                    reason: "delete-edit",
                    base: valBase ?? null,
                    a: null,
                    b: valB,
                  });
                }
              }
              // If A scope incomplete, infer no deletion
            }
          }
        }
        continue;
      }

      // -------------------------------------------------------------
      // Case 2: Entity exists in A, NOT in B
      // -------------------------------------------------------------
      if (entityA && !entityB) {
        if (activeBaselines.length === 0) {
          if (isBaseDeleted) {
            const hasFieldConflict = entityBaselines.some(
              (bl) => bl.field in entityA.fields && !isEqual(entityA.fields[bl.field], bl.value),
            );
            const allow = shouldAllowRecreate(key, allowRecreate);

            if (hasFieldConflict && !allow) {
              // Previously deleted tombstone, but resurrected / held on A
              const baseObj = Object.fromEntries(entityBaselines.map((bl) => [bl.field, bl.value]));
              conflicts.push({
                id: makeConflictId(resource, key, null),
                resource,
                key,
                field: null,
                revision: Math.max(...entityBaselines.map((bl) => bl.revision), 0),
                reason: "delete-edit",
                base: baseObj,
                a: entityA.fields,
                b: null,
              });
            } else {
              if (!completeB) {
                continue;
              }
              operations.push({
                id: makeOperationId(b.routerId, resource, key, null, "create"),
                routerId: b.routerId,
                resource,
                key,
                field: null,
                kind: "create",
                expected: null,
                expectedRevision: null,
                desired: entityA.fields,
                dependsOn: [],
              });
            }
          } else {
            // Missing baseline: identifiable addition on A -> create on B
            // Only if B scope didn't fail completely
            if (!completeB) {
              continue;
            }
            operations.push({
              id: makeOperationId(b.routerId, resource, key, null, "create"),
              routerId: b.routerId,
              resource,
              key,
              field: null,
              kind: "create",
              expected: null,
              expectedRevision: null,
              desired: entityA.fields,
              dependsOn: [],
            });
          }
          continue;
        }

        // Entity was in active baseline. B does not have it.
        // Incomplete scope safety: infer NO deletion or destructive operation
        if (!completeB || !completeA) {
          continue;
        }

        // B has a complete scope and entity is missing: deletion candidate on B.
        // Check if A edited entity since baseline
        let aEdited = false;
        for (const bl of activeBaselines) {
          if (!isEqual(entityA.fields[bl.field], bl.value)) {
            aEdited = true;
            break;
          }
        }
        if (!aEdited) {
          for (const f of Object.keys(entityA.fields)) {
            if (!baseFieldMap.has(f)) {
              aEdited = true;
              break;
            }
          }
        }

        if (!aEdited) {
          // Clean deletion on B: apply deletion to A
          operations.push({
            id: makeOperationId(a.routerId, resource, key, null, "delete"),
            routerId: a.routerId,
            resource,
            key,
            field: null,
            kind: "delete",
            expected: entityA.fields,
            expectedRevision: entityA.revision,
            desired: null,
            dependsOn: [],
          });
        } else {
          // Deletion on B + edit on A: delete-edit conflict
          const baseObj = Object.fromEntries(activeBaselines.map((bl) => [bl.field, bl.value]));
          conflicts.push({
            id: makeConflictId(resource, key, null),
            resource,
            key,
            field: null,
            revision: entityBaselineRevision,
            reason: "delete-edit",
            base: baseObj,
            a: entityA.fields,
            b: null,
          });
        }
        continue;
      }

      // -------------------------------------------------------------
      // Case 3: Entity exists in B, NOT in A
      // -------------------------------------------------------------
      if (!entityA && entityB) {
        if (activeBaselines.length === 0) {
          if (isBaseDeleted) {
            const hasFieldConflict = entityBaselines.some(
              (bl) => bl.field in entityB.fields && !isEqual(entityB.fields[bl.field], bl.value),
            );
            const allow = shouldAllowRecreate(key, allowRecreate);

            if (hasFieldConflict && !allow) {
              // Tombstone resurrect conflict on B
              const baseObj = Object.fromEntries(entityBaselines.map((bl) => [bl.field, bl.value]));
              conflicts.push({
                id: makeConflictId(resource, key, null),
                resource,
                key,
                field: null,
                revision: Math.max(...entityBaselines.map((bl) => bl.revision), 0),
                reason: "delete-edit",
                base: baseObj,
                a: null,
                b: entityB.fields,
              });
            } else {
              if (!completeA) {
                continue;
              }
              operations.push({
                id: makeOperationId(a.routerId, resource, key, null, "create"),
                routerId: a.routerId,
                resource,
                key,
                field: null,
                kind: "create",
                expected: null,
                expectedRevision: null,
                desired: entityB.fields,
                dependsOn: [],
              });
            }
          } else {
            // Missing baseline: identifiable addition on B -> create on A
            if (!completeA) {
              continue;
            }
            operations.push({
              id: makeOperationId(a.routerId, resource, key, null, "create"),
              routerId: a.routerId,
              resource,
              key,
              field: null,
              kind: "create",
              expected: null,
              expectedRevision: null,
              desired: entityB.fields,
              dependsOn: [],
            });
          }
          continue;
        }

        // Entity was in active baseline. A does not have it.
        // Incomplete scope safety: infer NO deletion or destructive operation
        if (!completeA || !completeB) {
          continue;
        }

        // A has complete scope and entity is missing: deletion candidate on A.
        let bEdited = false;
        for (const bl of activeBaselines) {
          if (!isEqual(entityB.fields[bl.field], bl.value)) {
            bEdited = true;
            break;
          }
        }
        if (!bEdited) {
          for (const f of Object.keys(entityB.fields)) {
            if (!baseFieldMap.has(f)) {
              bEdited = true;
              break;
            }
          }
        }

        if (!bEdited) {
          // Clean deletion on A: apply deletion to B
          operations.push({
            id: makeOperationId(b.routerId, resource, key, null, "delete"),
            routerId: b.routerId,
            resource,
            key,
            field: null,
            kind: "delete",
            expected: entityB.fields,
            expectedRevision: entityB.revision,
            desired: null,
            dependsOn: [],
          });
        } else {
          // Deletion on A + edit on B: delete-edit conflict
          const baseObj = Object.fromEntries(activeBaselines.map((bl) => [bl.field, bl.value]));
          conflicts.push({
            id: makeConflictId(resource, key, null),
            resource,
            key,
            field: null,
            revision: entityBaselineRevision,
            reason: "delete-edit",
            base: baseObj,
            a: null,
            b: entityB.fields,
          });
        }
      }

      // -------------------------------------------------------------
      // Case 4: Entity missing in BOTH A and B
      // -------------------------------------------------------------
      // Both routers have converged on deletion. No operation required.
    }
  }

  // -----------------------------------------------------------------
  // Coupled Dependencies for Activation and Ownership
  // Rule: Deactivate old owner, verify inactive, then activate new owner.
  // Activation operations depend on deactivation operations.
  // -----------------------------------------------------------------
  const deactivations = operations.filter((op) => {
    if (op.resource !== "account") return false;
    const isActField = op.field === "active" || op.field === "isActive" || op.field === "enabled";
    const isProxyField =
      op.field === "proxy" ||
      op.field === "proxyId" ||
      op.field === "proxyKey" ||
      op.field === "proxyPoolId" ||
      op.field === "assignedProxy";
    if (isActField && (op.desired === false || op.desired === 0 || op.desired === null)) {
      return true;
    }
    if (isProxyField && op.desired === null) {
      return true;
    }
    return false;
  });

  if (deactivations.length > 0) {
    const deactIds = deactivations.map((d) => d.id).sort();
    for (const op of operations) {
      if (op.resource !== "account") continue;
      const isActField = op.field === "active" || op.field === "isActive" || op.field === "enabled";
      const isProxyField =
        op.field === "proxy" ||
        op.field === "proxyId" ||
        op.field === "proxyKey" ||
        op.field === "proxyPoolId" ||
        op.field === "assignedProxy";
      const isActivation = isActField && op.desired === true;
      const isProxyBinding = isProxyField && op.desired !== null;

      if (isActivation || isProxyBinding) {
        const relevantDeact = deactIds.filter((id) => id !== op.id);
        if (relevantDeact.length > 0) {
          op.dependsOn = Array.from(new Set([...op.dependsOn, ...relevantDeact])).sort();
        }
      }
    }
  }

  return {
    operations,
    conflicts,
    incompleteScopes: Array.from(new Set(incompleteScopes)),
  };
}
