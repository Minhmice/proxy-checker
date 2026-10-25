import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { getSettingsSecrets } from "../app-config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../../..");

export function getDefaultDataDir(): string {
  return path.resolve(process.env.APP_DATA_DIR || path.join(repoRoot, "data"));
}

export function getDefaultBackupDir(): string {
  return path.resolve(process.env.APP_BACKUP_DIR || path.join(repoRoot, "backups"));
}

export interface BackupFileEntry {
  name: string;
  size: number;
  sha256: string;
}

export interface BackupManifest {
  version: number;
  timestamp: string;
  sourceDataDir: string;
  files: BackupFileEntry[];
}

export interface CreateBackupResult {
  ok: boolean;
  timestamp: string;
  backupDir: string;
  manifest: BackupManifest;
  errors: string[];
}

export interface RestoreBackupResult {
  ok: boolean;
  restoredFiles: string[];
  errors: string[];
}

function computeSha256(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest("hex");
}

function vacuumSnapshot(sourceDbPath: string, targetDbPath: string): void {
  if (!fs.existsSync(sourceDbPath)) return;

  const tempTarget = `${targetDbPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (fs.existsSync(tempTarget)) {
    try {
      fs.unlinkSync(tempTarget);
    } catch {}
  }

  let db: Database.Database | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      db = new Database(sourceDbPath, { timeout: 3000 });
      db.prepare("VACUUM INTO ?").run(path.resolve(tempTarget));
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    } finally {
      if (db) {
        try {
          db.close();
        } catch {}
        db = null;
      }
    }
  }

  if (lastErr) {
    if (fs.existsSync(tempTarget)) {
      try {
        fs.unlinkSync(tempTarget);
      } catch {}
    }
    throw lastErr;
  }

  fs.mkdirSync(path.dirname(targetDbPath), { recursive: true });
  if (fs.existsSync(targetDbPath)) {
    fs.unlinkSync(targetDbPath);
  }
  fs.renameSync(tempTarget, targetDbPath);
}

export function createBackupSnapshot(options?: {
  dataDir?: string;
  backupDir?: string;
}): CreateBackupResult {
  const dataDir = path.resolve(options?.dataDir || getDefaultDataDir());
  const backupDir = path.resolve(options?.backupDir || getDefaultBackupDir());
  const databasesDir = path.join(backupDir, "databases");
  const errors: string[] = [];

  fs.mkdirSync(backupDir, { recursive: true });
  fs.mkdirSync(databasesDir, { recursive: true });

  const files: BackupFileEntry[] = [];

  // 1. Backup settings.json
  const settingsSrc = process.env.APP_CONFIG_PATH || path.join(dataDir, "settings.json");
  const settingsDest = path.join(backupDir, "settings.json");
  try {
    if (fs.existsSync(settingsSrc)) {
      fs.copyFileSync(settingsSrc, settingsDest);
    } else {
      // Fallback: dump current in-memory secrets if file doesn't exist yet
      const current = getSettingsSecrets();
      fs.writeFileSync(settingsDest, JSON.stringify(current, null, 2), "utf8");
    }
    files.push({
      name: "settings.json",
      size: fs.statSync(settingsDest).size,
      sha256: computeSha256(settingsDest),
    });
  } catch (err) {
    errors.push(`Failed to backup settings.json: ${(err as Error).message}`);
  }

  // 2. Backup SQLite databases via VACUUM INTO
  const sqliteFiles = ["proxies.sqlite3", "fleet.sqlite3", "antigravity-rotation.sqlite3"];
  for (const name of sqliteFiles) {
    const srcPath = path.join(dataDir, name);
    const destPath = path.join(databasesDir, name);
    if (!fs.existsSync(srcPath)) continue;

    try {
      vacuumSnapshot(srcPath, destPath);
      files.push({
        name: `databases/${name}`,
        size: fs.statSync(destPath).size,
        sha256: computeSha256(destPath),
      });
    } catch (err) {
      errors.push(`Failed to backup database ${name}: ${(err as Error).message}`);
    }
  }

  // 3. Backup 9Router / rotator state files if present
  const stateFiles = ["antigravity-rotator.json", "pool-state.json"];
  for (const name of stateFiles) {
    const srcPath = path.join(dataDir, name);
    const destPath = path.join(backupDir, name);
    if (fs.existsSync(srcPath)) {
      try {
        fs.copyFileSync(srcPath, destPath);
        files.push({
          name,
          size: fs.statSync(destPath).size,
          sha256: computeSha256(destPath),
        });
      } catch (err) {
        errors.push(`Failed to backup ${name}: ${(err as Error).message}`);
      }
    }
  }

  // 4. Generate manifest.json
  const timestamp = new Date().toISOString();
  const manifest: BackupManifest = {
    version: 1,
    timestamp,
    sourceDataDir: dataDir,
    files,
  };

  const manifestPath = path.join(backupDir, "manifest.json");
  try {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    files.push({
      name: "manifest.json",
      size: fs.statSync(manifestPath).size,
      sha256: computeSha256(manifestPath),
    });
  } catch (err) {
    errors.push(`Failed to write manifest.json: ${(err as Error).message}`);
  }

  return {
    ok: errors.length === 0,
    timestamp,
    backupDir,
    manifest,
    errors,
  };
}

export function restoreBackup(options?: {
  backupDir?: string;
  dataDir?: string;
}): RestoreBackupResult {
  const dataDir = path.resolve(options?.dataDir || getDefaultDataDir());
  const backupDir = path.resolve(options?.backupDir || getDefaultBackupDir());
  const databasesDir = path.join(backupDir, "databases");
  const restoredFiles: string[] = [];
  const errors: string[] = [];

  fs.mkdirSync(dataDir, { recursive: true });

  // 1. Restore settings.json
  const settingsBackup = path.join(backupDir, "settings.json");
  const settingsDest = process.env.APP_CONFIG_PATH || path.join(dataDir, "settings.json");
  if (fs.existsSync(settingsBackup)) {
    try {
      fs.copyFileSync(settingsBackup, settingsDest);
      restoredFiles.push("settings.json");
    } catch (err) {
      errors.push(`Failed to restore settings.json: ${(err as Error).message}`);
    }
  }

  // 2. Restore SQLite databases
  if (fs.existsSync(databasesDir)) {
    const files = fs.readdirSync(databasesDir).filter((f) => f.endsWith(".sqlite3"));
    for (const name of files) {
      const src = path.join(databasesDir, name);
      const dest = path.join(dataDir, name);
      try {
        // Clean WAL and SHM to prevent SQLite corruption on restored DB
        const walPath = `${dest}-wal`;
        const shmPath = `${dest}-shm`;
        if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
        if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);

        fs.copyFileSync(src, dest);
        restoredFiles.push(`databases/${name}`);
      } catch (err) {
        errors.push(`Failed to restore database ${name}: ${(err as Error).message}`);
      }
    }
  }

  // 3. Restore rotator / pool state JSON if exists
  const stateFiles = ["antigravity-rotator.json", "pool-state.json"];
  for (const name of stateFiles) {
    const src = path.join(backupDir, name);
    const dest = path.join(dataDir, name);
    if (fs.existsSync(src)) {
      try {
        fs.copyFileSync(src, dest);
        restoredFiles.push(name);
      } catch (err) {
        errors.push(`Failed to restore ${name}: ${(err as Error).message}`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    restoredFiles,
    errors,
  };
}
