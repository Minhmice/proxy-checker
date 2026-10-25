import type { MiddlewareHandler } from "hono";
import type { ApiEnv } from "../types.js";

export function createBodyLimitMiddleware(maxBytes: number): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const contentLength = c.req.header("content-length");
    if (contentLength && Number(contentLength) > maxBytes) {
      return c.json({ error: "Payload too large" }, 413);
    }
    return next();
  };
}
