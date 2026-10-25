import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiDependencies, ApiEnv } from "./types.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createFleetRoutes } from "./routes/fleet.js";
import { createDualRouterRoutes } from "./routes/dual-router.js";
import { createNineRouterRoutes } from "./routes/ninerouter.js";
import { createAntigravityRoutes } from "./routes/antigravity.js";
import { createSettingsRoutes } from "./routes/settings.js";
import { createIntelligenceRoutes } from "./routes/intelligence.js";
import { createProxiesRoutes } from "./routes/proxies.js";
import { createBackupRoutes } from "./routes/backup.js";

export function createAlreadySentResponse(): Response {
  return {
    status: 200,
    headers: new Headers({ "x-hono-already-sent": "true" }),
    body: null,
  } as unknown as Response;
}

export function createApiApp(deps: ApiDependencies): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  // Global error handler
  app.onError((err, c) => {
    let status: ContentfulStatusCode = 500;
    if (
      "status" in err &&
      typeof err.status === "number" &&
      err.status >= 400 &&
      err.status < 600
    ) {
      status = err.status as ContentfulStatusCode;
    }
    const message = err instanceof Error ? err.message : "Internal Server Error";
    return c.json({ error: message }, status);
  });

  // Health check
  app.get("/api/health", (c) => {
    return c.json({ ok: true });
  });

  // Auth middleware for all API endpoints
  // Intercept responses already handled directly on Node outgoing response
  app.use("*", async (c, next) => {
    await next();
    if (c.env?.outgoing?.writableEnded) {
      return createAlreadySentResponse();
    }
  });

  app.use("/api/*", createAuthMiddleware(deps));

  // Route modules
  app.route("/api/auth", createAuthRoutes(deps));
  app.route("/api/fleet", createFleetRoutes(deps));
  app.route("/api/ninerouter/dual", createDualRouterRoutes(deps));
  app.route("/api/ninerouter", createNineRouterRoutes(deps));
  app.route("/api/antigravity", createAntigravityRoutes(deps));
  app.route("/api/settings", createSettingsRoutes(deps));
  app.route("/api/intelligence", createIntelligenceRoutes(deps));
  app.route("/api/proxies", createProxiesRoutes(deps));
  app.route("/api/backup", createBackupRoutes(deps));

  // Catch-all 404 for unknown /api routes
  app.notFound((c) => {
    return c.json({ error: "not found" }, 404);
  });

  const rawFetch = app.fetch.bind(app);
  app.fetch = async (...args) => {
    const result = await rawFetch(...args);
    if (
      result &&
      typeof result === "object" &&
      "body" in result &&
      typeof result.body === "function"
    ) {
      return createAlreadySentResponse();
    }
    return result;
  };

  return app;
}
