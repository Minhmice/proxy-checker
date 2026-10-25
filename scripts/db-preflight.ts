import fs from "node:fs";
import path from "node:path";
import { acquireDataLease } from "../src/db/common/maintenance-lease.js";
import { preflightAndBackupDatabase } from "../src/db/common/sqlite.js";

if (!process.argv[2] || !process.argv[3]) {
  throw new Error("Usage: npm run db:preflight -- <stopped-data-dir> <new-backup-dir>");
}
const dataDir = path.resolve(process.argv[2]);
const backupDir = path.resolve(process.argv[3]);
if (dataDir === backupDir) throw new Error("Backup directory must differ from source directory");
const release = acquireDataLease(dataDir, "maintenance");
try {
  fs.mkdirSync(backupDir, { recursive: true });
  for (const file of ["proxies.sqlite3", "fleet.sqlite3", "antigravity-rotation.sqlite3"]) {
    preflightAndBackupDatabase(path.join(dataDir, file), path.join(backupDir, file));
    console.log(`Backed up and verified ${file}`);
  }
} finally {
  release();
}
