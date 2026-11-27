import { bodyLimit } from "hono/body-limit";
import type { MiddlewareHandler } from "hono";
import type { ApiEnv } from "../types.js";

export function createBodyLimitMiddleware(maxBytes: number): MiddlewareHandler<ApiEnv> {
  return bodyLimit({
    maxSize: maxBytes,
    onError: (c) => c.json({ error: "Payload too large" }, 413),
  });
}
