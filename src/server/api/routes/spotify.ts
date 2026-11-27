import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { SpotifyAction } from "../../../lib/types.js";
import { SpotifyError, getSpotify, type SpotifyService } from "../../spotify.js";
import { createBodyLimitMiddleware } from "../middleware/body-limit.js";
import type { ApiEnv } from "../types.js";

const ACTIONS: Record<SpotifyAction, true> = {
  next: true,
  pause: true,
  play: true,
  previous: true,
};

/** The origin the owner is browsing from, so the callback can send them back to it. */
function originOf(c: Context<ApiEnv>): string {
  const url = new URL(c.req.url);
  const proto =
    c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
  return `${proto}://${c.req.header("host") ?? url.host}`;
}

function fail(c: Context<ApiEnv>, error: unknown) {
  if (error instanceof SpotifyError) {
    return c.json({ error: error.code }, error.status as ContentfulStatusCode);
  }
  return c.json({ error: "upstream" }, 502);
}

/**
 * `/now` and `/control` are open: the login page shows and drives playback before anyone signs in.
 * `/callback` is open because Spotify may return on another host (127.0.0.1) than the session
 * cookie; its one-time `state` proves the owner started the login. `/login` needs a session.
 */
export function createSpotifyRoutes(service: SpotifyService = getSpotify()): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.get("/login", (c) => {
    try {
      return c.redirect(service.begin(originOf(c)));
    } catch (error) {
      return fail(c, error);
    }
  });

  router.get("/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.redirect("/settings?spotify=error");
    try {
      const returnTo = await service.complete(code, state);
      return c.redirect(`${returnTo}/settings?spotify=connected`);
    } catch {
      return c.redirect("/settings?spotify=error");
    }
  });

  router.get("/now", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await service.now());
  });

  router.post("/control", createBodyLimitMiddleware(1_000), async (c) => {
    // A cross-site form cannot send JSON without a preflight, which this API never grants.
    if (!c.req.header("content-type")?.includes("application/json")) {
      return c.json({ error: "Unsupported media type" }, 415);
    }
    const body = (await c.req.json().catch(() => null)) as { action?: unknown } | null;
    const action = body?.action;
    if (typeof action !== "string" || !Object.hasOwn(ACTIONS, action)) {
      return c.json({ error: "Invalid action" }, 400);
    }
    try {
      await service.control(action as SpotifyAction);
      return c.json({ ok: true });
    } catch (error) {
      return fail(c, error);
    }
  });

  return router;
}
