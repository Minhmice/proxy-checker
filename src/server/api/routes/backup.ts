import { Hono } from "hono";
import type { ApiDependencies, ApiEnv } from "../types.js";
import { getBackupSyncStatus, triggerFullBackupAndSync } from "../../backup/git-sync.js";
import { restoreBackup } from "../../backup/backup-service.js";

export function createBackupRoutes(deps: ApiDependencies): Hono<ApiEnv> {
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

      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message || "Backup and sync failed" }, 500);
    }
  });

  // POST /api/backup/restore
  router.post("/restore", async (c) => {
    try {
      const result = restoreBackup();
      if (deps.settings && typeof deps.settings.initAppConfig === "function") {
        try {
          deps.settings.initAppConfig();
        } catch {}
      }
      return c.json({ ...result });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message || "Restore failed" }, 500);
    }
  });

  return router;
}
