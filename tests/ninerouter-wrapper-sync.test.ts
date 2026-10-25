import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPoolRanker } from "../src/server/pool-ranker.js";

test("syncPools evicts dead pool from 9router, soft-deletes in repo, and renames survivors in reverse rank order", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-sync-test-"));
  const deletedRemoteIds: string[] = [];
  const renamedCalls: { remoteId: string; name: string }[] = [];
  const softDeletedKeys: string[] = [];

  const mockDeps = {
    listPools: async () => [
      {
        id: "p-fast",
        name: "Old 1",
        proxyUrl: "http://1.1.1.1:8080",
        protocol: "http",
        isActive: true,
      },
      {
        id: "p-slow",
        name: "Old 2",
        proxyUrl: "http://2.2.2.2:8080",
        protocol: "http",
        isActive: true,
      },
      {
        id: "p-dead",
        name: "Old 3",
        proxyUrl: "http://3.3.3.3:8080",
        protocol: "http",
        isActive: true,
      },
    ],
    testPool: async (remoteId: string) => {
      if (remoteId === "p-dead") return { ok: false, elapsedMs: 5000, error: "Gateway timeout" };
      if (remoteId === "p-fast") return { ok: true, elapsedMs: 120 };
      if (remoteId === "p-slow") return { ok: true, elapsedMs: 450 };
      return { ok: false, elapsedMs: 0 };
    },
    deletePool: async (remoteId: string) => {
      deletedRemoteIds.push(remoteId);
    },
    setPoolActive: async () => ({}),
    bulkSetActive: async (updates: Array<{ id: string; isActive: boolean }>) =>
      updates.map((u) => ({ id: u.id, ok: true, isActive: u.isActive })),
    renamePool: async (remoteId: string, name: string) => {
      renamedCalls.push({ remoteId, name });
    },
    onSoftDelete: async (key: string) => {
      softDeletedKeys.push(key);
    },
  };

  try {
    const ranker = createPoolRanker({ dataDir: tmpDir }, mockDeps);
    await ranker.syncPools({ force: true });

    // Dead pool must be deleted from 9router
    assert.deepEqual(deletedRemoteIds, ["p-dead"]);

    // Soft delete callback must be called for p-dead
    assert.ok(softDeletedKeys.length >= 1);

    // Renaming must occur: p-fast (120ms) is rank 1, p-slow (450ms) is rank 2.
    // Reverse rank order: rank 2 is renamed FIRST, then rank 1.
    assert.equal(renamedCalls.length, 2);
    assert.deepEqual(renamedCalls[0], { remoteId: "p-slow", name: "2" });
    assert.deepEqual(renamedCalls[1], { remoteId: "p-fast", name: "1" });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
