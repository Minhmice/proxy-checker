import test from "node:test";
import assert from "node:assert/strict";
import { createAntigravityRotator } from "../src/server/antigravity-rotator.js";
import type { AntigravityRotatorSnapshot } from "../src/lib/types.js";

test("antigravity rotator snapshot returns correct structure and values", () => {
  const mockRotator = createAntigravityRotator({
    dataDir: "data",
    listConnections: async () => [],
    getUsage: async () => ({}),
  });

  const snapshot = mockRotator.getSnapshot();
  assert.equal(typeof snapshot.running, "boolean");
  assert.equal(typeof snapshot.totalAccounts, "number");
  assert.equal(typeof snapshot.activeCount, "number");
  assert.equal(Array.isArray(snapshot.accounts), true);
});
