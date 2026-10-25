import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import {
  createBackupSnapshot,
  getDefaultBackupDir,
  repoRoot,
  type CreateBackupResult,
} from "./backup-service.js";

const execFileAsync = promisify(execFile);

export interface GitSyncResult {
  ok: boolean;
  changed: boolean;
  committed: boolean;
  commitSha?: string;
  pushed: boolean;
  pushError?: string;
  error?: string;
}

export interface BackupSyncStatus {
  lastBackupTime: string | null;
  lastCommitSha: string | null;
  lastCommitMessage: string | null;
  hasUncommittedChanges: boolean;
  isSyncing: boolean;
  lastSyncError: string | null;
  remoteConfigured: boolean;
  backupFileCount: number;
}

class AsyncMutex {
  private queue = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }
}

const gitMutex = new AsyncMutex();
let isCurrentlySyncing = false;
let lastSyncError: string | null = null;

async function runGit(args: string[], cwd = repoRoot): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    timeout: 30000,
  });
}

export async function hasGitRemote(): Promise<boolean> {
  try {
    const { stdout } = await runGit(["remote"]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function syncBackupToGit(options?: {
  backupDir?: string;
  push?: boolean;
}): Promise<GitSyncResult> {
  return gitMutex.run(async () => {
    isCurrentlySyncing = true;
    lastSyncError = null;

    const backupDir = path.resolve(options?.backupDir || getDefaultBackupDir());
    const relBackupDir = path.relative(repoRoot, backupDir).replace(/\\/g, "/");

    try {
      // 1. Check if git repo exists
      const isRepo = fs.existsSync(path.join(repoRoot, ".git"));
      if (!isRepo) {
        return {
          ok: false,
          changed: false,
          committed: false,
          pushed: false,
          error: "Not a git repository",
        };
      }

      // 2. Check for changes in backupDir
      const { stdout: statusOut } = await runGit(["status", "--porcelain", relBackupDir]);
      const changed = statusOut.trim().length > 0;

      if (!changed) {
        return {
          ok: true,
          changed: false,
          committed: false,
          pushed: false,
        };
      }

      // 3. Stage backup files
      await runGit(["add", relBackupDir]);

      // 4. Commit
      const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);
      const commitMsg = `backup(9router): sync config and db [${timestamp}]`;
      const { stdout: commitOut } = await runGit(["commit", "-m", commitMsg]);

      // Get latest commit sha
      const { stdout: shaOut } = await runGit(["rev-parse", "--short", "HEAD"]);
      const commitSha = shaOut.trim();

      // 5. Push if requested or if remote configured
      let pushed = false;
      let pushError: string | undefined;

      const shouldPush = options?.push ?? true;
      if (shouldPush) {
        const remoteExists = await hasGitRemote();
        if (remoteExists) {
          try {
            await runGit(["push"]);
            pushed = true;
          } catch (pushErr) {
            pushError = (pushErr as Error).message || "Git push failed";
            // Do not fail entire operation on push error (e.g. offline)
          }
        }
      }

      return {
        ok: true,
        changed: true,
        committed: true,
        commitSha,
        pushed,
        pushError,
      };
    } catch (err) {
      const errMsg = (err as Error).message || "Git sync error";
      lastSyncError = errMsg;
      return {
        ok: false,
        changed: false,
        committed: false,
        pushed: false,
        error: errMsg,
      };
    } finally {
      isCurrentlySyncing = false;
    }
  });
}

export async function getBackupSyncStatus(options?: {
  backupDir?: string;
}): Promise<BackupSyncStatus> {
  const backupDir = path.resolve(options?.backupDir || getDefaultBackupDir());
  const relBackupDir = path.relative(repoRoot, backupDir).replace(/\\/g, "/");

  let lastBackupTime: string | null = null;
  let lastCommitSha: string | null = null;
  let lastCommitMessage: string | null = null;
  let hasUncommittedChanges = false;
  let remoteConfigured = false;
  let backupFileCount = 0;

  // Check manifest for backup timestamp
  const manifestPath = path.join(backupDir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    try {
      const content = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      lastBackupTime = content.timestamp || null;
    } catch {}
  }

  // Count files
  if (fs.existsSync(backupDir)) {
    const countFiles = (dir: string): number => {
      let count = 0;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) count += 1;
        else if (entry.isDirectory()) count += countFiles(path.join(dir, entry.name));
      }
      return count;
    };
    backupFileCount = countFiles(backupDir);
  }

  try {
    const isRepo = fs.existsSync(path.join(repoRoot, ".git"));
    if (isRepo) {
      remoteConfigured = await hasGitRemote();

      // Check uncommitted changes
      const { stdout: statusOut } = await runGit(["status", "--porcelain", relBackupDir]);
      hasUncommittedChanges = statusOut.trim().length > 0;

      // Last commit affecting backups
      const { stdout: logOut } = await runGit([
        "log",
        "-1",
        "--format=%h|%s|%cI",
        "--",
        relBackupDir,
      ]);
      const logLine = logOut.trim();
      if (logLine) {
        const [sha, msg, date] = logLine.split("|");
        lastCommitSha = sha || null;
        lastCommitMessage = msg || null;
        if (!lastBackupTime && date) {
          lastBackupTime = date;
        }
      }
    }
  } catch {}

  return {
    lastBackupTime,
    lastCommitSha,
    lastCommitMessage,
    hasUncommittedChanges,
    isSyncing: isCurrentlySyncing,
    lastSyncError,
    remoteConfigured,
    backupFileCount,
  };
}

export async function triggerFullBackupAndSync(options?: {
  dataDir?: string;
  backupDir?: string;
  push?: boolean;
}): Promise<{
  backup: CreateBackupResult;
  git: GitSyncResult;
}> {
  const backup = createBackupSnapshot({
    dataDir: options?.dataDir,
    backupDir: options?.backupDir,
  });

  const git = await syncBackupToGit({
    backupDir: options?.backupDir,
    push: options?.push,
  });

  return { backup, git };
}
