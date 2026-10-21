import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { Socket } from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createFleetRepository } from "../src/proxyfleet/db.js";
import { createFleetApiHandler } from "../src/proxyfleet/api-router.js";
import { createNodeRemovalService } from "../src/proxyfleet/node-removal.js";
import type { FleetRemovalRecord } from "../src/proxyfleet/types.js";
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
  enabled?: boolean;
  agentToken?: string;
  revision?: number;
  removal?: FleetRemovalRecord;
  removals?: FleetRemovalRecord[];
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
      enrollmentOptions: {
        serverWireguardPublicKey: "OTk5OTk5OTlBQUFBQUFBQUJCQkJCQkJCQ0NDQ0NDQ0M=",
        serverWireguardEndpoint: "198.51.100.1:51820",
      },
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
        wireguardPublicKey: "MTExMTExMTEyMjIyMjIyMjMzMzMzMzMzNDQ0NDQ0NDQ=",
      }
    );
    await handler(enrollReq.req, enrollReq.res, "/api/fleet/enroll");
    assert.equal(enrollReq.res.statusCode, 200);
    const nodeId = enrollReq.res.body?.nodeId;
    assert.ok(nodeId);
    assert.equal(enrollReq.res.body?.wireguardIp, "10.77.0.11");
    const agentToken = enrollReq.res.body?.agentToken;
    assert.ok(agentToken);

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
    const desiredStateReq = createMockRequestResponse("GET", `/api/fleet/agent/desired-state?nodeId=${nodeId}`, { authorization: `Bearer ${agentToken}` });
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

    // 7. PATCH endpoint to toggle enabled
    const patchReq = createMockRequestResponse(
      "PATCH",
      `/api/fleet/endpoints/${endpointId}`,
      { authorization: `Basic ${Buffer.from("admin:admin-secret-pass").toString("base64")}` },
      { enabled: false }
    );
    await handler(patchReq.req, patchReq.res, `/api/fleet/endpoints/${endpointId}`);
    assert.equal(patchReq.res.statusCode, 200);
    assert.equal(patchReq.res.body?.enabled, false);

    const disabledState = createMockRequestResponse("GET", `/api/fleet/agent/desired-state?nodeId=${nodeId}`, { authorization: `Bearer ${agentToken}` });
    await handler(disabledState.req, disabledState.res, "/api/fleet/agent/desired-state");
    assert.equal(disabledState.res.statusCode, 200);
    assert.deepEqual(disabledState.res.body?.proxies, []);
    assert.ok(disabledState.res.body!.revision! > desiredStateReq.res.body!.revision!);
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
test("node removal API handles auth, 404, 409 controller guard, 202 pending and 200 completed retry", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-api-removal-test-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");
  const repo = createFleetRepository({ sqlitePath: dbPath });

  try {
    await repo.migrate();
    const ctrl = await repo.bootstrapControllerNode({
      id: "ctrl-rm-test",
      wireguardIp: "10.77.0.1",
    });
    const worker = await repo.createNode({
      id: "worker-rm-test",
      name: "worker-rm",
      wireguardIp: "10.77.0.12",
      role: "worker",
    });

    let peerCleanupShouldFail = true;
    const nodeRemovalService = createNodeRemovalService({
      repo,
      removeOwnedPeer: async () => {
        if (peerCleanupShouldFail) {
          throw new Error("Peer cleanup unreachable");
        }
      },
      unlinkManagedEndpoints: async () => {},
    });

    const handler = createFleetApiHandler({
      repo,
      verifyAuth: (c) => c === "valid-secret",
      nodeRemovalService,
    });

    const adminAuth = {
      authorization: "Bearer valid-secret",
    };

    // 1. Unauthenticated DELETE returns 401
    const unauthDelete = createMockRequestResponse("DELETE", `/api/fleet/nodes/${worker.id}`);
    await handler(unauthDelete.req, unauthDelete.res, `/api/fleet/nodes/${worker.id}`);
    assert.equal(unauthDelete.res.statusCode, 401);

    // 1b. Missing nodeRemovalService returns 503 without revoking or removing node
    const unconfHandler = createFleetApiHandler({
      repo,
      verifyAuth: (c) => c === "valid-secret",
    });
    const unconfDelete = createMockRequestResponse("DELETE", `/api/fleet/nodes/${worker.id}`, adminAuth);
    await unconfHandler(unconfDelete.req, unconfDelete.res, `/api/fleet/nodes/${worker.id}`);
    assert.equal(unconfDelete.res.statusCode, 503);
    assert.equal((await repo.getNode(worker.id))?.id, worker.id);

    // 2. Non-existent node returns 404
    const notFoundDelete = createMockRequestResponse("DELETE", "/api/fleet/nodes/missing-node", adminAuth);
    await handler(notFoundDelete.req, notFoundDelete.res, "/api/fleet/nodes/missing-node");
    assert.equal(notFoundDelete.res.statusCode, 404);

    // 3. Controller deletion returns 409
    const ctrlDelete = createMockRequestResponse("DELETE", `/api/fleet/nodes/${ctrl.id}`, adminAuth);
    await handler(ctrlDelete.req, ctrlDelete.res, `/api/fleet/nodes/${ctrl.id}`);
    assert.equal(ctrlDelete.res.statusCode, 409);

    // 4. Worker deletion with failing cleanup returns 202 pending
    const pendingDelete = createMockRequestResponse("DELETE", `/api/fleet/nodes/${worker.id}`, adminAuth);
    await handler(pendingDelete.req, pendingDelete.res, `/api/fleet/nodes/${worker.id}`);
    assert.equal(pendingDelete.res.statusCode, 202);
    assert.equal(pendingDelete.res.body?.removal?.status, "pending");

    // 5. GET /api/fleet/node-removals returns pending removals list
    const listReq = createMockRequestResponse("GET", "/api/fleet/node-removals", adminAuth);
    await handler(listReq.req, listReq.res, "/api/fleet/node-removals");
    assert.equal(listReq.res.statusCode, 200);
    assert.ok(listReq.res.body?.removals);
    assert.equal(listReq.res.body.removals.length, 1);
    assert.equal(listReq.res.body.removals[0].nodeId, worker.id);

    // 6. GET /api/fleet/node-removals/:id returns detail
    const detailReq = createMockRequestResponse("GET", `/api/fleet/node-removals/${worker.id}`, adminAuth);
    await handler(detailReq.req, detailReq.res, `/api/fleet/node-removals/${worker.id}`);
    assert.equal(detailReq.res.statusCode, 200);
    assert.equal(detailReq.res.body?.removal?.nodeId, worker.id);

    // 7. Retry with successful cleanup returns 200 completed
    peerCleanupShouldFail = false;
    const retryReq = createMockRequestResponse("POST", `/api/fleet/node-removals/${worker.id}/retry`, adminAuth);
    await handler(retryReq.req, retryReq.res, `/api/fleet/node-removals/${worker.id}/retry`);
    assert.equal(retryReq.res.statusCode, 200);
    assert.equal(retryReq.res.body?.removal?.status, "completed");

    // 8. GET /api/fleet/node-removals now has 0 pending
    const emptyList = createMockRequestResponse("GET", "/api/fleet/node-removals", adminAuth);
    await handler(emptyList.req, emptyList.res, "/api/fleet/node-removals");
    assert.equal(emptyList.res.statusCode, 200);
    assert.equal(emptyList.res.body?.removals?.length, 0);
  } finally {
    repo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
