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

test("app-config defaults invalid rotation intervals from settings files and preserves finite rounding and clamps", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-config-test-interval-"));
  const originalEnv = { ...process.env };
  const settingsPath = path.join(tmpDir, "settings.json");
  process.env.APP_CONFIG_PATH = settingsPath;

  try {
    for (const [value, expected] of [
      ['"15"', 10],
      ["null", 10],
      ["true", 10],
      ["{}", 10],
      ["1e999", 10],
      ["-1e999", 10],
      ["12.6", 13],
      ["0", 1],
      ["61", 60],
    ] as const) {
      fs.writeFileSync(
        settingsPath,
        `{"controlPassword":"stored-control","nineRouterPassword":"stored-router-password","antigravityRotatorEnabled":false,"antigravityRotateMinutes":${value}}`,
      );
      initAppConfig();
      const settings = getSettingsSecrets();
      assert.equal(settings.antigravityRotateMinutes, expected, value);
      assert.equal(settings.controlPassword, "stored-control");
      assert.equal(settings.nineRouterPassword, "stored-router-password");
      assert.equal(settings.antigravityRotatorEnabled, false);
    }
  } finally {
    for (const key of [
      "APP_CONFIG_PATH",
      "CONTROL_PASSWORD",
      "NINEROUTER_URL",
      "NINEROUTER_PASSWORD",
      "NINEROUTER_API_KEY",
      "ANTIGRAVITY_ROTATOR_ENABLED",
      "ANTIGRAVITY_ROTATE_MINUTES",
    ]) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
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

    updateSettings({ nineRouterUrl: "http://192.168.1.100:20128/" });
    assert.equal(getSettingsSecrets().nineRouterUrl, "http://192.168.1.100:20128");

    updateSettings({ nineRouterUrl: "100.79.102.99:20128" });
    assert.equal(getSettingsSecrets().nineRouterUrl, "http://100.79.102.99:20128");

    updateSettings({ nineRouterUrl: "   https://9router.example.com///   " });
    assert.equal(getSettingsSecrets().nineRouterUrl, "https://9router.example.com");

    updateSettings({ nineRouterUrl: "192.168.1.54, 9router.minhmice.com" });
    assert.equal(
      getSettingsSecrets().nineRouterUrl,
      "http://192.168.1.54, http://9router.minhmice.com",
    );
    assert.deepEqual(getSettingsPublic().settings.nineRouterUrls, [
      "http://192.168.1.54",
      "http://9router.minhmice.com",
    ]);

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

    assert.throws(() => updateSettings({ nineRouterUrl: "   " }), /cannot be empty/);

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
