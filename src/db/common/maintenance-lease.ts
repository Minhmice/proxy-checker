import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type DataLeaseMode = "application" | "maintenance";

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
    if (!Number.isInteger(ownerPid) || processIsAlive(ownerPid)) {
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
  fs.writeFileSync(path.join(leaseDir, "owner"), `${mode}\n${process.pid}\n`, {
    encoding: "utf8",
  });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      process.removeListener("exit", release);
      fs.rmSync(leaseDir, { recursive: true, force: true });
    } catch {
      // ignore errors during cleanup
    }
  };
  process.once("exit", release);
  return release;
}
