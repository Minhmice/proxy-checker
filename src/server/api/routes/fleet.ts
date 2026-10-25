import { Hono } from "hono";
import type { ApiDependencies, ApiEnv } from "../types.js";
import { createAlreadySentResponse } from "../app.js";

export function createFleetRoutes(deps: ApiDependencies): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.all("*", async (c) => {
    const req = c.env.incoming;
    const res = c.env.outgoing;
    const pathname = new URL(c.req.url).pathname;

    if (await deps.handleFleetRuntimeApi(req, res, pathname)) {
      if (res?.writableEnded) {
        return createAlreadySentResponse();
      }
      return;
    }

    const handled = await deps.handleFleetApi(req, res, pathname);
    if (handled) {
      if (res?.writableEnded) {
        return createAlreadySentResponse();
      }
      return;
    }

    return c.json({ error: "not found" }, 404);
  });

  return router;
}
