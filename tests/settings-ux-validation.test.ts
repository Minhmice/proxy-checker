import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("Settings Page: UX Copy, Labels and Buttons Clarified", () => {
  const content = fs.readFileSync("src/app/(dashboard)/settings/page.tsx", "utf8");

  assert.ok(content.includes("Save 9Router Connection"), "Must use 'Save 9Router Connection'");
  assert.ok(content.includes("Test 9Router Connection"), "Must use 'Test 9Router Connection'");
  assert.ok(content.includes("Save Rotator Settings"), "Must use 'Save Rotator Settings'");
  assert.ok(content.includes("Update Control Password"), "Must use 'Update Control Password'");
  assert.ok(content.includes("Refresh Backup Status"), "Must use 'Refresh Backup Status'");
  assert.ok(
    content.includes("Restore Database from Backup"),
    "Must use 'Restore Database from Backup'",
  );
  assert.ok(
    content.includes("Create Git Backup Snapshot"),
    "Must use 'Create Git Backup Snapshot'",
  );

  assert.ok(!content.includes("Export Verified Proxies"), "Must not contain proxy export controls");
});

test("Settings Page: Data-Loss Guards & Dirty State Tracking", () => {
  const content = fs.readFileSync("src/app/(dashboard)/settings/page.tsx", "utf8");

  assert.ok(content.includes("isSectionDirty"), "Must implement isSectionDirty helper");
  assert.ok(content.includes("isAnyDirty"), "Must track isAnyDirty");
  assert.ok(
    content.includes("beforeunload"),
    "Must listen to beforeunload to prevent navigation loss",
  );
  assert.ok(content.includes("baselineForm"), "Must retain baselineForm to check dirty inputs");

  assert.ok(
    content.includes("next.nineRouterUrl = data.settings.nineRouterUrl"),
    "Must isolate ninerouter section updates without wiping other tabs",
  );

  assert.ok(
    content.includes("Rotation interval must be an integer between 1 and 60 minutes"),
    "Must validate antigravityRotateMinutes bounds",
  );

  assert.ok(!content.includes("activePoolLimit"), "Must not contain activePoolLimit");
  assert.ok(!content.includes("checkConcurrency"), "Must not contain checkConcurrency");
});

test("Settings Page: Password Session Synchronization & Pending Concurrency", () => {
  const content = fs.readFileSync("src/app/(dashboard)/settings/page.tsx", "utf8");

  assert.ok(
    content.includes("setPassword(payload.controlPassword)"),
    "Must synchronize client session password immediately on update to prevent 401 loop",
  );

  assert.ok(
    content.includes("if ((!password && !authenticated) || isActionPending) return;"),
    "Must guard backup and restore with isActionPending",
  );
});
