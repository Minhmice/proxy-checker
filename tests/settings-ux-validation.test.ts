import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("Settings Page: UX Copy, Labels and Buttons Clarified", () => {
  const content = fs.readFileSync("src/app/(dashboard)/settings/page.tsx", "utf8");

  // Specific Action Buttons
  assert.ok(content.includes("Save 9Router Connection"), "Must use 'Save 9Router Connection'");
  assert.ok(content.includes("Test 9Router Connection"), "Must use 'Test 9Router Connection'");
  assert.ok(
    content.includes("Save Sync & Health Settings"),
    "Must use 'Save Sync & Health Settings'",
  );
  assert.ok(content.includes("Save Rotator Settings"), "Must use 'Save Rotator Settings'");
  assert.ok(content.includes("Update Control Password"), "Must use 'Update Control Password'");
  assert.ok(
    content.includes("Export Verified Proxies (.txt)"),
    "Must use 'Export Verified Proxies (.txt)'",
  );
  assert.ok(
    content.includes("Export Verified Proxies (.csv)"),
    "Must use 'Export Verified Proxies (.csv)'",
  );
  assert.ok(content.includes("Refresh Backup Status"), "Must use 'Refresh Backup Status'");
  assert.ok(
    content.includes("Restore Database from Backup"),
    "Must use 'Restore Database from Backup'",
  );
  assert.ok(
    content.includes("Create Git Backup Snapshot"),
    "Must use 'Create Git Backup Snapshot'",
  );

  // Plaintext Security Warning Clarification
  assert.ok(
    content.includes("Plaintext Password Exposure Warning"),
    "Must include clarified Plaintext Password Exposure Warning alert",
  );
  assert.ok(
    content.includes("Include plaintext authentication credentials (user:pass)"),
    "Must include plaintext format label on export checkbox",
  );
  assert.ok(
    content.includes("CRITICAL SECURITY RISK"),
    "Must include CRITICAL SECURITY RISK in export window.confirm",
  );
});

test("Settings Page: Data-Loss Guards & Dirty State Tracking", () => {
  const content = fs.readFileSync("src/app/(dashboard)/settings/page.tsx", "utf8");

  // Dirty State Tracking & beforeunload
  assert.ok(content.includes("isSectionDirty"), "Must implement isSectionDirty helper");
  assert.ok(content.includes("isAnyDirty"), "Must track isAnyDirty");
  assert.ok(
    content.includes("beforeunload"),
    "Must listen to beforeunload to prevent navigation loss",
  );
  assert.ok(content.includes("baselineForm"), "Must retain baselineForm to check dirty inputs");

  // Surgical Section State Merge (prevents wiping dirty inputs in other tabs)
  assert.ok(
    content.includes("Surgical section merge"),
    "Must document surgical section merge in state update",
  );
  assert.ok(
    content.includes("next.activePoolLimit = String(data.settings.activePoolLimit)"),
    "Must isolate sync section updates without wiping other tabs",
  );

  // Client Validation Guards (prevents NaN poisoning in settings.json)
  assert.ok(
    content.includes("Active pool limit must be an integer between 1 and 200"),
    "Must validate activePoolLimit bounds",
  );
  assert.ok(
    content.includes("Sync interval must be an integer between 1 and 1440 minutes"),
    "Must validate nineRouterSyncMinutes bounds",
  );
  assert.ok(
    content.includes("Check concurrency must be an integer between 1 and 50"),
    "Must validate checkConcurrency bounds",
  );
  assert.ok(
    content.includes("Check timeout must be between 2000ms and 30000ms"),
    "Must validate checkTimeoutMs bounds",
  );
});

test("Settings Page: Password Session Synchronization & Pending Concurrency", () => {
  const content = fs.readFileSync("src/app/(dashboard)/settings/page.tsx", "utf8");

  // Password Session Sync
  assert.ok(
    content.includes("setPassword(payload.controlPassword)"),
    "Must synchronize client session password immediately on update to prevent 401 loop",
  );

  // isActionPending locking
  assert.ok(
    content.includes("if ((!password && !authenticated) || isActionPending) return;"),
    "Must guard backup and restore with isActionPending",
  );
});
