import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireDataLease } from "../src/db/common/maintenance-lease.js";

test("maintenance refuses live application users and application refuses maintenance", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-maintenance-"));
  try {
    const releaseApp = acquireDataLease(dir, "application");
    assert.throws(() => acquireDataLease(dir, "maintenance"), /in use/);
    releaseApp();
    const releaseMaintenance = acquireDataLease(dir, "maintenance");
    assert.throws(() => acquireDataLease(dir, "application"), /maintenance/);
    releaseMaintenance();
    const release = acquireDataLease(dir, "application");
    release();
    release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stale lease with dead pid is reclaimed automatically", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-maintenance-stale-"));
  try {
    const leaseDir = path.join(dir, ".proxy-checker.lease");
    fs.mkdirSync(leaseDir, { recursive: true });
    fs.writeFileSync(path.join(leaseDir, "owner"), "application\n999999\n", "utf8");

    // Should reclaim stale lease without error
    const release = acquireDataLease(dir, "application");
    assert.ok(fs.existsSync(path.join(leaseDir, "owner")));
    release();
    assert.ok(!fs.existsSync(leaseDir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
