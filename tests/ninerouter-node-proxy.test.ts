import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getEventListeners } from "node:events";
import { initAppConfig } from "../src/server/app-config.js";
import {
  clearNodeCookies,
  fetchFromNode,
  getNodeInventory,
  resolveNodeUrl,
} from "../src/server/ninerouter-node-proxy.js";

test("getNodeInventory returns single Pi Master node", () => {
  const nodes = getNodeInventory();
  assert.equal(nodes.length, 1);
  const lan = nodes.find((n) => n.id === "server-lan");
  const vpn = nodes.find((n) => n.id === "server-vpn");
  assert.ok(lan, "Master Node LAN must exist");
  assert.equal(vpn, undefined, "Decommissioned server-vpn must not exist");
  assert.equal(lan.url.includes("192.168.1.54"), true);
});

test("resolveNodeUrl resolves Pi base url and rejects unknown node IDs", () => {
  const urlLan = resolveNodeUrl("server-lan");
  assert.equal(urlLan, "http://192.168.1.54:20128");
  assert.throws(() => resolveNodeUrl("server-vpn"), /Unknown 9Router node ID/);
});

for (const after401 of [false, true]) {
  test(`caller abort during shared ${after401 ? "401 refresh" : "initial login"} leaves other caller running`, {
    timeout: 3000,
  }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "node-login-"));
    const originalPath = process.env.APP_CONFIG_PATH;
    const originalFetch = globalThis.fetch;
    process.env.APP_CONFIG_PATH = path.join(dir, "settings.json");
    fs.writeFileSync(
      process.env.APP_CONFIG_PATH,
      JSON.stringify({
        controlPassword: "control",
        nineRouterPassword: "password",
        nineRouterUrl: "http://192.168.1.54:20128",
      }),
    );
    initAppConfig();
    clearNodeCookies();

    const { promise: loginGate, resolve: releaseLogin } = Promise.withResolvers<void>();
    let loginCount = 0;
    let targetCount = 0;
    let loginSignal: AbortSignal | null | undefined;
    const urls: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/api/auth/login")) {
        loginCount++;
        if (!after401 || loginCount > 1) {
          loginSignal = init?.signal;
          await loginGate;
        }
        return new Response(null, {
          headers: { "set-cookie": `auth_token=${loginCount}; Path=/` },
        });
      }
      targetCount++;
      if (after401 && targetCount > 1 && targetCount <= 3)
        return new Response(null, { status: 401 });
      return new Response("ok");
    };

    try {
      if (after401) await fetchFromNode("server-lan", "/test");
      const controller = new AbortController();
      const reason = new Error("caller cancelled");
      const first = fetchFromNode("server-lan", "/test", { signal: controller.signal });
      const second = fetchFromNode("server-lan", "/test");
      // Let both 401 responses enter the same refresh before aborting.
      const turn = Promise.withResolvers<void>();
      setImmediate(turn.resolve);
      await turn.promise;
      controller.abort(reason);
      await assert.rejects(first, (error) => error === reason);
      assert.equal(loginSignal?.aborted, false);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      assert.equal(loginCount, after401 ? 2 : 1);
      releaseLogin();
      assert.equal(await (await second).text(), "ok");
      assert.ok(
        urls.every((url) => url.startsWith("http://192.168.1.54:20128/")),
        "abort must not trigger failover",
      );
    } finally {
      releaseLogin();
      globalThis.fetch = originalFetch;
      clearNodeCookies();
      if (originalPath === undefined) delete process.env.APP_CONFIG_PATH;
      else process.env.APP_CONFIG_PATH = originalPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
