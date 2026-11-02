import { Hono } from "hono";
import type { ApiDependencies, ApiEnv } from "../types.js";
import { getBackupSyncStatus, triggerFullBackupAndSync } from "../../backup/git-sync.js";

export function createBackupRoutes(_deps: ApiDependencies): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  // GET /api/backup/status
  router.get("/status", async (c) => {
    try {
      const status = await getBackupSyncStatus();
      return c.json({ ok: true, status });
    } catch (err) {
      return c.json(
        { ok: false, error: (err as Error).message || "Failed to get backup status" },
        500,
      );
    }
  });

  // POST /api/backup/sync
  router.post("/sync", async (c) => {
    try {
      let body: { push?: boolean } = {};
      try {
        body = await c.req.json();
      } catch {}

      const result = await triggerFullBackupAndSync({
        push: body.push !== false,
      });

      return c.json({
        ok: result.backup.ok && result.git.ok,
        ...result,
        error: result.git.error || (result.backup.ok ? undefined : result.backup.errors.join("; ")),
      });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message || "Backup and sync failed" }, 500);
    }
  });

  // POST /api/backup/restore
  router.post("/restore", (c) =>
    c.json(
      {
        ok: false,
        error:
          "Restore is unavailable while the server is running. Stop all writers and use an offline recovery procedure.",
      },
      409,
    ),
  );

  return router;
}
