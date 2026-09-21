import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockFile = path.join(root, ".next", "dev", "lock");
const envFile = path.join(root, ".env");
const serverNeedle = "src/server/server.ts";

function readPort() {
  const fallback = 1300;
  if (!fs.existsSync(envFile)) return fallback;
  const match = fs.readFileSync(envFile, "utf8").replace(/^\uFEFF/, "").match(/^\s*PORT=(\d+)\s*$/m);
  return match ? Number(match[1]) : fallback;
}

function killPid(pid, quiet) {
  if (!pid || !/^\d+$/.test(pid)) return false;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
    } else {
      process.kill(Number(pid), "SIGTERM");
    }
    if (!quiet) console.log(`Stopped proxy-checker (pid ${pid})`);
    return true;
  } catch {
    return false;
  }
}

function pidsOnPort(port) {
  if (process.platform === "win32") {
    try {
      const out = execSync("netstat -ano", { encoding: "utf8" });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        if (!line.includes("LISTENING")) continue;
        if (!new RegExp(`:${port}\\s`).test(line)) continue;
        const pid = line.trim().split(/\s+/).at(-1);
        if (pid && pid !== "0") pids.add(pid);
      }
      return [...pids];
    } catch {
      return [];
    }
  }

  try {
    const out = execSync(`lsof -ti tcp:${port}`, { encoding: "utf8" });
    return out.split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

function projectServerPids() {
  if (process.platform !== "win32") {
    try {
      const out = execSync(`pgrep -f "${serverNeedle}"`, { encoding: "utf8" });
      return out.split(/\s+/).filter(Boolean);
    } catch {
      return [];
    }
  }

  try {
    const psCmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name = 'node.exe'\\" | Where-Object { $_.CommandLine -like '*${serverNeedle}*' } | Select-Object -ExpandProperty ProcessId"`;
    const out = execSync(psCmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const pids = out.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
    if (pids.length) return pids;
  } catch {
    // fallback if PowerShell is unavailable
  }

  try {
    const out = execSync('wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:csv', {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pids = [];
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes(serverNeedle)) continue;
      const pid = line.split(",").at(-1)?.trim();
      if (pid && /^\d+$/.test(pid)) pids.push(pid);
    }
    return pids;
  } catch {
    return [];
  }
}

function removeLock(quiet) {
  try {
    fs.unlinkSync(lockFile);
    if (!quiet) console.log("Removed stale .next/dev/lock");
    return true;
  } catch {
    return false;
  }
}

export function prepareDev({ quiet = false } = {}) {
  const seen = new Set();
  for (const pid of projectServerPids()) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    killPid(pid, quiet);
  }

  const port = readPort();
  for (const legacyPort of new Set([port, 13000])) {
    for (const pid of pidsOnPort(legacyPort)) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      killPid(pid, quiet);
    }
  }

  removeLock(quiet);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  prepareDev({ quiet: false });
}
