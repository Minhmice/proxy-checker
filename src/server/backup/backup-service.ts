import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { replaceFileAtomicSync, writeJsonAtomicSync } from "../fs-atomic.js";
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
  warnings: string[];
}

function computeSha256(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const fd = fs.openSync(filePath, "r");
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function vacuumSnapshot(sourceDbPath: string, targetDbPath: string): void {
  if (!fs.existsSync(sourceDbPath)) throw new Error(`Database not found: ${sourceDbPath}`);

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tempTarget = `${targetDbPath}.tmp-${crypto.randomUUID()}`;
    let db: Database.Database | null = null;
    let completed = false;
    try {
      db = new Database(sourceDbPath, { readonly: true, timeout: 3000, fileMustExist: true });
      db.prepare("VACUUM INTO ?").run(path.resolve(tempTarget));
      completed = true;
    } catch (err) {
      lastErr = err;
    } finally {
      if (db) {
        try {
          db.close();
        } catch {}
      }
      if (!completed) {
        try {
          fs.unlinkSync(tempTarget);
        } catch {}
      }
    }

    if (completed) {
      try {
        fs.mkdirSync(path.dirname(targetDbPath), { recursive: true });
        replaceFileAtomicSync(tempTarget, targetDbPath);
      } finally {
        try {
          fs.unlinkSync(tempTarget);
        } catch {}
      }
      return;
    }
    if (attempt < 2) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  throw lastErr;
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

  const settingsSrc = process.env.APP_CONFIG_PATH || path.join(dataDir, "settings.json");
  const settingsDest = path.join(backupDir, "settings.json");
  try {
    if (fs.existsSync(settingsSrc)) {
      fs.copyFileSync(settingsSrc, settingsDest);
    } else {
      throw new Error(`Settings file not found: ${settingsSrc}`);
    }
    files.push({
      name: "settings.json",
      size: fs.statSync(settingsDest).size,
      sha256: computeSha256(settingsDest),
    });
  } catch (err) {
    errors.push(`Failed to backup settings.json: ${(err as Error).message}`);
  }

  const sqliteFiles = ["antigravity-rotation.sqlite3", "router-sync.sqlite3"];
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

  const stateFiles = ["antigravity-rotator.json"];
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

  const timestamp = new Date().toISOString();
  const manifest: BackupManifest = {
    version: 1,
    timestamp,
    sourceDataDir: dataDir,
    files,
  };

  const manifestPath = path.join(backupDir, "manifest.json");
  if (errors.length === 0) {
    try {
      writeJsonAtomicSync(manifestPath, manifest);
    } catch (err) {
      errors.push(`Failed to write manifest.json: ${(err as Error).message}`);
    }
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
  const warnings: string[] = [];
  const manifestPath = path.join(backupDir, "manifest.json");
  const payloads: Record<string, string> = {
    "settings.json": path.join(backupDir, "settings.json"),
    "databases/antigravity-rotation.sqlite3": path.join(
      databasesDir,
      "antigravity-rotation.sqlite3",
    ),
    "databases/router-sync.sqlite3": path.join(databasesDir, "router-sync.sqlite3"),
    "antigravity-rotator.json": path.join(backupDir, "antigravity-rotator.json"),
  };
  try {
    let manifestExists = true;
    try {
      fs.lstatSync(manifestPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      manifestExists = false;
    }
    if (!manifestExists) {
      warnings.push("Legacy backup has no manifest; payload integrity cannot be verified.");
    } else {
      const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (
        !manifest ||
        typeof manifest !== "object" ||
        (manifest as BackupManifest).version !== 1 ||
        !Array.isArray((manifest as BackupManifest).files)
      ) {
        throw new Error("Invalid or unsupported backup manifest");
      }
      const listed = new Map<string, BackupFileEntry>();
      for (const entry of (manifest as BackupManifest).files) {
        if (
          !entry ||
          typeof entry !== "object" ||
          typeof entry.name !== "string" ||
          !Object.hasOwn(payloads, entry.name) ||
          listed.has(entry.name) ||
          !Number.isSafeInteger(entry.size) ||
          entry.size < 0 ||
          typeof entry.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(entry.sha256)
        ) {
          throw new Error("Invalid or duplicate manifest payload entry");
        }
        listed.set(entry.name, entry);
      }
      for (const [name, payloadPath] of Object.entries(payloads)) {
        let stat: fs.Stats | undefined;
        try {
          stat = fs.lstatSync(payloadPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        const entry = listed.get(name);
        if (!entry) {
          if (stat) throw new Error(`Unlisted restore payload: ${name}`);
          continue;
        }
        if (!stat?.isFile()) throw new Error(`Missing or invalid restore payload: ${name}`);
        if (name.startsWith("databases/") && !fs.lstatSync(databasesDir).isDirectory()) {
          throw new Error("Invalid databases directory");
        }
        if (stat.size !== entry.size) throw new Error(`Size mismatch for restore payload: ${name}`);
        if (computeSha256(payloadPath) !== entry.sha256)
          throw new Error(`SHA-256 mismatch for restore payload: ${name}`);
      }
    }
  } catch (err) {
    errors.push(`Backup manifest verification failed: ${(err as Error).message}`);
    return { ok: false, restoredFiles, errors, warnings };
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const databaseFiles = ["antigravity-rotation.sqlite3", "router-sync.sqlite3"].filter((name) =>
    fs.existsSync(path.join(databasesDir, name)),
  );

  const settingsBackup = path.join(backupDir, "settings.json");
  const settingsDest = process.env.APP_CONFIG_PATH || path.join(dataDir, "settings.json");
  if (fs.existsSync(settingsBackup)) {
    try {
      const stagingDir = fs.mkdtempSync(
        path.join(path.dirname(settingsDest), ".settings-restore-"),
      );
      try {
        const stagedSettings = path.join(stagingDir, "settings.json");
        fs.copyFileSync(settingsBackup, stagedSettings);
        replaceFileAtomicSync(stagedSettings, settingsDest);
      } finally {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      }
      restoredFiles.push("settings.json");
    } catch (err) {
      errors.push(`Failed to restore settings.json: ${(err as Error).message}`);
    }
  }

  for (const name of databaseFiles) {
    const src = path.join(databasesDir, name);
    const dest = path.join(dataDir, name);
    try {
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

  const stateFiles = ["antigravity-rotator.json"];
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
    warnings,
  };
}
