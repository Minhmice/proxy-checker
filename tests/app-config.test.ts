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

test("fleet overlay settings persist validated public configuration without private keys", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-settings-"));
  const savedPath = process.env.APP_CONFIG_PATH;
  const savedPassword = process.env.CONTROL_PASSWORD;
  process.env.APP_CONFIG_PATH = path.join(tmpDir, "settings.json");
  process.env.CONTROL_PASSWORD = "isolated-fleet-settings";
  try {
    initAppConfig();
    const configured = { interfaceName: "proxyfleet", controllerAddressCidr: "10.77.0.1/24", publicEndpoint: "vpn.example.test:51820", listenPort: 51820, mtu: null };
    updateSettings({ fleetWireguard: configured });
    initAppConfig();
    assert.deepEqual(getSettingsSecrets().fleetWireguard, configured);
    assert.throws(() => updateSettings({ fleetWireguard: { ...configured, interfaceName: "omp-pi" } }));
    assert.deepEqual(getSettingsSecrets().fleetWireguard, configured);
    updateSettings({ fleetWireguard: null });
    assert.equal(getSettingsSecrets().fleetWireguard, null);
  } finally {
    if (savedPath === undefined) delete process.env.APP_CONFIG_PATH;
    else process.env.APP_CONFIG_PATH = savedPath;
    if (savedPassword === undefined) delete process.env.CONTROL_PASSWORD;
    else process.env.CONTROL_PASSWORD = savedPassword;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
