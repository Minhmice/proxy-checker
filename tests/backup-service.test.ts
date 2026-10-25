import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createBackupSnapshot, restoreBackup } from "../src/server/backup/backup-service.js";
import { getBackupSyncStatus, hasGitRemote } from "../src/server/backup/git-sync.js";
import { createApiApp } from "../src/server/api/app.js";
import type { ApiDependencies } from "../src/server/api/types.js";

function createMockDeps(): ApiDependencies {
  return {
    verifyControlPassword: (c) => c === "secret",
    proxyIntelligenceRepo: {} as unknown as ApiDependencies["proxyIntelligenceRepo"],
    fleetRepo: {} as unknown as ApiDependencies["fleetRepo"],
    poolRanker: {} as unknown as ApiDependencies["poolRanker"],
    antigravityRotator: {} as unknown as ApiDependencies["antigravityRotator"],
    unifiedSyncCoordinator: {} as unknown as ApiDependencies["unifiedSyncCoordinator"],
    fleetWireguard: () => null,
    handleFleetRuntimeApi: async () => false,
    handleFleetApi: async () => false,
    handleProxyCheck: async () => false,
    router: {} as unknown as ApiDependencies["router"],
    settings: {
      initAppConfig: () => {},
    } as unknown as ApiDependencies["settings"],
    legacyHandlers: {
      handleNineRouter: async () => {},
      handleAntigravity: async () => {},
      handleSettings: async () => {},
      handleIntelligence: async () => {},
      handleProxiesUnified: async () => {},
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

  // 2. Create dummy SQLite database proxies.sqlite3 with data
  const dbPath = path.join(dataDir, "proxies.sqlite3");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE proxies (key TEXT PRIMARY KEY, status TEXT);");
  db.prepare("INSERT INTO proxies (key, status) VALUES (?, ?)").run("http://1.1.1.1:8080", "alive");
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
    const backedDbPath = path.join(backupDir, "databases", "proxies.sqlite3");
    assert.equal(fs.existsSync(backedDbPath), true);
    const backedDb = new Database(backedDbPath, { readonly: true });
    const row = backedDb
      .prepare("SELECT * FROM proxies WHERE key = ?")
      .get("http://1.1.1.1:8080") as { key: string; status: string };
    assert.equal(row.status, "alive");
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

  const backupDbPath = path.join(backupDir, "databases", "fleet.sqlite3");
  const bDb = new Database(backupDbPath);
  bDb.exec("CREATE TABLE nodes (id TEXT PRIMARY KEY);");
  bDb.prepare("INSERT INTO nodes (id) VALUES (?)").run("node-backup");
  bDb.close();

  // Active data dir has stale wal and shm
  const activeDbPath = path.join(dataDir, "fleet.sqlite3");
  fs.writeFileSync(activeDbPath, "corrupt-old-data");
  fs.writeFileSync(`${activeDbPath}-wal`, "stale-wal");
  fs.writeFileSync(`${activeDbPath}-shm`, "stale-shm");

  try {
    const res = restoreBackup({ dataDir, backupDir });
    assert.equal(res.ok, true);
    assert.ok(res.restoredFiles.includes("settings.json"));
    assert.ok(res.restoredFiles.includes("databases/fleet.sqlite3"));

    // Verify wal and shm were purged
    assert.equal(fs.existsSync(`${activeDbPath}-wal`), false);
    assert.equal(fs.existsSync(`${activeDbPath}-shm`), false);

    // Verify database can be queried cleanly
    const restoredDb = new Database(activeDbPath, { readonly: true });
    const row = restoredDb.prepare("SELECT * FROM nodes").get() as { id: string };
    assert.equal(row.id, "node-backup");
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
