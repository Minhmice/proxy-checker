import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createBackupSnapshot, restoreBackup } from "../src/server/backup/backup-service.js";
import {
  getBackupSyncStatus,
  hasGitRemote,
  syncBackupToGit,
} from "../src/server/backup/git-sync.js";
import { createApiApp } from "../src/server/api/app.js";
import type { ApiDependencies } from "../src/server/api/types.js";

function createMockDeps(): ApiDependencies {
  return {
    verifyControlPassword: (c) => c === "secret",
    antigravityRotator: {} as unknown as ApiDependencies["antigravityRotator"],
    unifiedSyncCoordinator: {} as unknown as ApiDependencies["unifiedSyncCoordinator"],
    router: {} as unknown as ApiDependencies["router"],
    settings: {
      initAppConfig: () => {},
    } as unknown as ApiDependencies["settings"],
    legacyHandlers: {
      handleNineRouter: async () => {},
      handleAntigravity: async () => {},
      handleSettings: async () => {},
    },
  };
}

test("backup-service creates consistent SQLite snapshots and settings backup", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "backup-test-"));
  const dataDir = path.join(tmpRoot, "data");
  const backupDir = path.join(tmpRoot, "backups");
  fs.mkdirSync(dataDir, { recursive: true });

  // 1. Create dummy settings.json
  const settingsData = {
    controlPassword: "hashed_secret",
    nineRouterUrl: "http://127.0.0.1:8000",
    nineRouterAutoSync: true,
  };
  fs.writeFileSync(
    path.join(dataDir, "settings.json"),
    JSON.stringify(settingsData, null, 2),
    "utf8",
  );

  // Snapshot the retained account rotation database.
  const dbPath = path.join(dataDir, "antigravity-rotation.sqlite3");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE account_turns (id TEXT PRIMARY KEY, turns INTEGER);");
  db.prepare("INSERT INTO account_turns VALUES (?, ?)").run("account-1", 2);
  db.close();

  // 3. Create dummy state JSON
  fs.writeFileSync(
    path.join(dataDir, "antigravity-rotator.json"),
    JSON.stringify({ active: ["acc_1"] }),
    "utf8",
  );

  try {
    const result = createBackupSnapshot({ dataDir, backupDir });
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);

    // Verify manifest
    const manifestPath = path.join(backupDir, "manifest.json");
    assert.equal(fs.existsSync(manifestPath), true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.version, 1);
    assert.ok(manifest.files.length >= 3);

    // Verify backed up settings.json
    const backedSettings = path.join(backupDir, "settings.json");
    assert.equal(fs.existsSync(backedSettings), true);
    const parsedSettings = JSON.parse(fs.readFileSync(backedSettings, "utf8"));
    assert.equal(parsedSettings.nineRouterUrl, "http://127.0.0.1:8000");

    // Verify backed up database snapshot
    const backedDbPath = path.join(backupDir, "databases", "antigravity-rotation.sqlite3");
    assert.equal(fs.existsSync(backedDbPath), true);
    const backedDb = new Database(backedDbPath, { readonly: true });
    const row = backedDb.prepare("SELECT * FROM account_turns WHERE id = ?").get("account-1") as {
      id: string;
      turns: number;
    };
    assert.equal(row.turns, 2);
    backedDb.close();

    // Verify state file
    const backedState = path.join(backupDir, "antigravity-rotator.json");
    assert.equal(fs.existsSync(backedState), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("backup-service restore overwrites data and purges stale wal/shm files", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "backup-restore-test-"));
  const dataDir = path.join(tmpRoot, "data");
  const backupDir = path.join(tmpRoot, "backups");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(backupDir, "databases"), { recursive: true });

  // Backup files
  fs.writeFileSync(
    path.join(backupDir, "settings.json"),
    JSON.stringify({ restored: true }, null, 2),
    "utf8",
  );

  const backupDbPath = path.join(backupDir, "databases", "antigravity-rotation.sqlite3");
  const bDb = new Database(backupDbPath);
  bDb.exec("CREATE TABLE account_turns (id TEXT PRIMARY KEY, turns INTEGER);");
  bDb.prepare("INSERT INTO account_turns VALUES (?, ?)").run("account-1", 3);
  bDb.close();

  // Active data dir has stale wal and shm
  const activeDbPath = path.join(dataDir, "antigravity-rotation.sqlite3");
  fs.writeFileSync(activeDbPath, "corrupt-old-data");
  fs.writeFileSync(`${activeDbPath}-wal`, "stale-wal");
  fs.writeFileSync(`${activeDbPath}-shm`, "stale-shm");

  try {
    const res = restoreBackup({ dataDir, backupDir });
    assert.equal(res.ok, true);
    assert.ok(res.restoredFiles.includes("settings.json"));
    assert.ok(res.restoredFiles.includes("databases/antigravity-rotation.sqlite3"));

    // Verify wal and shm were purged
    assert.equal(fs.existsSync(`${activeDbPath}-wal`), false);
    assert.equal(fs.existsSync(`${activeDbPath}-shm`), false);

    // Verify database can be queried cleanly
    const restoredDb = new Database(activeDbPath, { readonly: true });
    const row = restoredDb.prepare("SELECT * FROM account_turns").get();
    assert.deepEqual(row, { id: "account-1", turns: 3 });
    restoredDb.close();
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("git-sync status returns structured metadata safely", async () => {
  const status = await getBackupSyncStatus();
  assert.equal(typeof status.hasUncommittedChanges, "boolean");
  assert.equal(typeof status.isSyncing, "boolean");
  assert.equal(typeof status.remoteConfigured, "boolean");
  assert.equal(typeof status.backupFileCount, "number");
  assert.equal(typeof (await hasGitRemote()), "boolean");
});

test("api/backup/status endpoint responds with status", async () => {
  const app = createApiApp(createMockDeps());
  const res = await app.request("/api/backup/status?password=secret");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; status?: unknown };
  assert.equal(body.ok, true);
  assert.ok(body.status);
});

test("git-sync safely handles backupDir outside repository", async () => {
  const tmpOutsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "outside-backup-test-"));
  try {
    const res = await syncBackupToGit({ backupDir: tmpOutsideDir });
    assert.equal(res.ok, false);
    assert.match(res.error || "", /outside repository/i);

    const status = await getBackupSyncStatus({ backupDir: tmpOutsideDir });
    assert.equal(typeof status.hasUncommittedChanges, "boolean");
    assert.equal(status.hasUncommittedChanges, false);
  } finally {
    fs.rmSync(tmpOutsideDir, { recursive: true, force: true });
  }
});
