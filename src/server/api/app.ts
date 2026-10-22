import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ApiDependencies, ApiEnv } from './types.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createAuthRoutes } from './routes/auth.js';
import { createFleetRoutes } from './routes/fleet.js';
import { createNineRouterRoutes } from './routes/ninerouter.js';
import { createAntigravityRoutes } from './routes/antigravity.js';
import { createSettingsRoutes } from './routes/settings.js';
import { createIntelligenceRoutes } from './routes/intelligence.js';
import { createProxiesRoutes } from './routes/proxies.js';

export function createApiApp(deps: ApiDependencies): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  // Global error handler
  app.onError((err, c) => {
    let status: ContentfulStatusCode = 500;
    if (
      'status' in err &&
      typeof err.status === 'number' &&
      err.status >= 400 &&
      err.status < 600
    ) {
      status = err.status as ContentfulStatusCode;
    }
    const message =
      err instanceof Error ? err.message : 'Internal Server Error';
    return c.json({ error: message }, status);
  });

  // Health check
  app.get('/api/health', (c) => {
    return c.json({ ok: true });
  });

  // Auth middleware for all API endpoints
  app.use('/api/*', createAuthMiddleware(deps));

  // Route modules
  app.route('/api/auth', createAuthRoutes(deps));
  app.route('/api/fleet', createFleetRoutes(deps));
  app.route('/api/ninerouter', createNineRouterRoutes(deps));
  app.route('/api/antigravity', createAntigravityRoutes(deps));
  app.route('/api/settings', createSettingsRoutes(deps));
  app.route('/api/intelligence', createIntelligenceRoutes(deps));
  app.route('/api/proxies', createProxiesRoutes(deps));

  // Catch-all 404 for unknown /api routes
  app.notFound((c) => {
    return c.json({ error: 'not found' }, 404);
  });

  return app;
}
