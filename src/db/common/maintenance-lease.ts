import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type DataLeaseMode = "application" | "maintenance";

export const LEASE_HEARTBEAT_MS = 15_000;
// ponytail: event loop blocked > 2 min lets a second instance steal the lease; raise if seen.
export const LEASE_STALE_MS = 120_000;

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "win32") {
    try {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      return /node\.exe/i.test(out);
    } catch {
      return false;
    }
  }
  if (process.platform === "linux") {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      return cmd.includes("node") || cmd.includes("tsx");
    } catch {
      return false;
    }
  }
  return true;
}

export function acquireDataLease(dataDir: string, mode: DataLeaseMode): () => void {
  fs.mkdirSync(dataDir, { recursive: true });
  const leaseDir = path.join(dataDir, ".proxy-checker.lease");
  try {
    fs.mkdirSync(leaseDir);
  } catch (error) {
    const ownerPath = path.join(leaseDir, "owner");
    const owner = fs.existsSync(ownerPath)
      ? fs.readFileSync(ownerPath, "utf8").trim().split(/\s+/)
      : [];
    const ownerMode = owner[0];
    const ownerPid = Number(owner[1]);
    // Crash leaves the owner file behind and the OS may hand its PID to another node
    // process; a live owner refreshes mtime, so a stale heartbeat means dead owner.
    const heartbeatFresh =
      fs.existsSync(ownerPath) && Date.now() - fs.statSync(ownerPath).mtimeMs < LEASE_STALE_MS;
    if (!Number.isInteger(ownerPid) || (heartbeatFresh && processIsAlive(ownerPid))) {
      throw new Error(
        mode === "maintenance"
          ? `Data directory is in use; stop application writers before maintenance: ${dataDir}`
          : ownerMode === "maintenance"
            ? `Data directory is under maintenance: ${dataDir}`
            : `Data directory is locked by another running application instance (PID ${ownerPid}): ${dataDir}`,
        { cause: error },
      );
    }
    fs.rmSync(leaseDir, { recursive: true, force: true });
    fs.mkdirSync(leaseDir);
  }
  const ownerFile = path.join(leaseDir, "owner");
  fs.writeFileSync(ownerFile, `${mode}\n${process.pid}\n`, { encoding: "utf8" });
  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(ownerFile, now, now);
    } catch {
      // lease dir removed externally; nothing to refresh
    }
  }, LEASE_HEARTBEAT_MS);
  heartbeat.unref();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      clearInterval(heartbeat);
      process.removeListener("exit", release);
      fs.rmSync(leaseDir, { recursive: true, force: true });
    } catch {
      // ignore errors during cleanup
    }
  };
  process.once("exit", release);
  return release;
}
