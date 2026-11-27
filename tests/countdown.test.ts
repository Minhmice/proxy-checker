import assert from "node:assert/strict";
import test from "node:test";
import { formatCountdown } from "../src/lib/countdown";

const now = Date.parse("2026-01-01T00:00:00Z");

test("future", () => {
  assert.equal(formatCountdown("2026-01-01T02:05:30Z", now), "2h 5m");
  assert.equal(formatCountdown("2026-01-01T00:07:00Z", now), "7m");
  assert.equal(formatCountdown("2026-01-01T00:07:00Z", now, "Reset in "), "Reset in 7m");
});

test("past", () => {
  assert.equal(formatCountdown("2025-12-31T00:00:00Z", now), "Resetting soon");
});

test("missing", () => {
  assert.equal(formatCountdown(null, now), "No reset info");
  assert.equal(formatCountdown(undefined, now), "No reset info");
  assert.equal(formatCountdown("", now), "No reset info");
});

test("invalid", () => {
  assert.equal(formatCountdown("garbage", now), "No reset info");
});
