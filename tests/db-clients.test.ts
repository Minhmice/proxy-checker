import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openRotationDb } from "../src/db/rotation/client.js";
import { accountTurns } from "../src/db/rotation/schema.js";

test("rotation client preserves account tenure across reopen", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "account-rotation-drizzle-"));
  const rotation = openRotationDb(path.join(dir, "rotation.sqlite3"));
  try {
    rotation.db
      .insert(accountTurns)
      .values({ accountId: "account", turnCount: 2, lastActivatedAt: 1234 })
      .run();
  } finally {
    rotation.close();
  }
  try {
    const reopened = openRotationDb(path.join(dir, "rotation.sqlite3"));
    try {
      assert.deepEqual(reopened.db.select().from(accountTurns).all(), [
        {
          accountId: "account",
          turnCount: 2,
          lastActivatedAt: 1234,
          thresholdPercentage: null,
          tenureState: "inactive",
        },
      ]);
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
