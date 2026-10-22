import { Hono } from 'hono';
import type { ApiDependencies, ApiEnv } from '../types.js';

export function createNineRouterRoutes(deps: ApiDependencies): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.all('*', async (c) => {
    const req = c.env.incoming;
    const res = c.env.outgoing;
    const pathname = new URL(c.req.url).pathname;
    await deps.legacyHandlers.handleNineRouter(req, res, pathname);
  });

  return router;
}
