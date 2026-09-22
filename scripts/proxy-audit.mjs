#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SENSITIVE_URL_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/@\s]+)@/g;

function sanitizeText(text) {
  if (typeof text !== "string") {
    return String(text ?? "");
  }
  return text.replace(SENSITIVE_URL_PATTERN, (_match, prefix, userinfo) => {
    const colonIndex = userinfo.indexOf(":");
    if (colonIndex === -1) {
      return `${prefix}${userinfo}:********@`;
    }
    const username = userinfo.slice(0, colonIndex);
    return `${prefix}${username}:********@`;
  });
}

try {
  const { register } = await import("tsx/esm/api");
  register();
  const { runCli } = await import("../src/auditor/cli/index.js");
  const outcome = await runCli(process.argv.slice(2));
  if (outcome.stdout) {
    process.stdout.write(`${outcome.stdout}\n`);
  }
  if (outcome.stderr) {
    process.stderr.write(`${outcome.stderr}\n`);
  }
  process.exit(outcome.exitCode);
} catch {
  // Fall back to spawned tsx re-exec if direct tsx registration fails
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
    const tsxPath = pathToFileURL(fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url))).href;
    const child = spawn(
      process.execPath,
      ["--import", tsxPath, scriptPath, ...process.argv.slice(2)],
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
}
