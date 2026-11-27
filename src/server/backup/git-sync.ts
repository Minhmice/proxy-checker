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

    const backupPathspec = `:(literal)${relBackupDir}`;
    try {
      const isRepo = fs.existsSync(path.join(repoRoot, ".git"));
      if (!isRepo) {
        lastSyncError = "Not a git repository";
        return {
          ok: false,
          changed: false,
          committed: false,
          pushed: false,
          error: lastSyncError,
        };
      }
      if (!relBackupDir || relBackupDir.startsWith("..") || path.isAbsolute(relBackupDir)) {
        lastSyncError = `Backup directory (${backupDir}) is outside repository or is the repository root (${repoRoot}); git sync requires a subdirectory`;
        return {
          ok: false,
          changed: false,
          committed: false,
          pushed: false,
          error: lastSyncError,
        };
      }

      const { stdout: statusOut } = await runGit(["status", "--porcelain", "--", backupPathspec]);
      const changed = statusOut.trim().length > 0;

      let commitSha: string | undefined;
      if (changed) {
        await runGit(["add", "--", backupPathspec]);

        const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);
        const commitMsg = `backup(9router): sync config and db [${timestamp}]`;
        await runGit(["commit", "--only", "-m", commitMsg, "--", backupPathspec]);

        const { stdout: shaOut } = await runGit(["rev-parse", "--short", "HEAD"]);
        commitSha = shaOut.trim();
      }

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
            lastSyncError = pushError;
          }
        }
      }

      return {
        ok: !pushError,
        changed,
        committed: changed,
        commitSha,
        pushed,
        pushError,
        error: pushError,
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
  const backupPathspec = `:(literal)${relBackupDir}`;

  let lastBackupTime: string | null = null;
  let lastCommitSha: string | null = null;
  let lastCommitMessage: string | null = null;
  let hasUncommittedChanges = false;
  let remoteConfigured = false;
  let backupFileCount = 0;

  const manifestPath = path.join(backupDir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    try {
      const content = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      lastBackupTime = content.timestamp || null;
    } catch {}
  }

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
    const isInsideRepo =
      !!relBackupDir && !relBackupDir.startsWith("..") && !path.isAbsolute(relBackupDir);
    if (isRepo && isInsideRepo) {
      remoteConfigured = await hasGitRemote();

      const { stdout: statusOut } = await runGit(["status", "--porcelain", "--", backupPathspec]);
      hasUncommittedChanges = statusOut.trim().length > 0;

      const { stdout: logOut } = await runGit([
        "log",
        "-1",
        "--format=%h|%s|%cI",
        "--",
        backupPathspec,
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
  if (!backup.ok) {
    return {
      backup,
      git: {
        ok: false,
        changed: false,
        committed: false,
        pushed: false,
        error: `Backup snapshot failed: ${backup.errors.join("; ")}`,
      },
    };
  }

  const git = await syncBackupToGit({
    backupDir: options?.backupDir,
    push: options?.push,
  });

  return { backup, git };
}
