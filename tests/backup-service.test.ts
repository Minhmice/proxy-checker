import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
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

  const dbPath = path.join(dataDir, "antigravity-rotation.sqlite3");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE account_turns (id TEXT PRIMARY KEY, turns INTEGER);");
  db.prepare("INSERT INTO account_turns VALUES (?, ?)").run("account-1", 2);
  db.close();

  fs.writeFileSync(
    path.join(dataDir, "antigravity-rotator.json"),
    JSON.stringify({ active: ["acc_1"] }),
    "utf8",
  );

  try {
    const result = createBackupSnapshot({ dataDir, backupDir });
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);

    const manifestPath = path.join(backupDir, "manifest.json");
    assert.equal(fs.existsSync(manifestPath), true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.deepEqual(result.manifest, manifest);
    assert.equal(
      manifest.files.some((entry: { name: string }) => entry.name === "manifest.json"),
      false,
    );
    assert.equal(manifest.version, 1);
    assert.ok(manifest.files.length >= 3);

    const backedSettings = path.join(backupDir, "settings.json");
    assert.equal(fs.existsSync(backedSettings), true);
    const parsedSettings = JSON.parse(fs.readFileSync(backedSettings, "utf8"));
    assert.equal(parsedSettings.nineRouterUrl, "http://127.0.0.1:8000");

    const backedDbPath = path.join(backupDir, "databases", "antigravity-rotation.sqlite3");
    assert.equal(fs.existsSync(backedDbPath), true);
    const backedDb = new Database(backedDbPath, { readonly: true });
    const row = backedDb.prepare("SELECT * FROM account_turns WHERE id = ?").get("account-1") as {
      id: string;
      turns: number;
    };
    assert.equal(row.turns, 2);
    backedDb.close();

    const backedState = path.join(backupDir, "antigravity-rotator.json");
    assert.equal(fs.existsSync(backedState), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("SQLite snapshot retries use fresh staging files and clean up failures", (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "backup-vacuum-test-"));
  const dataDir = path.join(tmpRoot, "data");
  const backupDir = path.join(tmpRoot, "backups");
  const databasesDir = path.join(backupDir, "databases");
  const name = "antigravity-rotation.sqlite3";
  const source = path.join(dataDir, name);
  const destination = path.join(databasesDir, name);
  fs.mkdirSync(dataDir);
  fs.mkdirSync(databasesDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "settings.json"), "{}");
  const db = new Database(source);
  db.exec("CREATE TABLE items (value INTEGER); INSERT INTO items VALUES (42)");
  db.close();
  fs.copyFileSync(source, destination);
  const sourceBefore = fs.readFileSync(source);
  const originalPrepare = Database.prototype.prepare;
  const targets: string[] = [];

  try {
    let failures = 1;
    const prepare = t.mock.method(
      Database.prototype,
      "prepare",
      function (this: Database.Database, sql: string) {
        if (sql !== "VACUUM INTO ?") return originalPrepare.call(this, sql);
        const statement = originalPrepare.call(this, sql);
        return {
          run(target: string) {
            targets.push(target);
            if (failures-- > 0) {
              fs.writeFileSync(target, "partial snapshot");
              throw new Error("vacuum failed");
            }
            return statement.run(target);
          },
        } as ReturnType<Database.Database["prepare"]>;
      },
    );
    const retried = createBackupSnapshot({ dataDir, backupDir });
    assert.equal(retried.ok, true, retried.errors.join("; "));
    assert.equal(targets.length, 2);
    assert.notEqual(targets[0], targets[1]);
    assert.deepEqual(fs.readdirSync(databasesDir), [name]);
    assert.deepEqual(fs.readFileSync(source), sourceBefore);

    const destinationBefore = fs.readFileSync(destination);
    targets.length = 0;
    failures = 3;
    const exhausted = createBackupSnapshot({ dataDir, backupDir });
    assert.equal(exhausted.ok, false);
    assert.match(exhausted.errors[0], /vacuum failed/);
    assert.equal(targets.length, 3);
    assert.equal(new Set(targets).size, 3);
    assert.deepEqual(fs.readdirSync(databasesDir), [name]);
    assert.deepEqual(fs.readFileSync(source), sourceBefore);
    assert.deepEqual(fs.readFileSync(destination), destinationBefore);
    prepare.mock.restore();

    const rename = t.mock.method(fs, "renameSync", () => {
      throw new Error("rename failed");
    });
    const failedRename = createBackupSnapshot({ dataDir, backupDir });
    rename.mock.restore();
    assert.equal(failedRename.ok, false);
    assert.match(failedRename.errors[0], /rename failed/);
    assert.deepEqual(fs.readdirSync(databasesDir), [name]);
    assert.deepEqual(fs.readFileSync(source), sourceBefore);
    assert.deepEqual(fs.readFileSync(destination), destinationBefore);
  } finally {
    t.mock.restoreAll();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("backup manifest hashes nonaligned multi-block files", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "backup-hash-test-"));
  const dataDir = path.join(tmpRoot, "data");
  const backupDir = path.join(tmpRoot, "backups");
  try {
    fs.mkdirSync(dataDir);
    fs.writeFileSync(path.join(dataDir, "settings.json"), "{}");
    const content = Buffer.alloc(2 * 64 * 1024 + 37);
    for (let i = 0; i < content.length; i++) content[i] = i % 251;
    fs.writeFileSync(path.join(dataDir, "antigravity-rotator.json"), content);

    const result = createBackupSnapshot({ dataDir, backupDir });
    assert.equal(result.ok, true, result.errors.join("; "));
    const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, "manifest.json"), "utf8"));
    const entry = manifest.files.find(
      (file: { name: string }) => file.name === "antigravity-rotator.json",
    );
    assert.ok(entry);
    assert.equal(entry.size, content.length);
    assert.equal(entry.sha256, crypto.createHash("sha256").update(content).digest("hex"));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("restore rejects same-size tampering before touching settings or database", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backup-manifest-tamper-"));
  const dataDir = path.join(root, "data");
  const backupDir = path.join(root, "backups");
  fs.mkdirSync(dataDir);
  const settings = path.join(dataDir, "settings.json");
  const database = path.join(dataDir, "antigravity-rotation.sqlite3");
  fs.writeFileSync(settings, "backup settings");
  const db = new Database(database);
  db.exec("CREATE TABLE items (value TEXT); INSERT INTO items VALUES ('backup');");
  db.close();
  try {
    assert.equal(createBackupSnapshot({ dataDir, backupDir }).ok, true);
    fs.writeFileSync(settings, "current settings");
    const beforeDb = fs.readFileSync(database);
    const payload = path.join(backupDir, "databases", "antigravity-rotation.sqlite3");
    const bytes = fs.readFileSync(payload);
    bytes[bytes.length - 1] ^= 1;
    fs.writeFileSync(payload, bytes);
    const result = restoreBackup({ dataDir, backupDir });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(" "), /SHA-256 mismatch.*antigravity-rotation\.sqlite3/i);
    assert.deepEqual(result.restoredFiles, []);
    assert.equal(fs.readFileSync(settings, "utf8"), "current settings");
    assert.deepEqual(fs.readFileSync(database), beforeDb);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("restore rejects invalid manifests and unlisted or missing payloads", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backup-manifest-invalid-"));
  const dataDir = path.join(root, "data");
  const backupDir = path.join(root, "backups");
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, "settings.json"), "saved");
  try {
    assert.equal(createBackupSnapshot({ dataDir, backupDir }).ok, true);
    const manifestPath = path.join(backupDir, "manifest.json");
    const original = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    fs.writeFileSync(path.join(dataDir, "settings.json"), "current");
    for (const manifest of [
      { ...original, version: 2 },
      { ...original, files: [{ ...original.files[0], name: "../settings.json" }] },
      { ...original, files: [] },
      { ...original, files: [...original.files, original.files[0]] },
      { ...original, files: [{ ...original.files[0], size: 999 }] },
    ]) {
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      assert.equal(restoreBackup({ dataDir, backupDir }).ok, false);
      assert.equal(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"), "current");
    }
    fs.writeFileSync(manifestPath, JSON.stringify(original));
    fs.unlinkSync(path.join(backupDir, "settings.json"));
    assert.equal(restoreBackup({ dataDir, backupDir }).ok, false);
    assert.equal(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"), "current");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("backup-service restore overwrites data and purges stale wal/shm files", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "backup-restore-test-"));
  const dataDir = path.join(tmpRoot, "data");
  const backupDir = path.join(tmpRoot, "backups");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(backupDir, "databases"), { recursive: true });

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

  const activeDbPath = path.join(dataDir, "antigravity-rotation.sqlite3");
  fs.writeFileSync(activeDbPath, "corrupt-old-data");
  fs.writeFileSync(`${activeDbPath}-wal`, "stale-wal");
  fs.writeFileSync(`${activeDbPath}-shm`, "stale-shm");

  try {
    const res = restoreBackup({ dataDir, backupDir });
    assert.match(res.warnings.join(" "), /legacy.*no manifest.*integrity/i);
    assert.equal(res.ok, true);
    assert.ok(res.restoredFiles.includes("settings.json"));
    assert.ok(res.restoredFiles.includes("databases/antigravity-rotation.sqlite3"));

    assert.equal(fs.existsSync(`${activeDbPath}-wal`), false);
    assert.equal(fs.existsSync(`${activeDbPath}-shm`), false);

    const restoredDb = new Database(activeDbPath, { readonly: true });
    const row = restoredDb.prepare("SELECT * FROM account_turns").get();
    assert.deepEqual(row, { id: "account-1", turns: 3 });
    restoredDb.close();
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("settings restore preserves configured destination after partial copy or rename failure", (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "backup-settings-restore-"));
  const dataDir = path.join(tmpRoot, "data");
  const backupDir = path.join(tmpRoot, "backups");
  const configDir = path.join(tmpRoot, "config");
  const settingsDest = path.join(configDir, "custom-settings.json");
  const previousConfigPath = process.env.APP_CONFIG_PATH;
  fs.mkdirSync(backupDir);
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(backupDir, "settings.json"), "new settings");
  fs.writeFileSync(settingsDest, "old settings");
  process.env.APP_CONFIG_PATH = settingsDest;

  try {
    const copy = t.mock.method(fs, "copyFileSync", (_src: fs.PathLike, dest: fs.PathLike) => {
      fs.writeFileSync(dest, "partial settings");
      throw new Error("copy failed");
    });
    const copyResult = restoreBackup({ dataDir, backupDir });
    copy.mock.restore();
    assert.equal(copyResult.ok, false);
    assert.match(copyResult.errors[0], /copy failed/);
    assert.deepEqual(copyResult.restoredFiles, []);
    assert.equal(fs.readFileSync(settingsDest, "utf8"), "old settings");
    assert.deepEqual(fs.readdirSync(configDir), ["custom-settings.json"]);

    const rename = t.mock.method(fs, "renameSync", () => {
      throw new Error("rename failed");
    });
    const renameResult = restoreBackup({ dataDir, backupDir });
    rename.mock.restore();
    assert.equal(renameResult.ok, false);
    assert.match(renameResult.errors[0], /rename failed/);
    assert.deepEqual(renameResult.restoredFiles, []);
    assert.equal(fs.readFileSync(settingsDest, "utf8"), "old settings");
    assert.deepEqual(fs.readdirSync(configDir), ["custom-settings.json"]);
  } finally {
    t.mock.restoreAll();
    if (previousConfigPath === undefined) delete process.env.APP_CONFIG_PATH;
    else process.env.APP_CONFIG_PATH = previousConfigPath;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("backup manifest keeps previous manifest on payload or publish failure", (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "backup-manifest-"));
  const dataDir = path.join(tmpRoot, "data");
  const backupDir = path.join(tmpRoot, "backups");
  const manifestPath = path.join(backupDir, "manifest.json");
  const previousConfigPath = process.env.APP_CONFIG_PATH;
  delete process.env.APP_CONFIG_PATH;
  fs.mkdirSync(dataDir);
  fs.mkdirSync(backupDir);
  fs.writeFileSync(manifestPath, "old manifest");

  try {
    const payload = createBackupSnapshot({ dataDir, backupDir });
    assert.equal(payload.ok, false);
    assert.equal(fs.readFileSync(manifestPath, "utf8"), "old manifest");
    assert.equal(
      fs.readdirSync(backupDir).some((n) => n.endsWith(".tmp")),
      false,
    );

    fs.writeFileSync(path.join(dataDir, "settings.json"), "{}");
    const rename = t.mock.method(fs, "renameSync", () => {
      throw new Error("rename failed");
    });
    const publish = createBackupSnapshot({ dataDir, backupDir });
    rename.mock.restore();
    assert.equal(publish.ok, false);
    assert.match(publish.errors.join(";"), /Failed to write manifest.json: rename failed/);
    assert.equal(fs.readFileSync(manifestPath, "utf8"), "old manifest");
    assert.equal(
      fs.readdirSync(backupDir).some((n) => n.endsWith(".tmp")),
      false,
    );

    const ok = createBackupSnapshot({ dataDir, backupDir });
    assert.equal(ok.ok, true);
    assert.equal(fs.readFileSync(manifestPath, "utf8"), JSON.stringify(ok.manifest, null, 2));
  } finally {
    t.mock.restoreAll();
    if (previousConfigPath === undefined) delete process.env.APP_CONFIG_PATH;
    else process.env.APP_CONFIG_PATH = previousConfigPath;
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
