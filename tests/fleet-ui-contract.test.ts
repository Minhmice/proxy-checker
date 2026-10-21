import test from "node:test";
import assert from "node:assert/strict";
import {
  redactCredential,
  formatFleetNodeStatus,
  formatFleetNodeRole,
  formatHealthStatus,
  formatBytes,
  formatRelativeTime,
  formatHeartbeatStatus,
  formatPlatform,
} from "../src/lib/fleet-ui-utils.js";

test("fleet ui utils formats status, byte sizes, and redacts credentials properly", () => {
  // Redaction
  assert.equal(redactCredential("secret123"), "•••••••••");
  assert.equal(redactCredential(""), "");

  // Node status formatting
  assert.equal(formatFleetNodeStatus("online").variant, "success");
  assert.equal(formatFleetNodeStatus("offline").variant, "destructive");
  assert.equal(formatFleetNodeStatus("degraded").variant, "warning");

  // Health status formatting
  assert.equal(formatHealthStatus("healthy").variant, "success");
  assert.equal(formatHealthStatus("route_leak").variant, "destructive");
  assert.equal(formatHealthStatus("timeout").variant, "warning");

  // Byte formatting
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1048576 * 5), "5.0 MB");

  // Relative time formatting
  assert.equal(formatRelativeTime(Date.now() - 2000), "Just now");
  assert.equal(formatRelativeTime(Date.now() - 30_000), "30s ago");
  assert.equal(formatRelativeTime(Date.now() - 120_000), "2m ago");
});

test("fleet ui utils formats node role accurately", () => {
  const ctrl = formatFleetNodeRole("controller-worker");
  assert.equal(ctrl.label, "Controller + Worker");
  assert.equal(ctrl.badgeVariant, "default");

  const worker = formatFleetNodeRole("worker");
  assert.equal(worker.label, "Worker");
  assert.equal(worker.badgeVariant, "secondary");

  const fallback = formatFleetNodeRole(undefined);
  assert.equal(fallback.label, "Worker");
  assert.equal(fallback.badgeVariant, "secondary");
});

test("fleet ui utils formats heartbeat status severity and platform correctly", () => {
  assert.equal(formatHeartbeatStatus(null).severity, "critical");
  assert.equal(formatHeartbeatStatus(0).severity, "critical");
  assert.equal(formatHeartbeatStatus(Date.now() - 60_000).severity, "normal");
  assert.equal(formatHeartbeatStatus(Date.now() - 600_000).severity, "warning");
  assert.equal(formatHeartbeatStatus(Date.now() - 7_200_000).severity, "critical");

  assert.equal(formatPlatform("win32", "x64"), "windows/amd64");
  assert.equal(formatPlatform("linux", "amd64"), "linux/amd64");
});
