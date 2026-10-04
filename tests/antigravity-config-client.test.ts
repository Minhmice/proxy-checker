import test from "node:test";
import assert from "node:assert/strict";
import { initAppConfig, getSettingsPublic } from "../src/server/app-config.js";

test("app-config includes Antigravity rotator settings with sensible defaults", () => {
  initAppConfig();
  const pub = getSettingsPublic().settings;
  assert.equal(typeof pub.antigravityRotatorEnabled, "boolean");
  assert.equal(pub.antigravityActiveLimit, 3);
  assert.equal(pub.antigravityRotateMinutes, 10);
  assert.equal(pub.antigravitySessionThreshold, 20);
});
