import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareDev } from "./dev-stop.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
prepareDev({ quiet: false });

const child = spawn(process.execPath, ["--import", "tsx", "src/server/server.ts"], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
