import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBackupSnapshot, restoreBackup } from "../src/server/backup/backup-service.js";

test("backup and restore leave legacy proxy registry and pool state untouched", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-backup-legacy-"));
  const dataDir = path.join(root, "data");
  const backupDir = path.join(root, "backup");
  fs.mkdirSync(dataDir);
  fs.mkdirSync(path.join(backupDir, "databases"), { recursive: true });
  const registry = Buffer.from("legacy registry must not be opened or replaced");
  fs.writeFileSync(path.join(dataDir, "proxies.sqlite3"), registry);
  fs.writeFileSync(path.join(dataDir, "pool-state.json"), "original");
  fs.writeFileSync(path.join(backupDir, "databases", "proxies.sqlite3"), "different");
  fs.writeFileSync(path.join(backupDir, "pool-state.json"), "different");
  const previous = process.env.APP_CONFIG_PATH;
  process.env.APP_CONFIG_PATH = path.join(dataDir, "settings.json");
  fs.writeFileSync(process.env.APP_CONFIG_PATH, "{}");
  try {
    const backup = createBackupSnapshot({ dataDir, backupDir });
    assert.equal(backup.ok, true);
    assert.equal(
      backup.manifest.files.some((entry) => entry.name.includes("proxies.sqlite3")),
      false,
    );
    const restored = restoreBackup({ dataDir, backupDir });
    assert.equal(restored.ok, true);
    assert.deepEqual(fs.readFileSync(path.join(dataDir, "proxies.sqlite3")), registry);
    assert.equal(fs.readFileSync(path.join(dataDir, "pool-state.json"), "utf8"), "original");
  } finally {
    if (previous === undefined) delete process.env.APP_CONFIG_PATH;
    else process.env.APP_CONFIG_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
