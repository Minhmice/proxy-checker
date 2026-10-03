import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { Socket } from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createFleetRepository } from "../src/proxyfleet/db.js";
import { createFleetApiHandler } from "../src/proxyfleet/api-router.js";

interface MockResponseBody {
  token?: string;
  nodeId?: string;
  id?: string;
  proxies?: Array<Record<string, unknown>>;
  nodes?: Array<{ id: string; role?: string; name?: string }>;
  node?: { id: string; role?: string; name?: string };
  username?: string;
  password?: string;
  wireguardIp?: string;
  error?: string;
}

interface MockResponse extends http.ServerResponse {
  statusCode: number;
  body: MockResponseBody | null;
}

function createMockRequestResponse(
  method: string,
  urlPath: string,
  headers: Record<string, string> = {},
  bodyObj?: unknown
): { req: http.IncomingMessage; res: MockResponse } {
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
    writeHead(code: number) {
      statusCode = code;
      return res;
    },
    end(data?: Buffer | string) {
      if (data) responseBody += data.toString();
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return responseBody ? (JSON.parse(responseBody) as MockResponseBody) : null;
    },
  } as unknown as MockResponse;

  return { req, res };
}

test("fleet api routes enforce auth, node enrollment, and endpoint management", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-api-test-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");
  const repo = createFleetRepository({ sqlitePath: dbPath });

  try {
    await repo.migrate();
    const handler = createFleetApiHandler({
      repo,
      verifyAuth: (pass) => pass === "admin-secret-pass",
    });

    // 1. Unauthenticated request to /api/fleet/nodes must 401
    const unauth = createMockRequestResponse("GET", "/api/fleet/nodes");
    const handledUnauth = await handler(unauth.req, unauth.res, "/api/fleet/nodes");
    assert.equal(handledUnauth, true);
    assert.equal(unauth.res.statusCode, 401);

    // 2. Issue an enrollment token (authenticated)
    const issueReq = createMockRequestResponse(
      "POST",
      "/api/fleet/enrollment-tokens",
      { authorization: `Basic ${Buffer.from("admin:admin-secret-pass").toString("base64")}` },
      { nodeName: "worker-001" }
    );
    await handler(issueReq.req, issueReq.res, "/api/fleet/enrollment-tokens");
    assert.equal(issueReq.res.statusCode, 201);
    const token = issueReq.res.body?.token;
    assert.ok(token);

    // 3. Worker enrolls using the token (unauthenticated public route)
    const enrollReq = createMockRequestResponse(
      "POST",
      "/api/fleet/enroll",
      {},
      {
        token,
        nodeName: "worker-001",
        wireguardPublicKey: "test-pubkey",
      }
    );
    await handler(enrollReq.req, enrollReq.res, "/api/fleet/enroll");
    assert.equal(enrollReq.res.statusCode, 200);
    const nodeId = enrollReq.res.body?.nodeId;
    assert.ok(nodeId);
    assert.equal(enrollReq.res.body?.wireguardIp, "10.77.0.11");

    // 4. Create an endpoint on the node (authenticated)
    const createEpReq = createMockRequestResponse(
      "POST",
      "/api/fleet/endpoints",
      { authorization: `Basic ${Buffer.from("admin:admin-secret-pass").toString("base64")}` },
      {
        nodeId,
        protocol: "http",
        listenIp: "10.77.0.11",
        listenPort: 20001,
        username: "proxyuser",
        password: "proxypassword",
      }
    );
    await handler(createEpReq.req, createEpReq.res, "/api/fleet/endpoints");
    assert.equal(createEpReq.res.statusCode, 201);
    const endpointId = createEpReq.res.body?.id;
    assert.ok(endpointId);

    // 5. Agent requests desired state
    const desiredStateReq = createMockRequestResponse("GET", `/api/fleet/agent/desired-state?nodeId=${nodeId}`);
    await handler(desiredStateReq.req, desiredStateReq.res, "/api/fleet/agent/desired-state");
    assert.equal(desiredStateReq.res.statusCode, 200);
    assert.equal(desiredStateReq.res.body?.proxies?.length, 1);
    assert.equal(desiredStateReq.res.body?.proxies?.[0]?.listen_port, 20001);

    // 6. Reveal credentials requires auth
    const revealReq = createMockRequestResponse(
      "POST",
      `/api/fleet/endpoints/${endpointId}/credentials/reveal`,
      { authorization: `Basic ${Buffer.from("admin:admin-secret-pass").toString("base64")}` }
    );
    await handler(revealReq.req, revealReq.res, `/api/fleet/endpoints/${endpointId}/credentials/reveal`);
    assert.equal(revealReq.res.statusCode, 200);
    assert.equal(revealReq.res.body?.username, "proxyuser");
    assert.equal(revealReq.res.body?.password, "proxypassword");
  } finally {
    repo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("GET /api/fleet/nodes returns node roles for both controller and worker", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-api-role-test-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");
  const repo = createFleetRepository({ sqlitePath: dbPath });

  try {
    await repo.migrate();
    await repo.bootstrapControllerNode({
      id: "ctrl-01",
      name: "controller-001",
      wireguardIp: "10.77.0.1",
    });
    await repo.createNode({
      id: "worker-01",
      name: "worker-001",
      wireguardIp: "10.77.0.11",
      role: "worker",
    });

    const handler = createFleetApiHandler({
      repo,
      verifyAuth: () => true,
    });

    const { req, res } = createMockRequestResponse("GET", "/api/fleet/nodes", {
      authorization: "Basic " + Buffer.from("admin:pass").toString("base64"),
    });

    const handled = await handler(req, res, "/api/fleet/nodes");
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);

    const body = res.body;
    assert.ok(body?.nodes);
    assert.equal(body.nodes.length, 2);
    const ctrlNode = body.nodes.find((n) => n.id === "ctrl-01");
    assert.equal(ctrlNode?.role, "controller-worker");
    const workerNode = body.nodes.find((n) => n.id === "worker-01");
    assert.equal(workerNode?.role, "worker");
  } finally {
    repo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
