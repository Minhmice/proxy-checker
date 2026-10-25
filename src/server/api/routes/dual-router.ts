import { Hono } from "hono";
import type { ApiDependencies, ApiEnv } from "../types.js";
import { createUsageService } from "../../dual-router/usage.js";
import type {
  Capability,
  Conflict,
  RunStatus,
  UsageWrite,
  Value,
} from "../../dual-router/types.js";
const REDACTED = "***REDACTED***";

const SENSITIVE_FIELDS: Record<string, true> = {
  apiKey: true,
  password: true,
  token: true,
  secret: true,
  privateKey: true,
  wireguard_private_key: true,
  refreshToken: true,
};

function isSensitiveField(field: string | null | undefined): boolean {
  if (!field) return false;
  if (SENSITIVE_FIELDS[field]) return true;
  const lower = field.toLowerCase();
  return (
    lower === "apikey" ||
    lower === "password" ||
    lower === "token" ||
    lower === "secret" ||
    lower === "privatekey" ||
    lower === "wireguard_private_key" ||
    lower === "refreshtoken" ||
    lower.includes("secret") ||
    lower.includes("password") ||
    lower.includes("apikey") ||
    lower.includes("privatekey") ||
    lower.includes("private_key") ||
    lower.includes("refreshtoken") ||
    lower.includes("refresh_token")
  );
}

function redactValue(value: Value, isSensitive: boolean): Value {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return isSensitive ? REDACTED : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, isSensitive));
  }
  if (typeof value === "object") {
    const redactedObj: Record<string, Value> = {};
    for (const [k, v] of Object.entries(value)) {
      const childIsSensitive = isSensitive || isSensitiveField(k);
      redactedObj[k] = redactValue(v, childIsSensitive);
    }
    return redactedObj;
  }
  return value;
}

export function redactConflict(conflict: Conflict): Conflict {
  const isCredential =
    conflict.reason === "credential" ||
    isSensitiveField(conflict.field) ||
    isSensitiveField(conflict.key) ||
    isSensitiveField(conflict.key?.split(".").pop());

  return {
    ...conflict,
    base: redactValue(conflict.base, isCredential),
    a: redactValue(conflict.a, isCredential),
    b: redactValue(conflict.b, isCredential),
  };
}

export function createDualRouterRoutes(deps: ApiDependencies): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  // GET /status: returns status, capabilities, last verified run, and policy
  router.get("/status", async (c) => {
    if (!deps.dualRouterCoordinator || !deps.dualRouterRepo) {
      return c.json({
        ok: true,
        status: "unconfigured" as RunStatus,
        capabilities: {},
        lastVerifiedRun: null,
        policy: {
          enabled: false,
          usageWriteBackAuthorized: false,
          nextIncrementalAt: 0,
          nextFullAt: 0,
        },
        activeConflictsCount: 0,
        conflicts: [],
        routers: [],
      });
    }

    const lastVerifiedRun = deps.dualRouterRepo.lastVerifiedRun();
    const policy = deps.dualRouterRepo.getPolicy();
    const rawConflicts = deps.dualRouterRepo.listConflicts();
    const conflicts = rawConflicts.map(redactConflict);
    const coordStatus = await deps.dualRouterCoordinator.status().catch(() => null);

    const capabilities: Record<string, Capability[]> = {};
    const routers = await Promise.all(
      (deps.dualRouterAdapters ?? []).map(async (adapter) => {
        const start = Date.now();
        try {
          const caps = await adapter.capabilities();
          capabilities[adapter.routerId] = caps;
          const snapshot = await adapter.readState();
          const latencyMs = Date.now() - start;

          const poolEntities = snapshot.scopes.pool?.entities ?? [];
          const activePools = poolEntities.filter(
            (e) => (e.fields as Record<string, unknown>).active !== false,
          ).length;
          const totalPools = poolEntities.length;

          const accountEntities = snapshot.scopes.account?.entities ?? [];
          const activeAccounts = accountEntities.filter(
            (e) => (e.fields as Record<string, unknown>).active !== false,
          ).length;

          return {
            id: adapter.routerId,
            url: adapter.url,
            reachable: true,
            latencyMs,
            activePools,
            totalPools,
            activeAccounts,
            error: null,
          };
        } catch (err) {
          return {
            id: adapter.routerId,
            url: adapter.url,
            reachable: false,
            latencyMs: Date.now() - start,
            activePools: null,
            totalPools: null,
            activeAccounts: null,
            error: (err as Error).message,
          };
        }
      }),
    );

    let status: RunStatus | "idle" | "unconfigured" = "idle";
    if (conflicts.length > 0) {
      status = "conflicted";
    } else if (!deps.dualRouterAdapters || deps.dualRouterAdapters.length < 2) {
      status = "unconfigured";
    } else if (coordStatus) {
      status = coordStatus.status;
    } else if (lastVerifiedRun) {
      status = lastVerifiedRun.status;
    }

    return c.json({
      ok: true,
      status,
      capabilities,
      lastVerifiedRun,
      policy,
      activeConflictsCount: conflicts.length,
      conflicts,
      routers,
    });
  });

  // GET /conflicts: returns unresolved conflicts
  router.get("/conflicts", (c) => {
    const rawConflicts: Conflict[] = deps.dualRouterRepo ? deps.dualRouterRepo.listConflicts() : [];
    const conflicts = rawConflicts.map(redactConflict);
    return c.json({
      ok: true,
      conflicts,
      total: conflicts.length,
    });
  });
  // POST /audit: runs coordinator audit mode (read-only)
  router.post("/audit", async (c) => {
    if (!deps.dualRouterCoordinator) {
      return c.json({ ok: false, error: "Dual router coordinator not configured" }, 503);
    }

    try {
      const report = await deps.dualRouterCoordinator.run({
        mode: "audit",
        trigger: "manual",
        now: Date.now(),
      });
      return c.json({ ok: true, report });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  // POST /reconcile: runs coordinator full or incremental mode
  router.post("/reconcile", async (c) => {
    if (!deps.dualRouterCoordinator) {
      return c.json({ ok: false, error: "Dual router coordinator not configured" }, 503);
    }

    let mode: "incremental" | "full" = "incremental";
    try {
      const body = await c.req.json();
      if (body?.mode === "full") {
        mode = "full";
      }
    } catch {
      // mode defaults to incremental
    }

    try {
      const report = await deps.dualRouterCoordinator.run({
        mode,
        trigger: "manual",
        now: Date.now(),
      });
      return c.json({ ok: true, report });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  // POST /conflicts/:id/resolve: resolves conflict with body { revision: number; value: Value }
  router.post("/conflicts/:id/resolve", async (c) => {
    if (!deps.dualRouterCoordinator) {
      return c.json({ ok: false, error: "Dual router coordinator not configured" }, 503);
    }

    const id = c.req.param("id");
    let body: { revision?: unknown; value?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "Invalid JSON body" }, 400);
    }

    if (!body || typeof body.revision !== "number") {
      return c.json({ ok: false, error: "Missing or invalid revision number" }, 400);
    }

    try {
      const report = await deps.dualRouterCoordinator.resolve({
        id,
        revision: body.revision,
        value: body.value as Value,
        actor: "api",
      });
      return c.json({ ok: true, report });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("Conflict resolution rejected") || msg.includes("stale revision")) {
        return c.json({ ok: false, error: msg }, 409);
      }
      return c.json({ ok: false, error: msg }, 500);
    }
  });

  // POST /usage/write-back: writes back usage if authorized
  router.post("/usage/write-back", async (c) => {
    if (!deps.dualRouterRepo) {
      return c.json({ ok: false, error: "Dual router repository not configured" }, 503);
    }

    const policy = deps.dualRouterRepo.getPolicy();
    if (!policy.usageWriteBackAuthorized) {
      return c.json({ ok: false, error: "Usage write-back is not authorized by sync policy" }, 403);
    }

    const usageService = createUsageService({
      repository: deps.dualRouterRepo,
      adapters: deps.dualRouterAdapters ?? [],
    });

    let writes: UsageWrite[] = [];
    try {
      const body = await c.req.json();
      if (Array.isArray(body?.writes)) {
        writes = body.writes;
      }
    } catch {
      // writes defaults to empty
    }

    try {
      const receipts = await usageService.writeBack(writes);
      return c.json({ ok: true, receipts });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  return router;
}
