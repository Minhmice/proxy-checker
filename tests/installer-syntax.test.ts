import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

test("install-agent.sh passes bash syntax validation and includes required safeguards", () => {
  const scriptPath = path.resolve("scripts/install-agent.sh");
  assert.ok(fs.existsSync(scriptPath), "scripts/install-agent.sh must exist");

  const content = fs.readFileSync(scriptPath, "utf8");

  // Must contain bash strict mode
  assert.match(content, /set -euo pipefail/);

  // Must contain command arguments parsing
  assert.match(content, /--server/);
  assert.match(content, /--token/);

  // Must check for root/sudo
  assert.match(content, /EUID/);

  // Must detect architecture
  assert.match(content, /uname -m/);

  // Must configure systemd service
  assert.match(content, /proxyfleet-agent\.service/);

  // If bash is installed, verify syntax via bash -n
  try {
    execFileSync("bash", ["-n", "scripts/install-agent.sh"], { stdio: "pipe" });
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== "ENOENT") {
      assert.fail(`Bash syntax error in install-agent.sh: ${error.message}`);
    }
  }
});
