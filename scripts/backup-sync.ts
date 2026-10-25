import { createBackupSnapshot, restoreBackup } from "../src/server/backup/backup-service.js";
import { getBackupSyncStatus, syncBackupToGit } from "../src/server/backup/git-sync.js";

const command = process.argv[2] || "backup";

async function main() {
  if (command === "status") {
    const status = await getBackupSyncStatus();
    console.log("=== 9Router Backup & Git Sync Status ===");
    console.log(`Last Backup Time    : ${status.lastBackupTime ?? "None"}`);
    console.log(`Last Commit SHA     : ${status.lastCommitSha ?? "None"}`);
    console.log(`Last Commit Message : ${status.lastCommitMessage ?? "None"}`);
    console.log(`Uncommitted Changes : ${status.hasUncommittedChanges ? "Yes" : "No"}`);
    console.log(`Remote Configured   : ${status.remoteConfigured ? "Yes" : "No"}`);
    console.log(`Backup Files Count  : ${status.backupFileCount}`);
    if (status.lastSyncError) {
      console.log(`Last Error          : ${status.lastSyncError}`);
    }
    return;
  }

  if (command === "restore") {
    console.log("Restoring backup from backups/ to data/ ...");
    const res = restoreBackup();
    if (!res.ok) {
      console.error("Restore encountered errors:", res.errors);
      process.exitCode = 1;
      return;
    }
    console.log("Restore complete. Restored files:", res.restoredFiles);
    return;
  }

  if (command === "backup" || command === "sync") {
    console.log("Creating backup snapshot in backups/ ...");
    const snap = createBackupSnapshot();
    if (!snap.ok) {
      console.error("Backup snapshot warnings/errors:", snap.errors);
    }
    console.log(`Snapshot complete. Files: ${snap.manifest.files.length}`);

    console.log("Syncing to Git repo ...");
    const git = await syncBackupToGit({ push: true });
    if (!git.ok) {
      console.error(`Git sync error: ${git.error}`);
      process.exitCode = 1;
      return;
    }
    if (git.changed) {
      console.log(`Committed changes: ${git.commitSha}`);
      if (git.pushed) console.log("Pushed to remote successfully.");
      else if (git.pushError) console.warn(`Remote push skipped/failed: ${git.pushError}`);
    } else {
      console.log("No changes detected in backups/. Git working tree is clean.");
    }
    return;
  }

  console.error(`Unknown command: ${command}. Use 'backup', 'restore', or 'status'.`);
  process.exitCode = 1;
}

void main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
