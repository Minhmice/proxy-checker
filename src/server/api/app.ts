import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiDependencies, ApiEnv } from "./types.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createNineRouterRoutes } from "./routes/ninerouter.js";
import { createAntigravityRoutes } from "./routes/antigravity.js";
import { createSettingsRoutes } from "./routes/settings.js";
import { createBackupRoutes } from "./routes/backup.js";
import { createSpotifyRoutes } from "./routes/spotify.js";

export function createAlreadySentResponse(): Response {
  return {
    status: 200,
    headers: new Headers({ "x-hono-already-sent": "true" }),
    body: null,
  } as unknown as Response;
}

export function createApiApp(deps: ApiDependencies): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

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

  app.get("/api/health", (c) => {
    return c.json({ ok: true });
  });

  app.use("*", async (c, next) => {
    await next();
    if (c.env?.outgoing?.writableEnded) {
      return createAlreadySentResponse();
    }
  });

  app.use("/api/*", createAuthMiddleware(deps));

  app.route("/api/auth", createAuthRoutes(deps));
  app.route("/api/ninerouter", createNineRouterRoutes(deps));
  app.route("/api/antigravity", createAntigravityRoutes(deps));
  app.route("/api/settings", createSettingsRoutes(deps));
  app.route("/api/backup", createBackupRoutes(deps));
  app.route("/api/spotify", createSpotifyRoutes());

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
