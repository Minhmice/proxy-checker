import { Hono } from "hono";
import crypto from "node:crypto";
import type { ApiDependencies, ApiEnv } from "../types.js";
import { createAlreadySentResponse } from "../app.js";
import { repairAntigravityRoute } from "../../antigravity-repair.js";
import { proxyEndpointKey } from "../../antigravity-observation.js";
import type { OwnershipRequest } from "../../antigravity-ownership.js";

export function createAntigravityRoutes(deps: ApiDependencies): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  router.post("/repair-route", async (c) => {
    const input = await c.req.json();
    const target = deps.antigravityRouters?.find((r) => r.routerId === input.routerId);
    if (
      !target ||
      typeof input.accountId !== "string" ||
      !["unsafe_transport", "verified_proxy_denial", "manual_quota_diagnostic"].includes(
        input.cause,
      )
    )
      return c.json({ error: "Invalid repair target" }, 400);
    const request = {
      routerUrl: target.url,
      routerId: target.routerId,
      accountId: input.accountId,
      operationId: crypto.randomUUID(),
      cause: input.cause,
      signal: c.req.raw.signal,
    };
    const overrides = { url: target.url };
    const result = await repairAntigravityRoute(request, {
      capabilities: () => deps.router.getSafetyCapabilities(overrides),
      binding: () => deps.router.getConnectionBinding(input.accountId, overrides),
      pools: () => deps.router.listPools(overrides),
      audit: (pool) =>
        deps.router.auditRouterGooglePool(pool.id, pool.poolRevision || 1, overrides),
      update: (update) =>
        deps.router.updateConnectionConditional(input.accountId, update, overrides),
      verify: (binding, pool) =>
        deps.router.verifyConnectionQuota(
          input.accountId,
          {
            expectedRevision: binding.revision,
            expectedPoolId: pool.id,
            expectedPoolRevision: pool.poolRevision || 1,
          },
          overrides,
          c.req.raw.signal,
        ),
      authority: deps.antigravityOwnership,
    });
    return c.json(
      result,
      result.status === "repaired" ? 200 : result.status === "unsupported" ? 503 : 409,
    );
  });
  router.post("/reset-proxies", async (c) => {
    try {
      const result = await deps.antigravityRotator.resetProxies({ forceAll: true });
      return c.json(result);
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });
  router.post("/ownership/:action", async (c) => {
    const authority = deps.antigravityOwnership;
    if (!authority) return c.json({ error: "Ownership authority not configured" }, 503);
    const input = await c.req.json();
    const target = deps.antigravityRouters?.find((r) => r.routerId === input.routerId);
    if (
      !target ||
      typeof input.accountId !== "string" ||
      typeof input.operationId !== "string" ||
      !Number.isSafeInteger(input.bindingRevision) ||
      input.bindingRevision < 1 ||
      typeof input.proxyEndpointKey !== "string"
    )
      return c.json({ error: "Invalid ownership request" }, 400);
    const key = proxyEndpointKey(input.proxyEndpointKey);
    if (key !== input.proxyEndpointKey)
      return c.json({ error: "Invalid canonical proxy endpoint" }, 400);
    const accounts = await deps.router.listAntigravityConnections({ url: target.url });
    if (!accounts.some((a) => a.id === input.accountId))
      return c.json({ error: "Account not found on target router" }, 404);
    const pools = await deps.router.listPools({ url: target.url });
    if (!pools.some((p) => proxyEndpointKey(p.proxyUrl) === key))
      return c.json({ error: "Proxy not found on target router" }, 404);
    const request: OwnershipRequest = {
      proxyEndpointKey: key,
      routerId: target.routerId,
      accountId: input.accountId,
      bindingRevision: input.bindingRevision,
      operationId: input.operationId,
    };
    const action = c.req.param("action");
    if (action === "reserve") return c.json(authority.reserve(request));
    if (!Number.isSafeInteger(input.epoch) || input.epoch < 1)
      return c.json({ error: "Invalid ownership epoch" }, 400);
    if (action === "renew") return c.json(authority.renew({ ...request, epoch: input.epoch }));
    if (action === "release") {
      const drained = await deps.router.drainConnectionRoute(
        input.accountId,
        {
          operationId: input.operationId,
          expectedRevision: input.bindingRevision,
          epoch: input.epoch,
        },
        { url: target.url },
      );
      return c.json({
        released: authority.release({
          ...request,
          epoch: input.epoch,
          drained: drained.drained === true,
        }),
      });
    }
    return c.json({ error: "Unknown ownership action" }, 404);
  });
  router.all("*", async (c) => {
    const req = c.env.incoming;
    const res = c.env.outgoing;
    const pathname = new URL(c.req.url).pathname;
    await deps.legacyHandlers.handleAntigravity(req, res, pathname);
    if (res?.writableEnded) return createAlreadySentResponse();
  });
  return router;
}
