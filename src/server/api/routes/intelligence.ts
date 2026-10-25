import { Hono } from "hono";
import type { ApiDependencies, ApiEnv } from "../types.js";
import { createAlreadySentResponse } from "../app.js";

export function createIntelligenceRoutes(deps: ApiDependencies): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.all("*", async (c) => {
    const req = c.env.incoming;
    const res = c.env.outgoing;
    const pathname = new URL(c.req.url).pathname;
    await deps.legacyHandlers.handleIntelligence(req, res, pathname);
    if (res?.writableEnded) {
      return createAlreadySentResponse();
    }
  });

  return router;
}
