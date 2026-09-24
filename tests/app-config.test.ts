import test from "node:test";
import assert from "node:assert/strict";
import { initAppConfig, getSettingsSecrets, updateSettings } from "../src/server/app-config.js";

test("app-config enforces minimum 360 minutes (6 hours) for nineRouterSyncMinutes", () => {
  initAppConfig();
  const original = getSettingsSecrets().nineRouterSyncMinutes;
  try {
    updateSettings({ nineRouterSyncMinutes: 60 });
    assert.equal(getSettingsSecrets().nineRouterSyncMinutes, 360);

    updateSettings({ nineRouterSyncMinutes: 720 });
    assert.equal(getSettingsSecrets().nineRouterSyncMinutes, 720);
  } finally {
    updateSettings({ nineRouterSyncMinutes: original });
  }
});
