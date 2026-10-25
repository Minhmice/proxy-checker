import test from "node:test";
import assert from "node:assert/strict";
import type { ActivityEntry } from "../src/lib/types.js";
import { groupActivityBySync, sanitizeLogMessage } from "../src/lib/activity-grouping.js";

test("sanitizeLogMessage shortens long UUIDs to 8 characters with ellipsis", () => {
  const input = "Renamed pool c86187b0-4014-4ccc-af8c-6d6fb6568f7b to 29";
  const result = sanitizeLogMessage(input);
  assert.equal(result, "Renamed pool c86187b0… to 29");
});

test("groupActivityBySync groups repeated operations into structured sync session", () => {
  const baseTime = 1727000000000;
  const entries: ActivityEntry[] = [
    { id: "1", at: baseTime, level: "info", message: "Sync started" },
    {
      id: "2",
      at: baseTime + 1000,
      level: "info",
      message: "Listed 45 proxies — starting health checks with retry/delete lifecycle…",
    },
    {
      id: "3",
      at: baseTime + 2000,
      level: "warn",
      message:
        "First check failed for 17 (a7a7062c-a7f1-4356-a733-af19fedcf2b4): response timeout — retrying immediately…",
    },
    {
      id: "4",
      at: baseTime + 3000,
      level: "error",
      message: "Failed to delete dead proxy 5 from 9Router: Proxy pool is currently in use",
    },
    {
      id: "5",
      at: baseTime + 4000,
      level: "info",
      message: "Renamed pool c86187b0-4014-4ccc-af8c-6d6fb6568f7b to 29",
    },
    {
      id: "6",
      at: baseTime + 5000,
      level: "info",
      message: "Renamed pool dadc882c-acd8-441c-a151-acf2961ca6b8 to 30",
    },
    {
      id: "7",
      at: baseTime + 6000,
      level: "success",
      message: "Sync finished in 28s — 7 active, 2 reserve",
    },
  ];

  const sessions = groupActivityBySync(entries);
  assert.equal(sessions.length, 1);
  const session = sessions[0];

  assert.equal(session.status, "success");
  assert.equal(session.durationSeconds, 28);
  assert.equal(session.activeCount, 7);
  assert.equal(session.reserveCount, 2);
  assert.equal(session.checkedCount, 45);
  assert.equal(session.retriesCount, 1);
  assert.equal(session.renamedCount, 2);
  assert.equal(session.errorMessages.length, 1);
  assert.match(session.errorMessages[0], /Proxy pool is currently in use/);
  assert.equal(session.warningMessages.length, 1);
  assert.match(session.warningMessages[0], /a7a7062c…/);
});

test("groupActivityBySync handles multiple sessions and puts newest first", () => {
  const baseTime = 1727000000000;
  const entries: ActivityEntry[] = [
    // Session 1
    { id: "1", at: baseTime, level: "info", message: "Sync started" },
    {
      id: "2",
      at: baseTime + 2000,
      level: "success",
      message: "Sync finished in 5s — 10 active, 0 reserve",
    },
    // Session 2 (newer)
    { id: "3", at: baseTime + 10000, level: "info", message: "Sync started" },
    {
      id: "4",
      at: baseTime + 12000,
      level: "error",
      message: "Sync failed: 9Router connection refused",
    },
  ];

  const sessions = groupActivityBySync(entries);
  assert.equal(sessions.length, 2);
  // Newest session first
  assert.equal(sessions[0].status, "failed");
  assert.match(sessions[0].errorMessages[0], /connection refused/);

  assert.equal(sessions[1].status, "success");
  assert.equal(sessions[1].activeCount, 10);
});
