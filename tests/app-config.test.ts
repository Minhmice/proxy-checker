import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initAppConfig, getSettingsSecrets, updateSettings } from "../src/server/app-config.js";

test("app-config enforces 1 to 1440 minutes for nineRouterSyncMinutes and supports nineRouterAutoSync toggle", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-config-test-"));
  const originalPath = process.env.APP_CONFIG_PATH;
  const originalControlPass = process.env.CONTROL_PASSWORD;
  process.env.APP_CONFIG_PATH = path.join(tmpDir, "settings.json");
  process.env.CONTROL_PASSWORD = "test-control-password";

  try {
    initAppConfig();
    updateSettings({ nineRouterSyncMinutes: 0 });
    assert.equal(getSettingsSecrets().nineRouterSyncMinutes, 1);

    updateSettings({ nineRouterSyncMinutes: 15 });
    assert.equal(getSettingsSecrets().nineRouterSyncMinutes, 15);

    updateSettings({ nineRouterSyncMinutes: 720 });
    assert.equal(getSettingsSecrets().nineRouterSyncMinutes, 720);

    updateSettings({ nineRouterAutoSync: false });
    assert.equal(getSettingsSecrets().nineRouterAutoSync, false);

    updateSettings({ nineRouterAutoSync: true });
    assert.equal(getSettingsSecrets().nineRouterAutoSync, true);
  } finally {
    if (originalPath !== undefined) {
      process.env.APP_CONFIG_PATH = originalPath;
    } else {
      delete process.env.APP_CONFIG_PATH;
    }
    if (originalControlPass !== undefined) {
      process.env.CONTROL_PASSWORD = originalControlPass;
    } else {
      delete process.env.CONTROL_PASSWORD;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});
