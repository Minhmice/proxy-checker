import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initAppConfig, getSettingsPublic } from "../src/server/app-config.js";

test("app-config includes Antigravity rotator settings with sensible defaults", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-config-test-"));
  const originalPath = process.env.APP_CONFIG_PATH;
  const originalActiveLimit = process.env.ANTIGRAVITY_ACTIVE_LIMIT;
  process.env.APP_CONFIG_PATH = path.join(tmpDir, "settings.json");
  delete process.env.ANTIGRAVITY_ACTIVE_LIMIT;
  try {
    initAppConfig();
    const pub = getSettingsPublic().settings;
    assert.equal(typeof pub.antigravityRotatorEnabled, "boolean");
    assert.equal(pub.antigravityActiveLimit, 3);
    assert.equal(pub.antigravityRotateMinutes, 10);
    assert.equal(pub.antigravitySessionThreshold, 20);
  } finally {
    process.env.APP_CONFIG_PATH = originalPath;
    if (originalActiveLimit !== undefined) {
      process.env.ANTIGRAVITY_ACTIVE_LIMIT = originalActiveLimit;
    } else {
      delete process.env.ANTIGRAVITY_ACTIVE_LIMIT;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});
