import type { MiddlewareHandler } from "hono";
import type { IncomingMessage } from "node:http";
import type { ApiDependencies, ApiEnv } from "../types.js";
import { requireDashboardAuth } from "../../session-auth.js";

export function createAuthMiddleware(deps: ApiDependencies): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const pathname = new URL(c.req.url).pathname;

    // 1. Explicit public and worker token routes
    if (
      pathname === "/api/health" ||
      pathname === "/api/auth/login" ||
      pathname === "/api/auth/logout" ||
      pathname === "/api/auth/session" ||
      pathname === "/api/fleet/enroll" ||
      pathname.startsWith("/api/fleet/agent/")
    ) {
      return next();
    }

    // 2. Adapt request headers for in-memory session validation
    const cookie = c.req.header("cookie");
    const authorization = c.req.header("authorization");
    const incomingReq =
      c.env?.incoming ?? ({ headers: { cookie, authorization } } as unknown as IncomingMessage);

    const authResult = requireDashboardAuth(incomingReq);
    if (authResult.authenticated) {
      c.set("authenticated", true);
      return next();
    }

    if (authorization) {
      if (authorization.startsWith("Basic ")) {
        try {
          const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
          const colon = decoded.indexOf(":");
          if (colon >= 0 && decoded.slice(0, colon) === "admin") {
            const pass = decoded.slice(colon + 1);
            if (deps.verifyControlPassword(pass)) {
              c.set("authenticated", true);
              return next();
            }
          }
        } catch {}
      } else if (authorization.startsWith("Bearer ")) {
        const pass = authorization.slice(7).trim();
        if (deps.verifyControlPassword(pass)) {
          c.set("authenticated", true);
          return next();
        }
      }
    }

    // 3. Query string token/password compatibility
    const queryAuth = c.req.query("password") || c.req.query("auth") || c.req.query("token");
    if (queryAuth && deps.verifyControlPassword(queryAuth)) {
      c.set("authenticated", true);
      return next();
    }

    // 4. Return appropriate 401 error message matching existing contract
    if (
      pathname.startsWith("/api/settings") ||
      pathname.startsWith("/api/intelligence") ||
      pathname.startsWith("/api/proxies")
    ) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    return c.json({ error: "Invalid control password" }, 401);
  };
}
