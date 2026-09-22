#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const SENSITIVE_URL_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/@\s]+)@/g;

function sanitizeText(text) {
  if (typeof text !== "string") {
    return String(text ?? "");
  }
  return text.replace(SENSITIVE_URL_PATTERN, "$1[REDACTED]@");
}

if (process.env.PROXY_AUDITOR_CLI_REEXEC === "1") {
  const { runCli } = await import("../src/auditor/cli/index.js");
  try {
    const outcome = await runCli(process.argv.slice(2));
    if (outcome.stdout) {
      process.stdout.write(`${outcome.stdout}\n`);
    }
    if (outcome.stderr) {
      process.stderr.write(`${outcome.stderr}\n`);
    }
    process.exit(outcome.exitCode);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Fatal CLI error";
    process.stderr.write(`${sanitizeText(message)}\n`);
    process.exit(1);
  }
} else {
  const scriptPath = fileURLToPath(import.meta.url);
  const require = createRequire(import.meta.url);
  let tsxImportTarget = "tsx";
  try {
    const resolvedTsx = require.resolve("tsx");
    tsxImportTarget = pathToFileURL(resolvedTsx).href;
  } catch {
    // Fall back to package name
  }

  const child = spawn(
    process.execPath,
    ["--import", tsxImportTarget, scriptPath, ...process.argv.slice(2)],
    {
      stdio: ["inherit", "pipe", "pipe"],
      env: {
        ...process.env,
        PROXY_AUDITOR_CLI_REEXEC: "1",
      },
    },
  );

  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    process.stdout.write(sanitizeText(chunk));
  });

  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    process.stderr.write(sanitizeText(chunk));
  });

  child.on("error", (err) => {
    process.stderr.write(`${sanitizeText(err.message)}\n`);
    process.exit(1);
  });

  child.on("close", (code) => {
    process.exit(code ?? 1);
  });
}
