import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("backup sync reports rejected push without losing committed backup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backup-git-push-"));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  const other = path.join(root, "other");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    fs.mkdirSync(repo);
    git(root, "init", "--bare", remote);
    git(repo, "init");
    git(repo, "config", "user.name", "Backup Test");
    git(repo, "config", "user.email", "backup@example.test");
    fs.writeFileSync(path.join(repo, "initial"), "initial");
    git(repo, "add", "initial");
    git(repo, "commit", "-m", "initial");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-u", "origin", "HEAD");
    git(root, "clone", remote, other);
    git(other, "config", "user.name", "Backup Test");
    git(other, "config", "user.email", "backup@example.test");
    fs.writeFileSync(path.join(other, "remote-change"), "remote");
    git(other, "add", "remote-change");
    git(other, "commit", "-m", "remote change");
    git(other, "push");

    const source = path.resolve("src/server");
    fs.mkdirSync(path.join(repo, "src/server/backup"), { recursive: true });
    for (const file of ["backup/git-sync.ts", "backup/backup-service.ts", "fs-atomic.ts"]) {
      fs.copyFileSync(path.join(source, file), path.join(repo, "src/server", file));
    }
    fs.symlinkSync(path.resolve("node_modules"), path.join(repo, "node_modules"), "junction");
    // Load the copied module so its repository root is the isolated test repository.
    const { syncBackupToGit, getBackupSyncStatus } = await import(
      pathToFileURL(path.join(repo, "src/server/backup/git-sync.ts")).href
    );
    const backupDir = path.join(repo, "backups");
    fs.mkdirSync(backupDir);
    fs.writeFileSync(path.join(backupDir, "snapshot.json"), "{}");
    const result = await syncBackupToGit({ backupDir });
    assert.equal(result.ok, false);
    assert.equal(result.changed, true);
    assert.equal(result.committed, true);
    assert.equal(result.pushed, false);
    assert.equal(result.commitSha, git(repo, "rev-parse", "--short", "HEAD"));
    assert.ok(result.error);
    assert.equal(result.pushError, result.error);
    assert.equal((await getBackupSyncStatus({ backupDir })).lastSyncError, result.error);

    const cleanNoPush = await syncBackupToGit({ backupDir, push: false });
    assert.equal(cleanNoPush.ok, true);
    assert.equal(cleanNoPush.changed, false);
    assert.equal(cleanNoPush.committed, false);
    assert.equal(cleanNoPush.pushed, false);

    const rejectedRetry = await syncBackupToGit({ backupDir });
    assert.equal(rejectedRetry.ok, false);
    assert.equal(rejectedRetry.changed, false);
    assert.equal(rejectedRetry.committed, false);
    assert.equal(rejectedRetry.pushed, false);
    assert.ok(rejectedRetry.pushError);
    assert.equal(rejectedRetry.error, rejectedRetry.pushError);
    assert.equal((await getBackupSyncStatus({ backupDir })).lastSyncError, rejectedRetry.error);

    const commit = git(repo, "rev-parse", "HEAD");
    git(remote, "update-ref", git(remote, "symbolic-ref", "HEAD"), git(repo, "rev-parse", "HEAD^"));
    const retry = await syncBackupToGit({ backupDir });
    assert.equal(retry.ok, true);
    assert.equal(retry.changed, false);
    assert.equal(retry.committed, false);
    assert.equal(retry.commitSha, undefined);
    assert.equal(retry.pushed, true);
    assert.equal(git(repo, "rev-parse", "HEAD"), commit);
    assert.equal(git(remote, "rev-parse", "HEAD"), commit);
    assert.equal((await getBackupSyncStatus({ backupDir })).lastSyncError, null);

    fs.writeFileSync(path.join(backupDir, "snapshot.json"), '{"next":true}');
    const noPush = await syncBackupToGit({ backupDir, push: false });
    assert.equal(noPush.ok, true);
    assert.equal(noPush.committed, true);
    assert.equal(noPush.pushed, false);
    assert.equal((await getBackupSyncStatus({ backupDir })).lastSyncError, null);
    git(repo, "remote", "remove", "origin");
    const cleanNoRemote = await syncBackupToGit({ backupDir });
    assert.equal(cleanNoRemote.ok, true);
    assert.equal(cleanNoRemote.changed, false);
    assert.equal(cleanNoRemote.committed, false);
    assert.equal(cleanNoRemote.pushed, false);
    fs.writeFileSync(path.join(backupDir, "snapshot.json"), '{"next":2}');
    const noRemote = await syncBackupToGit({ backupDir });
    assert.equal(noRemote.ok, true);
    assert.equal(noRemote.committed, true);
    assert.equal(noRemote.pushed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
