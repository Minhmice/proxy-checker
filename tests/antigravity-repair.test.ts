import test from "node:test";
import assert from "node:assert/strict";
import { repairAntigravityRoute } from "../src/server/antigravity-repair.js";

test("quota-only denial cannot trigger automatic repair", async () => {
  let writes = 0;
  const result = await repairAntigravityRoute(
    {
      routerUrl: "http://router-a",
      routerId: "a",
      accountId: "one",
      operationId: "op",
      cause: "quota_forbidden",
      signal: new AbortController().signal,
    },
    {
      capabilities: async () => ({
        protocolVersion: 1,
        conditionalBinding: true,
        ownershipConfigured: true,
      }),
      binding: async () => ({ accountId: "one", poolId: "old", revision: 1, isActive: false }),
      pools: async () => [],
      audit: async () => ({ complete: false, observations: [] }),
      update: async () => {
        writes++;
        throw Error("unexpected");
      },
      verify: async () => ({}),
    },
  );
  assert.equal(result.status, "not_applicable");
  assert.equal(writes, 0);
});
test("no verified candidate leaves binding unchanged", async () => {
  let writes = 0;
  const result = await repairAntigravityRoute(
    {
      routerUrl: "http://router-a",
      routerId: "a",
      accountId: "one",
      operationId: "op",
      cause: "unsafe_transport",
      signal: new AbortController().signal,
    },
    {
      capabilities: async () => ({
        protocolVersion: 1,
        conditionalBinding: true,
        ownershipConfigured: true,
      }),
      binding: async () => ({ accountId: "one", poolId: "old", revision: 1, isActive: false }),
      pools: async () => [
        { id: "old", name: "old", proxyUrl: "http://127.0.0.1:8080", isActive: true },
      ],
      audit: async () => ({ complete: false, observations: [] }),
      update: async () => {
        writes++;
        throw Error("unexpected");
      },
      verify: async () => ({}),
    },
  );
  assert.equal(result.status, "no_candidate");
  assert.equal(writes, 0);
});
