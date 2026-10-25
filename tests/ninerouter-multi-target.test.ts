import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseNineRouterUrls, normalizeNineRouterUrl } from "../src/server/app-config.js";
import { createAntigravityRotator } from "../src/server/antigravity-rotator.js";
import type { AntigravityRotationHistory } from "../src/server/antigravity-rotation-history.js";

function createMockHistory(): AntigravityRotationHistory {
  return {
    get: () => ({ accountId: "mock", turnCount: 0, lastActivatedAt: null }),
    recordActivation: (accountId: string) => ({
      accountId,
      turnCount: 1,
      lastActivatedAt: Date.now(),
    }),
    close: () => {},
  };
}

test("multi-target: parseNineRouterUrls correctly parses and normalizes dual URLs", () => {
  const parsed = parseNineRouterUrls("192.168.1.54, 9router.minhmice.com");
  assert.deepEqual(parsed, ["http://192.168.1.54", "http://9router.minhmice.com"]);

  const withProtocols = parseNineRouterUrls(
    "http://192.168.1.54:20128, https://9router.minhmice.com",
  );
  assert.deepEqual(withProtocols, ["http://192.168.1.54:20128", "https://9router.minhmice.com"]);

  const normalized = normalizeNineRouterUrl(
    "http://192.168.1.54:20128, https://9router.minhmice.com",
  );
  assert.equal(normalized, "http://192.168.1.54:20128, https://9router.minhmice.com");
});

test("multi-target: antigravity rotator rotates across 2 URLs simultaneously", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-dual-"));
  const url1 = "http://192.168.1.54:20128";
  const url2 = "https://9router.minhmice.com";

  const calledUrls: string[] = [];
  const updatedByUrl: Record<string, Array<{ id: string; isActive?: boolean }>> = {
    [url1]: [],
    [url2]: [],
  };

  const rotator = createAntigravityRotator({
    dataDir: tmpDir,
    history: createMockHistory(),
    getRouterUrls: () => [url1, url2],
    getSettings: () => ({
      controlPassword: "pass",
      nineRouterUrl: `${url1}, ${url2}`,
      nineRouterPassword: "pass",
      nineRouterApiKey: "",
      nineRouterAutoSync: true,
      activePoolLimit: 20,
      nineRouterSyncMinutes: 60,
      checkConcurrency: 10,
      checkTimeoutMs: 5000,
      proxyTtlMinutes: 15,
      antigravityRotatorEnabled: true,
      antigravityActiveLimit: 2,
      antigravityRotateMinutes: 10,
      antigravitySessionThreshold: 20,
      fleetWireguard: null,
    }),
    listConnections: async (overrides) => {
      const url = overrides?.url || "unknown";
      calledUrls.push(url);
      return [
        {
          id: `${url}-acc1`,
          email: "user1@example.com",
          name: "User 1",
          isActive: true,
          provider: "antigravity",
        },
        {
          id: `${url}-acc2`,
          email: "user2@example.com",
          name: "User 2",
          isActive: false,
          provider: "antigravity",
        },
      ];
    },
    getUsage: async (id) => {
      // acc1 is low quota (10%), acc2 is full quota (100%)
      if (id.includes("acc1")) {
        return {
          quotas: {
            gemini_session: { remainingPercentage: 10, resetAt: "2026-10-23T00:00:00Z" },
          },
        };
      }
      return {
        quotas: {
          gemini_session: { remainingPercentage: 100, resetAt: "2026-10-23T05:00:00Z" },
        },
      };
    },
    updateConnection: async (id, patch, overrides) => {
      const url = overrides?.url || "";
      if (updatedByUrl[url]) {
        updatedByUrl[url].push({ id, isActive: patch.isActive });
      }
      return { connection: { id, ...patch } };
    },
  });

  try {
    const snapshot = await rotator.runRotation({ force: true });

    // Both URLs were queried
    assert.ok(calledUrls.includes(url1), "URL 1 was called");
    assert.ok(calledUrls.includes(url2), "URL 2 was called");

    // Both URLs executed deactivations and activations
    const url1Deactivations = updatedByUrl[url1].filter((u) => u.isActive === false);
    const url1Activations = updatedByUrl[url1].filter((u) => u.isActive === true);
    assert.equal(url1Deactivations.length, 1, "URL 1 deactivated acc1");
    assert.equal(url1Activations.length, 1, "URL 1 activated acc2");

    const url2Deactivations = updatedByUrl[url2].filter((u) => u.isActive === false);
    const url2Activations = updatedByUrl[url2].filter((u) => u.isActive === true);
    assert.equal(url2Deactivations.length, 1, "URL 2 deactivated acc1");
    assert.equal(url2Activations.length, 1, "URL 2 activated acc2");

    // Snapshot details
    assert.equal(snapshot.endpoints?.length, 2);
    assert.equal(
      snapshot.endpoints?.every((e) => e.ok),
      true,
    );
    assert.equal(snapshot.accounts.length, 4); // 2 per router
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("multi-target: rotator handles partial failure gracefully when 1 URL fails", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-partial-"));
  const url1 = "http://192.168.1.54:20128";
  const url2 = "https://9router.minhmice.com";

  const updatedByUrl: Record<string, Array<{ id: string; isActive?: boolean }>> = {
    [url2]: [],
  };

  const rotator = createAntigravityRotator({
    dataDir: tmpDir,
    history: createMockHistory(),
    getRouterUrls: () => [url1, url2],
    getSettings: () => ({
      controlPassword: "pass",
      nineRouterUrl: `${url1}, ${url2}`,
      nineRouterPassword: "pass",
      nineRouterApiKey: "",
      nineRouterAutoSync: true,
      activePoolLimit: 20,
      nineRouterSyncMinutes: 60,
      checkConcurrency: 10,
      checkTimeoutMs: 5000,
      proxyTtlMinutes: 15,
      antigravityRotatorEnabled: true,
      antigravityActiveLimit: 1,
      antigravityRotateMinutes: 10,
      antigravitySessionThreshold: 20,
      fleetWireguard: null,
    }),
    listConnections: async (overrides) => {
      const url = overrides?.url;
      if (url === url1) {
        throw new Error("Connection refused (ECONNREFUSED 192.168.1.54:20128)");
      }
      return [
        {
          id: "url2-acc1",
          email: "cloud@example.com",
          name: "Cloud Acc",
          isActive: false,
          provider: "antigravity",
        },
      ];
    },
    getUsage: async () => ({
      quotas: {
        gemini_session: { remainingPercentage: 80, resetAt: "2026-10-23T00:00:00Z" },
      },
    }),
    updateConnection: async (id, patch, overrides) => {
      const url = overrides?.url || "";
      if (updatedByUrl[url]) {
        updatedByUrl[url].push({ id, isActive: patch.isActive });
      }
      return { connection: { id, ...patch } };
    },
  });

  try {
    const snapshot = await rotator.runRotation({ force: true });

    // Snapshot records both endpoints: 1 failed, 1 succeeded
    assert.equal(snapshot.endpoints?.length, 2);
    const ep1 = snapshot.endpoints?.find((e) => e.url === url1);
    const ep2 = snapshot.endpoints?.find((e) => e.url === url2);

    assert.equal(ep1?.ok, false);
    assert.match(ep1?.error || "", /ECONNREFUSED/);

    assert.equal(ep2?.ok, true);
    assert.equal(ep2?.activeCount, 1);

    // URL 2 still activated its account despite URL 1 failure
    assert.equal(updatedByUrl[url2].length, 1);
    assert.equal(updatedByUrl[url2][0].isActive, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
