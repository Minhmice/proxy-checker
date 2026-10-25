import type {
  Capability,
  Entity,
  Operation,
  Receipt,
  Resource,
  RouterAdapter,
  ScopeSnapshot,
  Snapshot,
  UsageEvent,
  UsageWrite,
  Value,
} from "./types.js";
import { poolKey, accountKey } from "./identity.js";
import { isEqual } from "./merge.js";
import {
  createPool,
  deletePool,
  getAccountUsage,
  listAntigravityConnections,
  listPools,
  setPoolActive,
  updateConnection,
  updatePool,
  type NineRouterConnectionItem,
  type NineRouterPool,
  type NineRouterRequestOverrides,
} from "../nine-router-client.js";

export interface CreateRouterAdapterInput {
  routerId: string;
  url: string;
  password?: string;
  apiKey?: string;
}

export function createRouterAdapter(input: CreateRouterAdapterInput): RouterAdapter {
  const { routerId, url, password, apiKey } = input;
  const overrides: NineRouterRequestOverrides = { url, password, apiKey };
  const receiptCache = new Map<string, Receipt>();

  function makeReceipt(
    operationId: string,
    outcome: Receipt["outcome"],
    boundary: string | null = null,
    evidence: string | null = null,
  ): Receipt {
    const receipt: Receipt = { operationId, outcome, boundary, evidence };
    receiptCache.set(operationId, receipt);
    return receipt;
  }

  return {
    routerId,
    url,

    async capabilities(): Promise<Capability[]> {
      return [
        {
          resource: "pool",
          read: true,
          export: false,
          write: true,
          conditional: false,
          evidence: "GET/POST/PUT/DELETE /api/proxy-pools (unconditional, unpaginated)",
        },
        {
          resource: "account",
          read: true,
          export: false,
          write: true,
          conditional: false,
          evidence: "GET /api/providers/client?provider=antigravity, PUT /api/providers/:id",
        },
        {
          resource: "role",
          read: false,
          export: false,
          write: false,
          conditional: false,
          evidence: "Remote 9Router API does not expose role endpoints",
        },
        {
          resource: "settings",
          read: false,
          export: false,
          write: false,
          conditional: false,
          evidence: "Remote 9Router API does not expose settings endpoints",
        },
        {
          resource: "history",
          read: false,
          export: false,
          write: false,
          conditional: false,
          evidence: "Remote 9Router API does not expose history endpoints",
        },
        {
          resource: "usage",
          read: true,
          export: false,
          write: false,
          conditional: false,
          evidence: "GET /api/usage/:id supported; usage mutation write-back unsupported",
        },
      ];
    },

    async readState(): Promise<Snapshot> {
      const observedAt = Date.now();

      // Read pools
      let poolScope: ScopeSnapshot;
      try {
        const rawPools: NineRouterPool[] = await listPools(overrides);
        const entities: Entity[] = rawPools.map((p) => {
          const key = poolKey(p.proxyUrl);
          const fields: Record<string, Value> = {
            name: p.name,
            proxyUrl: p.proxyUrl,
            isActive: Boolean(p.isActive),
          };
          if (p.type !== undefined) fields.type = p.type;
          return {
            key,
            resource: "pool",
            localId: p.id,
            fields,
            revision: null,
          };
        });
        poolScope = {
          complete: true,
          entities,
          cursor: null,
          observedAt,
          error: null,
        };
      } catch (err) {
        poolScope = {
          complete: false,
          entities: [],
          cursor: null,
          observedAt,
          error: (err as Error).message,
        };
      }

      // Read accounts
      let accountScope: ScopeSnapshot;
      try {
        const rawAccounts: NineRouterConnectionItem[] = await listAntigravityConnections(overrides);
        const entities: Entity[] = [];
        let hasAmbiguity = false;
        let ambiguityError: string | null = null;

        for (const conn of rawAccounts) {
          const provider = conn.provider || "antigravity";
          const subject =
            typeof conn.providerSpecificData?.subject === "string"
              ? conn.providerSpecificData.subject
              : null;
          const email = conn.email ?? null;

          try {
            const key = accountKey(provider, subject, email);
            const fields: Record<string, Value> = {
              provider,
              isActive: Boolean(conn.isActive),
            };
            if (conn.name) fields.name = conn.name;
            if (conn.email) fields.email = conn.email;
            if (conn.providerSpecificData?.proxyPoolId !== undefined) {
              fields.proxyPoolId = conn.providerSpecificData.proxyPoolId as string | null;
            }
            entities.push({
              key,
              resource: "account",
              localId: conn.id,
              fields,
              revision: null,
            });
          } catch (keyErr) {
            hasAmbiguity = true;
            ambiguityError = (keyErr as Error).message;
          }
        }

        // Complete if <= 50 accounts read and no unresolvable identity
        const isComplete = !hasAmbiguity && rawAccounts.length < 50;
        accountScope = {
          complete: isComplete,
          entities,
          cursor: null,
          observedAt,
          error: ambiguityError,
        };
      } catch (err) {
        accountScope = {
          complete: false,
          entities: [],
          cursor: null,
          observedAt,
          error: (err as Error).message,
        };
      }

      const emptyScope = (): ScopeSnapshot => ({
        complete: true,
        entities: [],
        cursor: null,
        observedAt,
        error: null,
      });

      return {
        routerId,
        scopes: {
          pool: poolScope,
          account: accountScope,
          settings: emptyScope(),
          role: emptyScope(),
          history: emptyScope(),
        },
      };
    },

    async apply(operation: Operation): Promise<Receipt> {
      if (receiptCache.has(operation.id)) {
        return receiptCache.get(operation.id)!;
      }

      if (
        operation.resource === "role" ||
        operation.resource === "settings" ||
        operation.resource === "history"
      ) {
        return makeReceipt(
          operation.id,
          "unsupported",
          null,
          `Resource ${operation.resource} not supported on 9Router`,
        );
      }

      try {
        if (operation.resource === "pool") {
          const pools = await listPools(overrides);
          const currentPool = pools.find((p) => poolKey(p.proxyUrl) === operation.key);

          if (operation.kind === "create") {
            if (currentPool) {
              const matchesDesired =
                (!operation.field &&
                  isEqual(
                    { name: currentPool.name, isActive: currentPool.isActive } as Value,
                    operation.desired,
                  )) ||
                (operation.field === "name" && currentPool.name === operation.desired) ||
                (operation.field === "isActive" &&
                  Boolean(currentPool.isActive) === Boolean(operation.desired));
              if (matchesDesired) {
                return makeReceipt(
                  operation.id,
                  "applied",
                  currentPool.id,
                  "Pool already exists with desired state",
                );
              }
              return makeReceipt(
                operation.id,
                "conflicted",
                currentPool.id,
                "Pool already exists with divergent state",
              );
            }

            const desiredObj =
              typeof operation.desired === "object" && operation.desired !== null
                ? (operation.desired as Record<string, unknown>)
                : {};
            const proxyUrl = (desiredObj.proxyUrl as string) || operation.key;
            const name = (desiredObj.name as string) || "Imported Pool";
            const type = (desiredObj.type as string) || "http";

            const created = await createPool(
              {
                name,
                proxyUrl,
                type,
                isActive: false,
              },
              overrides,
            );

            if (desiredObj.isActive === true) {
              await setPoolActive(created.id, true, overrides);
            }
            return makeReceipt(operation.id, "applied", created.id);
          }

          if (operation.kind === "update") {
            if (!currentPool) {
              return makeReceipt(operation.id, "conflicted", null, "Pool not found for update");
            }

            // Expected value check
            if (operation.expected !== undefined && operation.expected !== null) {
              const currentVal = operation.field
                ? ((currentPool as unknown as Record<string, unknown>)[operation.field] as Value)
                : ({
                    name: currentPool.name,
                    isActive: currentPool.isActive,
                  } as Value);
              if (!isEqual(currentVal as Value, operation.expected)) {
                return makeReceipt(
                  operation.id,
                  "conflicted",
                  currentPool.id,
                  `Expected value mismatch on ${operation.field ?? "entity"}`,
                );
              }
            }

            const patch: { name?: string; isActive?: boolean } = {};
            if (operation.field === "name") {
              patch.name = String(operation.desired);
            } else if (operation.field === "isActive") {
              patch.isActive = Boolean(operation.desired);
            } else if (typeof operation.desired === "object" && operation.desired !== null) {
              const des = operation.desired as Record<string, unknown>;
              if (des.name !== undefined) patch.name = String(des.name);
              if (des.isActive !== undefined) patch.isActive = Boolean(des.isActive);
            }

            await updatePool(currentPool.id, patch, overrides);
            return makeReceipt(operation.id, "applied", currentPool.id);
          }

          if (operation.kind === "delete") {
            if (!currentPool) {
              return makeReceipt(operation.id, "applied", null, "Pool already absent");
            }
            if (operation.expected !== undefined && operation.expected !== null) {
              const currentVal = operation.field
                ? ((currentPool as unknown as Record<string, unknown>)[operation.field] as Value)
                : ({
                    name: currentPool.name,
                    isActive: currentPool.isActive,
                  } as Value);
              if (!isEqual(currentVal as Value, operation.expected)) {
                return makeReceipt(
                  operation.id,
                  "conflicted",
                  currentPool.id,
                  "Expected value mismatch prior to delete",
                );
              }
            }
            await deletePool(currentPool.id, overrides);
            return makeReceipt(operation.id, "applied", currentPool.id);
          }
        }

        if (operation.resource === "account") {
          if (operation.kind !== "update") {
            return makeReceipt(
              operation.id,
              "unsupported",
              null,
              `Account ${operation.kind} is unsupported via 9Router API`,
            );
          }

          const conns = await listAntigravityConnections(overrides);
          const currentConn = conns.find((c) => {
            const provider = c.provider || "antigravity";
            const subject =
              typeof c.providerSpecificData?.subject === "string"
                ? c.providerSpecificData.subject
                : null;
            try {
              return accountKey(provider, subject, c.email ?? null) === operation.key;
            } catch {
              return false;
            }
          });

          if (!currentConn) {
            return makeReceipt(operation.id, "conflicted", null, "Account connection not found");
          }

          // Check expected value
          if (operation.expected !== undefined && operation.expected !== null) {
            const currentVal =
              operation.field === "isActive"
                ? Boolean(currentConn.isActive)
                : operation.field === "proxyPoolId"
                  ? (currentConn.providerSpecificData?.proxyPoolId ?? null)
                  : {
                      isActive: Boolean(currentConn.isActive),
                      proxyPoolId: currentConn.providerSpecificData?.proxyPoolId ?? null,
                    };
            if (!isEqual(currentVal as Value, operation.expected)) {
              return makeReceipt(
                operation.id,
                "conflicted",
                currentConn.id,
                `Expected value mismatch on ${operation.field ?? "entity"}`,
              );
            }
          }

          const currentPsData = (currentConn.providerSpecificData ?? {}) as Record<string, unknown>;
          const patch: { isActive?: boolean; providerSpecificData?: Record<string, unknown> } = {};

          if (operation.field === "isActive") {
            patch.isActive = Boolean(operation.desired);
          } else if (operation.field === "proxyPoolId") {
            patch.providerSpecificData = {
              ...currentPsData,
              proxyPoolId: operation.desired as string | undefined,
            };
          } else if (typeof operation.desired === "object" && operation.desired !== null) {
            const des = operation.desired as Record<string, unknown>;
            if (des.isActive !== undefined) patch.isActive = Boolean(des.isActive);
            if (des.proxyPoolId !== undefined) {
              patch.providerSpecificData = {
                ...currentPsData,
                proxyPoolId: des.proxyPoolId,
              };
            }
          } else {
            return makeReceipt(
              operation.id,
              "unsupported",
              currentConn.id,
              `Field ${operation.field} update unsupported`,
            );
          }

          await updateConnection(currentConn.id, patch, overrides);
          return makeReceipt(operation.id, "applied", currentConn.id);
        }

        return makeReceipt(
          operation.id,
          "unsupported",
          null,
          `Unknown resource ${operation.resource}`,
        );
      } catch (err) {
        const error = err as Error & { status?: number };
        if (error.status === 409) {
          return makeReceipt(operation.id, "conflicted", null, error.message);
        }
        if (error.status === 400 || error.status === 422) {
          return makeReceipt(operation.id, "rejected", null, error.message);
        }
        return makeReceipt(operation.id, "unknown", null, error.message);
      }
    },

    async readUsage(): Promise<UsageEvent[]> {
      const observedAt = Date.now();
      const events: UsageEvent[] = [];

      try {
        const conns = await listAntigravityConnections(overrides);
        for (const conn of conns) {
          const provider = conn.provider || "antigravity";
          const subject =
            typeof conn.providerSpecificData?.subject === "string"
              ? conn.providerSpecificData.subject
              : null;
          let accKey: string;
          try {
            accKey = accountKey(provider, subject, conn.email ?? null);
          } catch {
            continue;
          }

          try {
            const usageData = await getAccountUsage(conn.id, overrides);
            const quotas = (usageData.quotas ?? {}) as Record<
              string,
              { remainingPercentage?: number; used?: number; total?: number; resetAt?: string }
            >;

            for (const [metric, quota] of Object.entries(quotas)) {
              const amount =
                quota.remainingPercentage !== undefined
                  ? String(quota.remainingPercentage)
                  : quota.used !== undefined
                    ? String(quota.used)
                    : "0";
              const generation = quota.resetAt ?? "global";
              const eventId = `usage:${routerId}:${accKey}:${metric}:${generation}`;

              events.push({
                id: eventId,
                namespace: "antigravity",
                sourceRouterId: routerId,
                scope: {
                  accountKey: accKey,
                  provider,
                  model: "all",
                  metric,
                  unit: "percentage",
                  currency: null,
                  periodStart: "",
                  periodEnd: quota.resetAt ?? "",
                },
                amount,
                accuracy: "exact",
                provenance: "native",
                generation,
                cursor: generation,
                observedAt,
              });
            }
          } catch {
            // Ignore single account usage failure
          }
        }
      } catch {
        // Return empty events on failure
      }

      return events;
    },

    async writeUsage(write: UsageWrite): Promise<Receipt> {
      // 9Router remote usage mutation is unsupported
      return makeReceipt(
        write.operationId,
        "unsupported",
        null,
        "Remote 9Router API does not support usage write-back",
      );
    },

    async readReceipt(operationId: string): Promise<Receipt | null> {
      return receiptCache.get(operationId) ?? null;
    },
  };
}
