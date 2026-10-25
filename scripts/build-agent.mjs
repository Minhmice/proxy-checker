#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const targets = [
  { os: "linux", arch: "amd64", output: "bin/proxyfleet-agent-linux-amd64" },
  { os: "linux", arch: "arm64", output: "bin/proxyfleet-agent-linux-arm64" },
  { os: "linux", arch: "arm", arm: "7", output: "bin/proxyfleet-agent-linux-armv7" },
  { os: "windows", arch: "amd64", output: "bin/proxyfleet-agent.exe" },
];

fs.mkdirSync(path.resolve("bin"), { recursive: true });

for (const t of targets) {
  const armSuffix = t.arm ? ` (v${t.arm})` : "";
  console.log(`[build-agent] Building ${t.os}/${t.arch}${armSuffix} -> ${t.output}...`);
  const env = { ...process.env, GOOS: t.os, GOARCH: t.arch, CGO_ENABLED: "0" };
  if (t.arm) env.GOARM = t.arm;
  else delete env.GOARM;

  const res = spawnSync(
    "go",
    [
      "build",
      "-trimpath",
      "-ldflags=-s -w",
      "-o",
      path.resolve(t.output),
      "./cmd/proxyfleet-agent",
    ],
    {
      cwd: path.resolve("agent"),
      env,
      stdio: "inherit",
    },
  );

  if (res.status !== 0) {
    console.error(`[build-agent] Failed to compile ${t.output} (exit code ${res.status})`);
    process.exit(res.status || 1);
  }
}

console.log("[build-agent] All agent targets compiled successfully.");
