import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import type { Socket } from "node:net";
import { createFleetRepository } from "../src/proxyfleet/db.js";
import { compareSemver, checkFleet9RouterUpdate } from "../src/proxyfleet/update-checker.js";
import { FleetSshUpdater, DEFAULT_UPGRADE_COMMAND } from "../src/proxyfleet/ssh-updater.js";
import { createFleetApiHandler } from "../src/proxyfleet/api-router.js";
import {
  NineRouterServerManager,
  TARGET_NINEROUTER_SERVERS,
  type NineRouterServerTarget,
  type InteractiveUpgradeResult,
} from "../src/server/server-interactive-updater.js";

interface MockResponseBody {
  ok?: boolean;
  hasUpdate?: boolean;
  nodes?: unknown[];
  targets?: unknown[];
  job?: { id: string; status?: string };
  [key: string]: unknown;
}

function createMockRequestResponse(
  method: string,
  urlPath: string,
  headers: Record<string, string> = {},
  bodyObj?: unknown,
) {
  const req = new http.IncomingMessage({} as unknown as Socket);
  req.method = method;
  req.url = urlPath;
  req.headers = { ...headers };

  if (bodyObj !== undefined) {
    const raw = Buffer.from(JSON.stringify(bodyObj));
    req.push(raw);
  }
  req.push(null);

  let statusCode = 200;
  let responseBody = "";
  const res = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(code: number) {
      statusCode = code;
    },
    writeHead(status: number) {
      statusCode = status;
      return this;
    },
    end(chunk?: unknown) {
      if (chunk) {
        responseBody += chunk.toString();
      }
      return this;
    },
    get body() {
      try {
        return JSON.parse(responseBody);
      } catch {
        return responseBody;
      }
    },
  } as unknown as http.ServerResponse & { statusCode: number; body: MockResponseBody };

  return { req, res };
}

test("compareSemver correctly evaluates version relations", () => {
  assert.equal(compareSemver("0.5.109", "0.5.104"), 1);
  assert.equal(compareSemver("0.5.104", "0.5.109"), -1);
  assert.equal(compareSemver("0.5.109", "v0.5.109"), 0);
  assert.equal(compareSemver("1.0.0", "1.0"), 0);
  assert.equal(compareSemver("0.6.0", "0.5.999"), 1);
  assert.equal(compareSemver("0.5.65", "0.5.109"), -1);
});

test("NineRouterServerManager runs interactive upgrade sequence across dedicated servers", async () => {
  const executedTargets: string[] = [];

  const mockRunner = async (target: NineRouterServerTarget): Promise<InteractiveUpgradeResult> => {
    executedTargets.push(target.host);
    return {
      serverId: target.id,
      serverName: target.name,
      host: target.host,
      status: "success",
      output: `npm updated -> 9router started -> web ui opened -> hidden to tray (PID: 12345)`,
      durationMs: 1500,
    };
  };

  const manager = new NineRouterServerManager(mockRunner);
  const targets = manager.getTargets();

  assert.equal(targets.length, 2);
  assert.equal(targets[0].host, "192.168.1.54");
  assert.equal(targets[0].username, "minhmice");
  assert.equal(targets[0].password, "minh2908");

  assert.equal(targets[1].host, "100.73.175.42");
  assert.equal(targets[1].username, "netnut");
  assert.equal(targets[1].password, "netnut2026@");

  const job = await manager.startInteractiveUpgrade();
  assert.ok(job.id);
  assert.equal(job.status, "running");

  // Wait for deterministic completion
  await job.done;

  const finished = manager.getJob(job.id);
  assert.ok(finished);
  assert.equal(finished.status, "completed");
  assert.equal(Object.keys(finished.targets).length, 2);
  assert.equal(finished.targets["server-lan"].status, "success");
  assert.equal(finished.targets["server-vpn"].status, "success");

  assert.deepEqual(executedTargets, ["192.168.1.54", "100.73.175.42"]);
});

test("API endpoints /api/fleet/update-status and /api/fleet/upgrade support dedicated targets", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-api-test-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");
  const repo = createFleetRepository({ sqlitePath: dbPath });

  try {
    await repo.migrate();

    const mockRunner = async (
      target: NineRouterServerTarget,
    ): Promise<InteractiveUpgradeResult> => {
      return {
        serverId: target.id,
        serverName: target.name,
        host: target.host,
        status: "success",
        output: "hidden to tray",
        durationMs: 500,
      };
    };

    const serverManager = new NineRouterServerManager(mockRunner);
    const handler = createFleetApiHandler({
      repo,
      verifyAuth: (cand) => cand === "testpass",
      serverManager,
    });

    // 1. GET /api/fleet/update-status
    const { req: getReq, res: getRes } = createMockRequestResponse(
      "GET",
      "/api/fleet/update-status",
      { authorization: "Bearer testpass" },
    );
    const handledGet = await handler(getReq, getRes, "/api/fleet/update-status");
    assert.equal(handledGet, true);
    assert.equal(getRes.statusCode, 200);
    assert.ok(typeof getRes.body.hasUpdate === "boolean");
    assert.ok(Array.isArray(getRes.body.targets));
    assert.equal((getRes.body.targets as unknown[]).length, 2);

    // 2. POST /api/fleet/upgrade
    const { req: postReq, res: postRes } = createMockRequestResponse(
      "POST",
      "/api/fleet/upgrade",
      { authorization: "Bearer testpass", "content-type": "application/json" },
      { serverIds: ["server-lan", "server-vpn"] },
    );
    const handledPost = await handler(postReq, postRes, "/api/fleet/upgrade");
    assert.equal(handledPost, true);
    assert.equal(postRes.statusCode, 202);
    assert.equal(postRes.body.ok, true);
    assert.ok(postRes.body.job?.id);

    const jobId = postRes.body.job.id;

    // 3. GET /api/fleet/upgrade/:jobId
    const { req: jobReq, res: jobRes } = createMockRequestResponse(
      "GET",
      `/api/fleet/upgrade/${jobId}`,
      { authorization: "Bearer testpass" },
    );
    const handledJob = await handler(jobReq, jobRes, `/api/fleet/upgrade/${jobId}`);
    assert.equal(handledJob, true);
    assert.equal(jobRes.statusCode, 200);
    assert.equal(jobRes.body.job?.id, jobId);
  } finally {
    repo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
test("REGRESSION-05: Up-to-date target server has hasUpdate=false and unreachable server does not trigger phantom update", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-update-reg-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");
  const repo = createFleetRepository({ sqlitePath: dbPath });

  try {
    await repo.migrate();

    // Mock fetch for npm latest version returning 0.5.109
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (urlStr.includes("registry.npmjs.org")) {
        return new Response(JSON.stringify({ version: "0.5.109" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      // LAN server is running 0.5.109 (up to date)
      if (urlStr.includes("192.168.1.54")) {
        return new Response(
          JSON.stringify({ currentVersion: "0.5.109", latestVersion: "0.5.109", hasUpdate: false }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // Tailscale server is unreachable / offline
      if (urlStr.includes("100.73.175.42")) {
        throw new Error("Connection timed out");
      }

      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }) as typeof fetch;

    try {
      const result = await checkFleet9RouterUpdate({
        repo,
        forceNpmRefresh: true,
      });

      assert.equal(result.latestVersion, "0.5.109");
      assert.equal(
        result.hasUpdate,
        false,
        "Fleet should not have update when master node is up to date and secondary is unreachable",
      );

      const lanTarget = result.targets.find((t) => t.id === "server-lan");
      assert.ok(lanTarget);
      assert.equal(lanTarget.currentVersion, "0.5.109");
      assert.equal(lanTarget.hasUpdate, false, "Up-to-date server must have hasUpdate=false");
      assert.equal(lanTarget.reachable, true);

      const vpnTarget = result.targets.find((t) => t.id === "server-vpn");
      assert.ok(vpnTarget);
      assert.equal(vpnTarget.currentVersion, null);
      assert.equal(
        vpnTarget.hasUpdate,
        false,
        "Unreachable server must not be falsely marked hasUpdate=true",
      );
      assert.equal(vpnTarget.reachable, false);
      assert.ok(vpnTarget.error);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    repo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
