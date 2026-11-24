import assert from "node:assert/strict";
import test from "node:test";
import { applyUnbind, parseCliArgs, planUnbind } from "../scripts/unbind-antigravity-proxies.js";
import type { NineRouterConnectionItem } from "../src/server/nine-router-client.js";

test("planUnbind removes only proxyPoolId and leaves input untouched", () => {
  const connections: NineRouterConnectionItem[] = [
    {
      id: "account-1",
      provider: "antigravity",
      providerSpecificData: { proxyPoolId: "P1", retained: "value" },
    },
    {
      id: "account-2",
      provider: "antigravity",
      providerSpecificData: { retained: "other" },
    },
  ];
  const before = structuredClone(connections);

  assert.deepEqual(planUnbind(connections), [
    { id: "account-1", providerSpecificData: { retained: "value" } },
  ]);
  assert.deepEqual(connections, before);
});

test("applyUnbind dry-run performs no writes and counts skipped connections", async () => {
  const listed: string[] = [];
  let writes = 0;
  const result = await applyUnbind({
    dryRun: true,
    routerUrls: ["http://router-a"],
    listConnections: async (overrides) => {
      listed.push(overrides?.url ?? "");
      return [
        {
          id: "account-1",
          provider: "antigravity",
          providerSpecificData: { proxyPoolId: "P1", retained: "value" },
        },
        { id: "account-2", provider: "antigravity" },
      ];
    },
    updateConnection: async () => {
      writes++;
      return {};
    },
  });

  assert.deepEqual(result, { scanned: 2, changed: 1, skipped: 1, failed: 0 });
  assert.deepEqual(listed, ["http://router-a"]);
  assert.equal(writes, 0);
});

test("verified explicit deletion preserves hidden provider data under server merge semantics", async () => {
  const serverData: Record<string, unknown> = {
    proxyPoolId: "P1",
    retained: "value",
    hiddenCredential: "secret",
  };
  const projected = { proxyPoolId: "P1", retained: "value" };
  const omission = planUnbind([
    { id: "one", provider: "antigravity", providerSpecificData: projected },
  ])[0];
  assert.equal({ ...serverData, ...omission.providerSpecificData }.proxyPoolId, "P1");

  const result = await applyUnbind({
    dryRun: false,
    routerUrls: ["http://router-a"],
    listConnections: async () => [
      { id: "one", provider: "antigravity", providerSpecificData: projected },
    ],
    updateConnection: async (id, patch, overrides) => {
      assert.equal(id, "one");
      assert.equal(overrides?.url, "http://router-a");
      assert.deepEqual(patch, { proxyPoolId: null });
      if (patch.proxyPoolId === null) delete serverData.proxyPoolId;
      return {};
    },
  });

  assert.deepEqual(result, { scanned: 1, changed: 1, skipped: 0, failed: 0 });
  assert.deepEqual(serverData, { retained: "value", hiddenCredential: "secret" });
});

test("verified writes remain sequential and continue after partial failure", async () => {
  const events: string[] = [];
  const result = await applyUnbind({
    dryRun: false,
    routerUrls: ["http://router-a"],
    listConnections: async () =>
      ["first", "second"].map((id) => ({
        id,
        provider: "antigravity",
        providerSpecificData: { proxyPoolId: "P1" },
      })),
    updateConnection: async (id, patch) => {
      events.push(`start:${id}`);
      assert.deepEqual(patch, { proxyPoolId: null });
      await Promise.resolve();
      events.push(`end:${id}`);
      if (id === "first") throw new Error("failed");
      return {};
    },
  });
  assert.deepEqual(events, ["start:first", "end:first", "start:second", "end:second"]);
  assert.deepEqual(result, { scanned: 2, changed: 1, skipped: 0, failed: 1 });
});

test("applyUnbind counts endpoint read failures instead of reporting success for zero accounts", async () => {
  let writes = 0;
  const result = await applyUnbind({
    dryRun: false,
    routerUrls: ["http://router-b", "http://router-a"],
    listConnections: async (overrides) => {
      if (overrides?.url === "http://router-b") throw new Error("unreachable");
      return [
        {
          id: "account-1",
          provider: "antigravity",
          providerSpecificData: { proxyPoolId: "P1" },
        },
      ];
    },
    updateConnection: async () => {
      writes++;
      return {};
    },
  });

  assert.deepEqual(result, { scanned: 1, changed: 1, skipped: 0, failed: 1 });
  assert.equal(writes, 1);
});

test("parseCliArgs rejects unknown and conflicting flags before network setup", () => {
  assert.throws(() => parseCliArgs(["--unexpected"]), /Unknown flag: --unexpected/);
  assert.throws(() => parseCliArgs(["--apply", "--dry-run"]), /conflicting flags/);
  assert.deepEqual(parseCliArgs(["--apply", "--router-url", "http://router-a"]), {
    apply: true,
    dryRun: false,
    routerUrls: ["http://router-a"],
  });
});
