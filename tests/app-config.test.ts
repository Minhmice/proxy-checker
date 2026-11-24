import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initAppConfig,
  getSettingsSecrets,
  getSettingsPublic,
  getNineRouterUrls,
  updateSettings,
} from "../src/server/app-config.js";

test("app-config drops legacy proxy settings while retaining account rotation and credentials", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-config-test-"));
  const originalPath = process.env.APP_CONFIG_PATH;
  const originalControlPass = process.env.CONTROL_PASSWORD;
  const settingsPath = path.join(tmpDir, "settings.json");
  process.env.APP_CONFIG_PATH = settingsPath;
  process.env.CONTROL_PASSWORD = "test-control-password";
  const legacy = {
    nineRouterAutoSync: true,
    activePoolLimit: 50,
    nineRouterSyncMinutes: 60,
    checkConcurrency: 10,
    checkTimeoutMs: 6000,
    proxyTtlMinutes: 15,
    antigravityActiveLimit: 3,
    antigravitySessionThreshold: 20,
  };

  try {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        controlPassword: "stored-control",
        nineRouterUrl: "https://router.example",
        nineRouterPassword: "stored-router-password",
        nineRouterApiKey: "stored-api-key",
        antigravityRotatorEnabled: true,
        antigravityRotateMinutes: 10,
        ...legacy,
      }),
    );
    initAppConfig();
    assert.equal(getSettingsSecrets().nineRouterPassword, "stored-router-password");
    assert.equal(getSettingsSecrets().nineRouterApiKey, "stored-api-key");
    for (const key of Object.keys(legacy)) {
      assert.equal(Object.hasOwn(getSettingsSecrets(), key), false);
      assert.equal(Object.hasOwn(getSettingsPublic().settings, key), false);
    }

    updateSettings({ antigravityRotatorEnabled: false, antigravityRotateMinutes: 15 });
    const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    for (const key of Object.keys(legacy)) assert.equal(Object.hasOwn(saved, key), false);
    assert.equal(saved.controlPassword, "stored-control");
    assert.equal(saved.nineRouterPassword, "stored-router-password");
    assert.equal(saved.nineRouterApiKey, "stored-api-key");
    assert.equal(saved.antigravityRotatorEnabled, false);
    assert.equal(saved.antigravityRotateMinutes, 15);
  } finally {
    if (originalPath !== undefined) process.env.APP_CONFIG_PATH = originalPath;
    else delete process.env.APP_CONFIG_PATH;
    if (originalControlPass !== undefined) process.env.CONTROL_PASSWORD = originalControlPass;
    else delete process.env.CONTROL_PASSWORD;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("app-config normalizes, validates, and updates nineRouterUrl in settings", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-config-test-url-"));
  const originalPath = process.env.APP_CONFIG_PATH;
  const originalControlPass = process.env.CONTROL_PASSWORD;
  process.env.APP_CONFIG_PATH = path.join(tmpDir, "settings.json");
  process.env.CONTROL_PASSWORD = "test-control-password";

  try {
    initAppConfig();

    // Strips trailing slashes
    updateSettings({ nineRouterUrl: "http://192.168.1.100:20128/" });
    assert.equal(getSettingsSecrets().nineRouterUrl, "http://192.168.1.100:20128");

    // Auto-adds http:// if missing protocol
    updateSettings({ nineRouterUrl: "100.79.102.99:20128" });
    assert.equal(getSettingsSecrets().nineRouterUrl, "http://100.79.102.99:20128");

    // Trims whitespace and multiple trailing slashes
    updateSettings({ nineRouterUrl: "   https://9router.example.com///   " });
    assert.equal(getSettingsSecrets().nineRouterUrl, "https://9router.example.com");

    // Supports multiple comma-separated URLs and normalizes each
    updateSettings({ nineRouterUrl: "192.168.1.54, 9router.minhmice.com" });
    assert.equal(
      getSettingsSecrets().nineRouterUrl,
      "http://192.168.1.54, http://9router.minhmice.com",
    );
    assert.deepEqual(getSettingsPublic().settings.nineRouterUrls, [
      "http://192.168.1.54",
      "http://9router.minhmice.com",
    ]);

    // Supports mixed ports and protocols with deduplication
    updateSettings({
      nineRouterUrl:
        "http://192.168.1.54:20128, https://9router.minhmice.com, http://192.168.1.54:20128",
    });
    assert.equal(
      getSettingsSecrets().nineRouterUrl,
      "http://192.168.1.54:20128, https://9router.minhmice.com",
    );
    assert.deepEqual(getSettingsPublic().settings.nineRouterUrls, [
      "http://192.168.1.54:20128",
      "https://9router.minhmice.com",
    ]);

    // Rejects empty URL
    assert.throws(() => updateSettings({ nineRouterUrl: "   " }), /cannot be empty/);

    // Rejects unsupported protocol
    assert.throws(() => updateSettings({ nineRouterUrl: "ftp://example.com" }), /http or https/);
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
