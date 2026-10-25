import { Hono } from "hono";
import type { IncomingMessage } from "node:http";
import type { ApiDependencies, ApiEnv } from "../types.js";
import {
  clearSessionCookie,
  createSession,
  readSession,
  requireDashboardAuth,
  revokeSession,
  sessionCookie,
} from "../../session-auth.js";
import { createBodyLimitMiddleware } from "../middleware/body-limit.js";

function getIncomingAdapter(c: {
  env?: { incoming?: IncomingMessage };
  req: { header: (name: string) => string | undefined };
}): IncomingMessage {
  if (c.env?.incoming) return c.env.incoming;
  const cookie = c.req.header("cookie");
  const authorization = c.req.header("authorization");
  return { headers: { cookie, authorization } } as unknown as IncomingMessage;
}

export function createAuthRoutes(deps: ApiDependencies): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.post("/login", createBodyLimitMiddleware(10_000), async (c) => {
    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }
    const password = typeof body.password === "string" ? body.password : "";
    if (!password || !deps.verifyControlPassword(password)) {
      return c.json({ error: "Invalid control password" }, 401);
    }
    const session = createSession();
    const req = c.env?.incoming;
    const isSecure =
      req?.headers["x-forwarded-proto"] === "https" ||
      Boolean(
        req?.socket &&
          "encrypted" in req.socket &&
          (req.socket as { encrypted?: boolean }).encrypted,
      );
    c.header("Set-Cookie", sessionCookie(session.token, isSecure));
    return c.json({ authenticated: true, expiresAt: session.expiresAt });
  });

  router.post("/logout", async (c) => {
    const cookieHeader = c.env?.incoming?.headers.cookie ?? c.req.header("cookie");
    revokeSession(cookieHeader);
    c.header("Set-Cookie", clearSessionCookie());
    return c.json({ authenticated: false });
  });

  router.get("/session", async (c) => {
    const incomingReq = getIncomingAdapter(c);
    const authResult = requireDashboardAuth(incomingReq);
    if (authResult.authenticated && !readSession(incomingReq.headers.cookie)) {
      const session = createSession();
      const req = c.env?.incoming;
      const isSecure =
        req?.headers["x-forwarded-proto"] === "https" ||
        Boolean(
          req?.socket &&
            "encrypted" in req.socket &&
            (req.socket as { encrypted?: boolean }).encrypted,
        );
      c.header("Set-Cookie", sessionCookie(session.token, isSecure));
    }
    return c.json({ authenticated: authResult.authenticated });
  });

  return router;
}
