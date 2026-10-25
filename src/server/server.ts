import "./load-env.js";
import { getRequestListener } from "@hono/node-server";
import { createApiApp } from "./api/app.js";
import * as nineRouterClient from "./nine-router-client.js";
import * as appConfig from "./app-config.js";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import next from "next";
import {
  getNineRouterUrls,
  getSettingsSecrets,
  getSettingsPublic,
  onSettingsChange,
  updateSettings,
  verifyControlPassword,
} from "./app-config.js";
import { logActivity, logActivityThrottled, logScoped } from "./activity-log.js";
import { createPoolRanker, PoolConflictError } from "./pool-ranker.js";
import { createAntigravityRotator } from "./antigravity-rotator.js";
import { createUnifiedSyncCoordinator } from "./unified-sync-coordinator.js";
import { openSyncRepository } from "./dual-router/repository.js";
import { openSyncDb } from "../db/sync/client.js";
import { createProxyOwnershipAuthority } from "./antigravity-ownership.js";
import { createRouterAdapter } from "./dual-router/adapter.js";
import { createDualRouterCoordinator } from "./dual-router/coordinator.js";
import { createDualRouterScheduler } from "./dual-router/scheduler.js";
import {
  clearNineRouterSession,
  listAntigravityConnections,
  nineRouterConfigured,
  testNineRouterConnection,
  updateConnection,
} from "./nine-router-client.js";
import { testPool, createPool, deletePool } from "./nine-router-client.js";
import { openProxyIntelligenceDb } from "./proxy-intelligence-db.js";
import { createProxyIntelligenceRepository } from "./proxy-intelligence-repository.js";
import { createFleetRepository } from "../proxyfleet/db.js";
import { createFleetApiHandler } from "../proxyfleet/api-router.js";
import { createProxyCheckHandler } from "./proxy-check-handler.js";
import {
  createFleetWireGuardManager,
  validateFleetWireGuardSettings,
  verifyFleetWireGuardAbsent,
  type FleetWireGuardManager,
} from "../proxyfleet/wireguard.js";
import { createFleetRuntimeApi } from "../proxyfleet/runtime-api.js";
import { createControllerRuntimeObserver } from "../proxyfleet/controller-runtime.js";
import { auditManagedFleetEndpoints } from "../proxyfleet/endpoint-audit.js";
import { auditRouterGooglePools } from "../proxyfleet/google-code-audit.js";
import { syncFleetEndpointsToIntelligence } from "../proxyfleet/pipeline-adapter.js";
import { createNodeRemovalService } from "../proxyfleet/node-removal.js";
import { createEnrollmentService } from "../proxyfleet/enrollment.js";
import { createProvisioningService } from "../proxyfleet/provisioning.js";
import { acquireDataLease } from "../db/common/maintenance-lease.js";
import { triggerFullBackupAndSync } from "./backup/git-sync.js";
import type { FleetOverlayObservation } from "../proxyfleet/runtime.js";
import {
  createSession,
  readSession,
  revokeSession,
  sessionCookie,
  clearSessionCookie,
  requireDashboardAuth,
} from "./session-auth.js";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

const dataDir = path.resolve(process.env.APP_DATA_DIR || path.join(root, "data"));
const releaseDataLease = acquireDataLease(dataDir, "application");
const proxyIntelligenceDb = openProxyIntelligenceDb(dataDir);
const proxyIntelligenceRepo = createProxyIntelligenceRepository({
  db: proxyIntelligenceDb,
});
const handleProxyCheck = createProxyCheckHandler({
  db: proxyIntelligenceDb,
  repo: proxyIntelligenceRepo,
  testPool,
  readBody,
  json,
});

const fleetRepo = createFleetRepository({
  sqlitePath: path.join(dataDir, "fleet.sqlite3"),
});
const controllerObserver = createControllerRuntimeObserver();
const fleetReady = fleetRepo.migrate().then(async () => {
  const node = await fleetRepo.bootstrapControllerNode({
    name: os.hostname() || "controller-node",
    wireguardIp: "10.77.0.1",
    os: process.platform,
    arch: process.arch,
    agentVersion: "0.2.0",
  });
  await fleetRepo.startRuntimeSession(node.id, controllerObserver.sessionId);
  await fleetRepo.recordNodeDevice(node.id, controllerObserver.device);
  return node;
});
let overlayManager: FleetWireGuardManager | null = null;
let overlaySettingsKey = "";
function getFleetWireguard() {
  const settings = getSettingsSecrets().fleetWireguard;
  if (!settings) return null;
  const key = JSON.stringify(settings);
  if (!overlayManager || overlaySettingsKey !== key) {
    overlayManager = createFleetWireGuardManager(settings);
    overlaySettingsKey = key;
  }
  return { manager: overlayManager, settings };
}
const handleFleetRuntimeApi = createFleetRuntimeApi({
  repo: fleetRepo,
  getWireguard: getFleetWireguard,
  readBody,
  send: json,
});
const nodeRemovalService = createNodeRemovalService({
  repo: fleetRepo,
  removeOwnedPeer: async (record) => {
    const configured = getFleetWireguard();
    if (configured) {
      await configured.manager.removePeer(record);
      return;
    }
    const absent = await verifyFleetWireGuardAbsent();
    if (!absent) {
      throw new Error(
        "ProxyFleet WireGuard cleanup requires verified controller setup; IP remains reserved",
      );
    }
  },
  unlinkManagedEndpoints: async (nodeId) => {
    await proxyIntelligenceRepo.unlinkManagedFleetNode(nodeId, {
      cleanupRemoteRef: cleanupRemotePoolRef,
    });
  },
});
async function cleanupRemotePoolRef(remoteId: string): Promise<void> {
  const connections = await listAntigravityConnections();
  await Promise.all(
    connections
      .filter((connection) => connection.providerSpecificData?.proxyPoolId === remoteId)
      .map((connection) => {
        const providerSpecificData = {
          ...(connection.providerSpecificData ?? {}),
        };
        delete providerSpecificData.proxyPoolId;
        return updateConnection(connection.id, { providerSpecificData });
      }),
  );
  await deletePool(remoteId);
}
const handleFleetApi = createFleetApiHandler({
  repo: fleetRepo,
  verifyAuth: verifyControlPassword,
  nodeRemovalService,
  provisioningService: createProvisioningService({ repo: fleetRepo }),
  enrollmentService: {
    issueToken: (input) => createEnrollmentService(fleetRepo).issueToken(input),
    enrollNode: async (input) => {
      const configured = getFleetWireguard();
      if (!configured)
        throw new Error("Configure and set up ProxyFleet WireGuard before enrolling nodes");
      const ready = await configured.manager.preflight();
      const enrolled = await createEnrollmentService(fleetRepo, {
        serverWireguardPublicKey: ready.publicKey,
        serverWireguardEndpoint: configured.settings.publicEndpoint,
      }).enrollNode(input);
      fleetRepo.setOverlayApproved(enrolled.nodeId, true);
      return enrolled;
    },
  },
});
const poolRanker = createPoolRanker({
  dataDir,
  unbindConnectionsFromPool: async (remoteId) => {
    const connections = await listAntigravityConnections();
    await Promise.all(
      connections
        .filter((connection) => connection.providerSpecificData?.proxyPoolId === remoteId)
        .map((connection) => {
          const providerSpecificData = {
            ...(connection.providerSpecificData ?? {}),
          };
          delete providerSpecificData.proxyPoolId;
          return updateConnection(connection.id, { providerSpecificData });
        }),
    );
  },
  onSoftDelete: (key, err) => proxyIntelligenceRepo.softDeleteFromRouter(key, err),
  onTestResult: (key, ok, lat, err) => proxyIntelligenceRepo.recordTestResult(key, ok, lat, err),
});
const antigravityRotator = createAntigravityRotator({
  dataDir,
  getUsableProxies: () =>
    Object.values(poolRanker.readState().pools)
      .filter((p) => p.status === "usable" && Boolean(p.remoteId))
      .map((p) => ({ remoteId: p.remoteId!, name: p.name })),
});
const dualRouterRepo = openSyncRepository(path.join(dataDir, "router-sync.sqlite3"));
const routerSettings = getSettingsSecrets();
const routerUrls = getNineRouterUrls(routerSettings);
const ownershipKeyPath = process.env.ANTIGRAVITY_AUTHORITY_PRIVATE_KEY_PATH;
const ownershipClient = ownershipKeyPath
  ? openSyncDb(path.join(dataDir, "router-sync.sqlite3"))
  : null;
const antigravityOwnership =
  ownershipClient && ownershipKeyPath
    ? createProxyOwnershipAuthority(ownershipClient.raw, fs.readFileSync(ownershipKeyPath, "utf8"))
    : undefined;
const dualRouterAdapters = routerUrls.map((url, idx) =>
  createRouterAdapter({
    routerId: idx === 0 ? "router-1" : `router-${idx + 1}`,
    url,
    password: routerSettings.nineRouterPassword,
    apiKey: routerSettings.nineRouterApiKey,
  }),
);
const dualRouterCoordinator = createDualRouterCoordinator({
  repository: dualRouterRepo,
  adapters: dualRouterAdapters,
});
const dualRouterScheduler = createDualRouterScheduler({
  repository: dualRouterRepo,
  coordinator: dualRouterCoordinator,
});

let lastFleetAuditAt = 0;
const unifiedSyncCoordinator = createUnifiedSyncCoordinator({
  poolRanker,
  antigravityRotator,
  proxyIntelligenceRepo,
  dualRouterScheduler,
  fleetMaintenance: async () => {
    const controller = await fleetReady;
    await nodeRemovalService.retryPending();
    const configured = getFleetWireguard();
    let overlay: FleetOverlayObservation;
    if (configured) {
      try {
        const nodes = await fleetRepo.listNodes();
        const approvedIds = new Set(fleetRepo.getApprovedNodeIds());
        const peers = nodes
          .filter(
            (node) =>
              node.role !== "controller-worker" &&
              node.wireguard_public_key &&
              approvedIds.has(node.id),
          )
          .map((node) => ({
            nodeId: node.id,
            publicKey: node.wireguard_public_key!,
            address: node.wireguard_ip,
          }));
        await configured.manager.reconcilePeers(peers);
        overlay = await configured.manager.observe();
      } catch (error) {
        const errMessage =
          error instanceof Error ? error.message : "WireGuard reconciliation failed";
        overlay = {
          state: "unhealthy",
          interfacePresent: null,
          peerPresent: null,
          lastHandshakeAt: null,
          probeOk: false,
          rxBytes: null,
          txBytes: null,
          error: errMessage,
          lastRecoveryAt: null,
        };
      }
    } else {
      overlay = {
        state: "unknown",
        interfacePresent: null,
        peerPresent: null,
        lastHandshakeAt: null,
        probeOk: null,
        rxBytes: null,
        txBytes: null,
        error: "ProxyFleet WireGuard is not configured",
        lastRecoveryAt: null,
      };
    }
    const endpoints = await fleetRepo.listEndpoints({
      nodeId: controller.id,
      enabled: true,
    });
    await fleetRepo.recordNodeRuntime(
      controller.id,
      await controllerObserver.sample(endpoints, overlay),
    );
    await fleetRepo.recordHeartbeat(controller.id, {
      status: "online",
      agentVersion: "0.2.0",
    });
    const syncedEndpoints = await syncFleetEndpointsToIntelligence(
      fleetRepo,
      proxyIntelligenceRepo,
    );
    await proxyIntelligenceRepo.cleanupPendingManagedFleetEndpoints({
      cleanupRemoteRef: cleanupRemotePoolRef,
    });
    if (Date.now() - lastFleetAuditAt >= 60_000) {
      lastFleetAuditAt = Date.now();
      await auditManagedFleetEndpoints(fleetRepo, proxyIntelligenceRepo);
      await auditRouterGooglePools(
        proxyIntelligenceDb,
        routerUrls.map((url) => ({ url, timeoutMs: 8_000 })),
      );
    }
    return {
      pendingRemovals: (await fleetRepo.listPendingNodeRemovals()).length,
      syncedEndpoints,
    };
  },
});

function auth(request: http.IncomingMessage): boolean {
  if (requireDashboardAuth(request).authenticated) return true;
  const parsedUrl = new URL(request.url ?? "/", "http://localhost");
  const queryAuth =
    parsedUrl.searchParams.get("password") ||
    parsedUrl.searchParams.get("auth") ||
    parsedUrl.searchParams.get("token");
  if (queryAuth && verifyControlPassword(queryAuth)) {
    return true;
  }
  return false;
}

function json(response: http.ServerResponse, payload: unknown, status = 200) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": body.length,
  });
  response.end(body);
}

function readBody(
  request: http.IncomingMessage,
  maxBytes = 1_000_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    request.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        request.destroy();
        const err = new Error("Request payload too large") as Error & {
          status?: number;
        };
        err.status = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

async function handleNineRouter(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  pathname: string,
) {
  if (request.method === "GET" && pathname === "/api/ninerouter/status") {
    return json(response, poolRanker.getStatus());
  }

  if (request.method === "GET" && pathname === "/api/ninerouter/metrics") {
    const url = new URL(request.url ?? "/", "http://localhost");
    const hours = Number(url.searchParams.get("hours") ?? 24);
    const sinceMs = Date.now() - hours * 60 * 60 * 1000;
    return json(response, { snapshots: poolRanker.getMetrics(sinceMs) });
  }

  if (request.method === "GET" && pathname === "/api/ninerouter/pools") {
    await poolRanker.startSyncIfStale().catch(() => {});
    const tier = new URL(request.url ?? "/", "http://localhost").searchParams.get("tier");
    const pools = poolRanker.listByTier(tier).sort((a, b) => {
      if (a.tier === "active" && b.tier !== "active") return -1;
      if (b.tier === "active" && a.tier !== "active") return 1;
      return (a.latency_ms ?? Number.MAX_SAFE_INTEGER) - (b.latency_ms ?? Number.MAX_SAFE_INTEGER);
    });
    const status = poolRanker.getStatus();
    if (pools.length === 0 && !status.running) {
      if (!status.configured) {
        logActivityThrottled(
          "refresh-no-password",
          "warn",
          "Refresh: NINEROUTER_PASSWORD not set — cannot sync",
        );
      } else if (!status.lastSyncAt) {
        logActivityThrottled(
          "refresh-no-sync",
          "warn",
          "Refresh: no sync yet — click Sync now to pull proxies from 9Router",
        );
      } else if (status.stats.total === 0) {
        logActivityThrottled(
          "refresh-empty-pool",
          "warn",
          "Refresh: 0 proxies in pool state — 9Router may have no pools",
        );
      } else if (status.stats.active === 0 && status.stats.reserve === 0) {
        logActivityThrottled(
          "refresh-all-dead",
          "warn",
          `Refresh: 0 active/reserve (${status.stats.dead} dead) — all proxies failed checks`,
        );
      } else if (tier === "active") {
        logActivityThrottled(
          "refresh-no-active",
          "info",
          `Refresh: 0 active proxies shown (${status.stats.reserve} in reserve)`,
        );
      }
    }
    const fresh = poolRanker.getStatus();
    return json(response, {
      pools,
      stats: fresh.stats,
      activity: fresh.activity,
      syncProgress: fresh.syncProgress,
    });
  }

  if (request.method === "POST" && pathname === "/api/ninerouter/sync") {
    if (poolRanker.isSyncing()) return json(response, { started: false, running: true }, 202);
    poolRanker.syncPools({ force: true }).catch((error) => {
      const message = (error as Error).message;
      logActivity("error", `Sync failed: ${message}`);
      console.error("9Router sync failed:", message);
    });
    return json(response, { started: true }, 202);
  }
  if (request.method === "POST" && pathname === "/api/ninerouter/activate") {
    const body = await readBody(request);
    const targetId = body.localId ?? body.id;
    if (!targetId || body.isActive === undefined) {
      return json(response, { error: "id and isActive are required" }, 400);
    }
    try {
      const pool = await poolRanker.activatePool(String(targetId), body.isActive === true);
      return json(response, { pool });
    } catch (error) {
      const message = (error as Error).message;
      return json(response, { error: message }, message.includes("limit") ? 409 : 400);
    }
  }

  const poolActionMatch = pathname.match(/^\/api\/ninerouter\/pools\/([^/]+)(?:\/(restore))?$/);
  if (poolActionMatch) {
    const localId = decodeURIComponent(poolActionMatch[1]);
    const action = poolActionMatch[2];

    if (request.method === "PATCH" && !action) {
      const body = await readBody(request);
      if (typeof body.name !== "string") {
        return json(response, { error: "name is required" }, 400);
      }
      try {
        const pool = await poolRanker.renamePool(localId, body.name);
        return json(response, { pool });
      } catch (error) {
        if (error instanceof PoolConflictError) {
          return json(response, { error: error.message }, 409);
        }
        const err = error as Error & { status?: number };
        const message = err.message || "Failed to rename pool";
        if (message.includes("not found")) return json(response, { error: message }, 404);
        if (message.includes("cannot be empty") || message.includes("cannot exceed")) {
          return json(response, { error: message }, 400);
        }
        return json(response, { error: message }, 502);
      }
    }

    if (request.method === "DELETE" && !action) {
      try {
        const pool = await poolRanker.removePool(localId);
        return json(response, { pool });
      } catch (error) {
        const err = error as Error & { status?: number };
        const message = err.message || "Failed to delete pool";
        if (message.includes("not found")) return json(response, { error: message }, 404);
        return json(response, { error: message }, 502);
      }
    }
  }
  if (request.method === "POST" && pathname === "/api/ninerouter/sync-all") {
    try {
      const report = await unifiedSyncCoordinator.runUnifiedSyncCycle({
        force: true,
      });
      const statusCode = !report.started
        ? 409
        : report.error || report.fleetResult?.error
          ? 502
          : 200;
      return json(response, report, statusCode);
    } catch (err) {
      return json(response, { error: (err as Error).message }, 500);
    }
  }

  return json(response, { error: "not found" }, 404);
}

async function handleAntigravity(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  pathname: string,
) {
  if (request.method === "GET" && pathname === "/api/antigravity/status") {
    return json(response, antigravityRotator.getSnapshot());
  }
  if (request.method === "POST" && pathname === "/api/antigravity/refresh") {
    try {
      const snapshot = await antigravityRotator.runRotation({
        force: true,
        reassignForbidden: true,
      });
      return json(response, { started: true, snapshot });
    } catch (err) {
      return json(response, { started: false, error: (err as Error).message }, 500);
    }
  }
  if (request.method === "POST" && pathname === "/api/antigravity/reset-proxies") {
    try {
      const result = await antigravityRotator.resetProxies({ forceAll: true });
      return json(response, result);
    } catch (err) {
      return json(response, { ok: false, error: (err as Error).message }, 500);
    }
  }
  if (request.method === "POST" && pathname === "/api/antigravity/optimize-by-speed") {
    try {
      const result = await antigravityRotator.optimizeSpeed();
      return json(response, { ok: true, ...result });
    } catch (err) {
      return json(response, { ok: false, error: (err as Error).message }, 500);
    }
  }
  return json(response, { error: "not found" }, 404);
}

async function handleSettings(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  pathname: string,
) {
  if (!requireDashboardAuth(request).authenticated) {
    return json(response, { error: "Unauthorized" }, 401);
  }
  if (request.method === "GET" && pathname === "/api/settings") {
    return json(response, getSettingsPublic());
  }

  if (request.method === "PUT" && pathname === "/api/settings") {
    try {
      const body = await readBody(request);
      const result = updateSettings({
        controlPassword:
          typeof body.controlPassword === "string" ? body.controlPassword : undefined,
        currentPassword:
          typeof body.currentPassword === "string" ? body.currentPassword : undefined,
        nineRouterUrl:
          typeof body.nineRouterUrl === "string" ? body.nineRouterUrl.trim() : undefined,
        nineRouterPassword:
          typeof body.nineRouterPassword === "string" ? body.nineRouterPassword : undefined,
        nineRouterApiKey:
          typeof body.nineRouterApiKey === "string" ? body.nineRouterApiKey : undefined,
        activePoolLimit:
          body.activePoolLimit !== undefined ? Number(body.activePoolLimit) : undefined,
        nineRouterAutoSync:
          body.nineRouterAutoSync !== undefined ? Boolean(body.nineRouterAutoSync) : undefined,
        nineRouterSyncMinutes:
          body.nineRouterSyncMinutes !== undefined ? Number(body.nineRouterSyncMinutes) : undefined,
        checkConcurrency:
          body.checkConcurrency !== undefined ? Number(body.checkConcurrency) : undefined,
        checkTimeoutMs: body.checkTimeoutMs !== undefined ? Number(body.checkTimeoutMs) : undefined,
        proxyTtlMinutes:
          body.proxyTtlMinutes !== undefined ? Number(body.proxyTtlMinutes) : undefined,
        antigravityRotatorEnabled:
          body.antigravityRotatorEnabled !== undefined
            ? Boolean(body.antigravityRotatorEnabled)
            : undefined,
        antigravityActiveLimit:
          body.antigravityActiveLimit !== undefined
            ? Number(body.antigravityActiveLimit)
            : undefined,
        antigravityRotateMinutes:
          body.antigravityRotateMinutes !== undefined
            ? Number(body.antigravityRotateMinutes)
            : undefined,
        antigravitySessionThreshold:
          body.antigravitySessionThreshold !== undefined
            ? Number(body.antigravitySessionThreshold)
            : undefined,
        fleetWireguard:
          body.fleetWireguard === undefined
            ? undefined
            : body.fleetWireguard === null
              ? null
              : validateFleetWireGuardSettings(body.fleetWireguard),
      });
      return json(response, result);
    } catch (error) {
      return json(response, { error: (error as Error).message }, 400);
    }
  }

  if (request.method === "POST" && pathname === "/api/settings/test-ninerouter") {
    const body = await readBody(request);
    const overrides = {
      url: typeof body.nineRouterUrl === "string" ? body.nineRouterUrl.trim() : undefined,
      password:
        typeof body.nineRouterPassword === "string" && body.nineRouterPassword.trim()
          ? body.nineRouterPassword
          : undefined,
      apiKey:
        typeof body.nineRouterApiKey === "string" && body.nineRouterApiKey.trim()
          ? body.nineRouterApiKey
          : undefined,
    };
    const result = await testNineRouterConnection(overrides);
    return json(response, result, result.ok ? 200 : 502);
  }
  if (request.method === "GET" && pathname === "/api/settings/proxy-export") {
    const parsedUrl = new URL(request.url ?? "/", "http://localhost");
    const format = parsedUrl.searchParams.get("format") === "csv" ? "csv" : "txt";
    const confirm = parsedUrl.searchParams.get("confirmCredentials");
    const requestedCreds = parsedUrl.searchParams.get("includeCredentials") === "true";
    const includeCredentials = requestedCreds && (confirm === "yes" || confirm === "true");

    if (requestedCreds && !includeCredentials) {
      return json(
        response,
        {
          error: "Exporting credentials requires explicit confirmation (confirmCredentials=yes)",
        },
        403,
      );
    }
    const scopeParam = parsedUrl.searchParams.get("scope");
    const scope = scopeParam === "usable" || scopeParam === "all" ? scopeParam : "active";

    let exportData = poolRanker.exportActiveProxies({
      format,
      includeCredentials,
      scope,
    });

    if (exportData.count === 0) {
      const fallback = await proxyIntelligenceRepo.exportWorkingProxies({
        format,
        includeCredentials,
      });
      if (fallback.body.trim()) {
        exportData = {
          filename: fallback.filename,
          contentType: fallback.contentType,
          body: fallback.body,
          count: fallback.body.split("\n").length,
        };
      }
    }

    response.writeHead(200, {
      "Content-Type": exportData.contentType,
      "Content-Disposition": `attachment; filename="${exportData.filename}"`,
      "Cache-Control": "no-store",
    });
    response.end(exportData.body);
    return;
  }

  return json(response, { error: "not found" }, 404);
}

const dev = process.env.NODE_ENV !== "production" && process.env.npm_lifecycle_event !== "start";
const port = Number(process.env.PORT || 1300);

let maintenanceIntervalId: NodeJS.Timeout | undefined;
let lastScheduledRotationAt = 0;
let lastScheduledBackupAt = 0;

async function runScheduledMaintenance() {
  const settings = getSettingsSecrets();
  const now = Date.now();
  const lastSyncAt = poolRanker.readState().lastSyncAt ?? 0;
  const configured = nineRouterConfigured();
  const routerDue =
    configured &&
    settings.nineRouterAutoSync !== false &&
    now - lastSyncAt >= Math.max(1, settings.nineRouterSyncMinutes) * 60_000;
  const rotationDue =
    configured &&
    settings.antigravityRotatorEnabled !== false &&
    now - lastScheduledRotationAt >= Math.max(1, settings.antigravityRotateMinutes) * 60_000;

  logScoped("Server", "runScheduledMaintenance", "info", "Maintenance tick", {
    configured,
    routerDue,
    rotationDue,
    lastSyncAgoMs: lastSyncAt > 0 ? now - lastSyncAt : null,
  });

  if (rotationDue) lastScheduledRotationAt = now;
  if (configured && !routerDue) {
    void poolRanker.refreshRemoteTracking().catch((err) => {
      logScoped(
        "Server",
        "refreshRemoteTracking",
        "error",
        `Remote tracking refresh failed: ${(err as Error).message}`,
      );
    });
  }
  try {
    const report = await unifiedSyncCoordinator.runUnifiedSyncCycle({
      force: false,
      router: routerDue,
      rotation: rotationDue,
    });
    if (report.error || report.fleetResult?.error) {
      const maintError = report.error || report.fleetResult?.error;
      logScoped(
        "Server",
        "runScheduledMaintenance",
        "error",
        `Scheduled maintenance failed: ${maintError}`,
      );
    }
  } catch (cycleErr) {
    logScoped(
      "Server",
      "runScheduledMaintenance",
      "error",
      `Scheduled maintenance cycle exception: ${(cycleErr as Error).message}`,
    );
  }
  if (now - lastScheduledBackupAt >= 30 * 60_000) {
    lastScheduledBackupAt = now;
    void triggerFullBackupAndSync().catch((err) => {
      logScoped(
        "Server",
        "triggerFullBackupAndSync",
        "warn",
        `Scheduled backup sync failed: ${(err as Error).message}`,
      );
    });
  }
}

function scheduleMaintenance() {
  clearInterval(maintenanceIntervalId);
  maintenanceIntervalId = setInterval(() => {
    void runScheduledMaintenance().catch((error) =>
      logScoped(
        "Server",
        "runScheduledMaintenance",
        "error",
        `Scheduled maintenance interval failed: ${(error as Error).message}`,
      ),
    );
  }, 15_000);
  void runScheduledMaintenance().catch((error) =>
    logScoped(
      "Server",
      "runScheduledMaintenance",
      "error",
      `Startup maintenance failed: ${(error as Error).message}`,
    ),
  );
}

onSettingsChange((_settings, changed) => {
  if (
    changed.some((key) => ["nineRouterUrl", "nineRouterPassword", "nineRouterApiKey"].includes(key))
  ) {
    clearNineRouterSession();
    import("./ninerouter-node-proxy.js").then((mod) => mod.clearNodeCookies()).catch(() => {});
  }
  if (
    changed.some((key) =>
      [
        "nineRouterSyncMinutes",
        "nineRouterAutoSync",
        "antigravityRotateMinutes",
        "antigravityRotatorEnabled",
      ].includes(key),
    )
  ) {
    scheduleMaintenance();
  }
  if (
    changed.includes("antigravityActiveLimit") ||
    changed.includes("antigravitySessionThreshold")
  ) {
    antigravityRotator.runRotation({ force: true }).catch((err) => {
      logActivity(
        "error",
        `Antigravity rotation on settings change failed: ${(err as Error).message}`,
      );
    });
  }
  void triggerFullBackupAndSync().catch((err) => {
    logActivity("warn", `Settings change backup sync failed: ${(err as Error).message}`);
  });
});
async function handleIntelligence(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  pathname: string,
) {
  if (!requireDashboardAuth(request).authenticated) {
    return json(response, { error: "Unauthorized" }, 401);
  }
  const parsedUrl = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "GET" && pathname === "/api/intelligence/proxies") {
    const filter = {
      search: parsedUrl.searchParams.get("search") || undefined,
      source: parsedUrl.searchParams.get("source") || undefined,
      protocol: parsedUrl.searchParams.get("protocol") || undefined,
      lifecycle: (parsedUrl.searchParams.get("lifecycle") as any) || undefined,
      verdict: parsedUrl.searchParams.get("verdict") || undefined,
      page: Number(parsedUrl.searchParams.get("page") || "1"),
      pageSize: Number(parsedUrl.searchParams.get("pageSize") || "20"),
    };
    const page = await proxyIntelligenceRepo.listProxies(filter);
    return json(response, page);
  }

  if (request.method === "GET" && pathname.startsWith("/api/intelligence/proxies/")) {
    const proxyKey = decodeURIComponent(pathname.slice("/api/intelligence/proxies/".length));
    const detail = await proxyIntelligenceRepo.getProxy(proxyKey);
    if (!detail) return json(response, { error: "Proxy not found" }, 404);
    return json(response, { proxy: detail });
  }

  if (request.method === "POST" && pathname === "/api/intelligence/import") {
    const body = await readBody(request, 5_000_000);
    const source = typeof body.source === "string" ? body.source.trim() : "import.txt";
    const content = typeof body.content === "string" ? body.content : "";
    if (!content.trim()) return json(response, { error: "content cannot be empty" }, 400);
    const summary = await proxyIntelligenceRepo.importProxies({
      source,
      content,
    });
    return json(response, summary);
  }
  if (request.method === "POST" && pathname === "/api/intelligence/import/preview") {
    const body = await readBody(request, 5_000_000);
    const source = typeof body.source === "string" ? body.source.trim() : "import.txt";
    const content = typeof body.content === "string" ? body.content : "";
    if (!content.trim()) return json(response, { error: "content cannot be empty" }, 400);
    const preview = await proxyIntelligenceRepo.previewImport({
      source,
      content,
    });
    return json(response, { preview });
  }
  if (request.method === "POST" && pathname === "/api/intelligence/sync-working") {
    try {
      const pools = poolRanker.listByTier("all");
      const summary = await proxyIntelligenceRepo.syncWorkingPools(pools);
      return json(response, summary);
    } catch (err) {
      return json(response, { error: (err as Error).message }, 500);
    }
  }

  return json(response, { error: "not found" }, 404);
}
async function handleProxiesUnified(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  pathname: string,
) {
  if (!requireDashboardAuth(request).authenticated) {
    return json(response, { error: "Unauthorized" }, 401);
  }
  if (await handleProxyCheck(request, response, pathname)) return;
  const parsedUrl = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "GET" && pathname === "/api/proxies/unified") {
    const activePools = poolRanker.listByTier("active");
    const reservePools = poolRanker.listByTier("reserve");
    const activePoolEndpoints = new Set<string>();
    for (const p of activePools) {
      if (p.proxyUrl) {
        try {
          const u = new URL(p.proxyUrl);
          activePoolEndpoints.add(u.host);
        } catch {
          const cleaned =
            p.proxyUrl
              .replace(/^[a-zA-Z0-9]+:\/\//, "")
              .split("/")[0]
              .split("@")
              .pop() || "";
          if (cleaned) activePoolEndpoints.add(cleaned);
        }
      }
    }
    const reservePoolEndpoints = new Set<string>();
    for (const p of reservePools) {
      if (p.proxyUrl) {
        try {
          const u = new URL(p.proxyUrl);
          reservePoolEndpoints.add(u.host);
        } catch {
          const cleaned =
            p.proxyUrl
              .replace(/^[a-zA-Z0-9]+:\/\//, "")
              .split("/")[0]
              .split("@")
              .pop() || "";
          if (cleaned) reservePoolEndpoints.add(cleaned);
        }
      }
    }

    const filter = {
      status: parsedUrl.searchParams.get("health") || parsedUrl.searchParams.get("status") || "all",
      search: parsedUrl.searchParams.get("q") || parsedUrl.searchParams.get("search") || undefined,
      protocol: parsedUrl.searchParams.get("protocol") || undefined,
      source: parsedUrl.searchParams.get("source") || undefined,
      sort: (parsedUrl.searchParams.get("sort") as any) || undefined,
      direction: (parsedUrl.searchParams.get("direction") as any) || undefined,
      page: Math.max(1, Number(parsedUrl.searchParams.get("page") || "1")),
      pageSize: Math.max(1, Math.min(100, Number(parsedUrl.searchParams.get("pageSize") || "50"))),
      activePoolEndpoints,
      reservePoolEndpoints,
    };

    const res = await proxyIntelligenceRepo.getUnifiedProxies(filter);
    return json(response, res);
  }

  if (request.method === "GET" && pathname === "/api/proxies/detail") {
    const key = parsedUrl.searchParams.get("key");
    if (!key) return json(response, { error: "key is required" }, 400);
    const auditId = parsedUrl.searchParams.get("auditId") || undefined;
    const auditDetail = await proxyIntelligenceRepo.getAuditDetail(key, auditId);
    return json(response, { auditDetail });
  }

  if (request.method === "POST" && pathname === "/api/proxies/pin") {
    const body = (await readBody(request, 100_000).catch(() => ({}))) as Record<string, unknown>;
    const proxyKey = typeof body.proxyKey === "string" ? body.proxyKey : "";
    const isPinned = Boolean(body.isPinned);
    if (!proxyKey) return json(response, { error: "proxyKey is required" }, 400);
    try {
      await proxyIntelligenceRepo.setPin(proxyKey, isPinned);
      return json(response, { proxyKey, isPinned });
    } catch (err) {
      return json(response, { error: (err as Error).message }, 500);
    }
  }

  if (request.method === "POST" && pathname === "/api/proxies/tags") {
    const body = (await readBody(request, 100_000).catch(() => ({}))) as Record<string, unknown>;
    const proxyKey = typeof body.proxyKey === "string" ? body.proxyKey : "";
    const tags = Array.isArray(body.tags) ? body.tags.map(String) : [];
    if (!proxyKey) return json(response, { error: "proxyKey is required" }, 400);
    try {
      await proxyIntelligenceRepo.updateTags(proxyKey, tags);
      return json(response, { proxyKey, tags });
    } catch (err) {
      return json(response, { error: (err as Error).message }, 500);
    }
  }

  if (request.method === "POST" && pathname === "/api/proxies/unlink-router") {
    const body = (await readBody(request, 100_000).catch(() => ({}))) as Record<string, unknown>;
    const proxyKey = typeof body.proxyKey === "string" ? body.proxyKey : "";
    if (!proxyKey) return json(response, { error: "proxyKey is required" }, 400);
    const row = proxyIntelligenceDb.get<{ remote_id: string | null }>(
      "SELECT remote_id FROM proxies WHERE proxy_key = ?",
      [proxyKey],
    );
    if (!row) return json(response, { error: "Proxy not found" }, 404);
    try {
      if (row.remote_id) {
        await deletePool(row.remote_id).catch(() => {});
      }
      await proxyIntelligenceRepo.softDeleteFromRouter(proxyKey, "Unlinked by user");
      return json(response, { ok: true, proxyKey, routerState: "removed" });
    } catch (err) {
      return json(response, { error: (err as Error).message }, 500);
    }
  }

  if (request.method === "POST" && pathname === "/api/proxies/push-router") {
    const body = (await readBody(request, 100_000).catch(() => ({}))) as Record<string, unknown>;
    const proxyKey = typeof body.proxyKey === "string" ? body.proxyKey : "";
    if (!proxyKey) return json(response, { error: "proxyKey is required" }, 400);
    const row = proxyIntelligenceDb.get<{
      endpoint: string;
      protocol: string;
      remote_id: string | null;
    }>("SELECT endpoint, protocol, remote_id FROM proxies WHERE proxy_key = ?", [proxyKey]);
    if (!row) return json(response, { error: "Proxy not found" }, 404);
    try {
      const created = await createPool({
        name: row.endpoint,
        proxyUrl: `${row.protocol}://${row.endpoint}`,
        type: row.protocol,
        isActive: false,
      });
      proxyIntelligenceDb.run(
        "UPDATE proxies SET remote_id = ?, router_state = 'reserve', updated_at = ? WHERE proxy_key = ?",
        [created.id, Date.now(), proxyKey],
      );
      return json(response, {
        ok: true,
        proxyKey,
        remoteId: created.id,
        routerState: "reserve",
      });
    } catch (err) {
      return json(response, { error: (err as Error).message }, 500);
    }
  }

  if (
    request.method === "DELETE" &&
    (pathname === "/api/proxies/hard-delete" || pathname === "/api/proxies")
  ) {
    const key = parsedUrl.searchParams.get("key") || "";
    const force = parsedUrl.searchParams.get("force") === "true";
    if (!key) return json(response, { error: "key is required" }, 400);
    try {
      const res = await proxyIntelligenceRepo.hardDeleteProxy(key, force);
      if (res.remoteId) {
        await deletePool(res.remoteId).catch(() => {});
      }
      return json(response, { ok: true, deleted: res.deleted });
    } catch (err) {
      return json(response, { error: (err as Error).message }, 400);
    }
  }

  return json(response, { error: "not found" }, 404);
}

async function main() {
  await fleetReady;
  const app = next({ dev, dir: root });
  const handle = app.getRequestHandler();
  await app.prepare();

  const apiApp = createApiApp({
    verifyControlPassword,
    proxyIntelligenceRepo,
    fleetRepo,
    poolRanker,
    antigravityRotator,
    unifiedSyncCoordinator,
    dualRouterCoordinator,
    dualRouterScheduler,
    dualRouterRepo,
    dualRouterAdapters,
    fleetWireguard: getFleetWireguard,
    handleFleetRuntimeApi,
    handleFleetApi,
    handleProxyCheck,
    router: nineRouterClient,
    settings: appConfig,
    antigravityOwnership,
    antigravityRouters: routerUrls.map((url, index) => ({ routerId: `router-${index + 1}`, url })),
    legacyHandlers: {
      handleNineRouter,
      handleAntigravity,
      handleSettings,
      handleIntelligence,
      handleProxiesUnified,
    },
  });
  const apiRequestListener = getRequestListener(apiApp.fetch);
  const upgradeHandler = dev ? app.getUpgradeHandler() : null;
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method === "GET" && pathname === "/install-agent.sh") {
      const scriptPath = path.join(root, "scripts", "install-agent.sh");
      if (fs.existsSync(scriptPath)) {
        const content = fs.readFileSync(scriptPath);
        response.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Length": content.length,
          "Cache-Control": "no-cache",
        });
        response.end(content);
        return;
      }
    }
    if (request.method === "GET" && pathname.startsWith("/bin/")) {
      const binaryName = path.basename(pathname);
      const binPath = path.join(root, "bin", binaryName);
      if (fs.existsSync(binPath) && fs.statSync(binPath).isFile()) {
        const content = fs.readFileSync(binPath);
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": content.length,
          "Cache-Control": "no-cache",
        });
        response.end(content);
        return;
      }
    }
    if (!pathname.startsWith("/api/")) return handle(request, response);

    return apiRequestListener(request, response);
  });

  if (upgradeHandler) {
    server.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname === "/_next/webpack-hmr") return upgradeHandler(request, socket, head);
      socket.destroy();
    });
  }
  server.on("clientError", (err: NodeJS.ErrnoException, socket) => {
    if (err.code === "ECONNRESET" || !socket.writable) {
      return;
    }
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  server.listen(port, () => {
    console.log(`minhmiceProxy listening on http://localhost:${port}`);
    scheduleMaintenance();
  });
}

process.on("unhandledRejection", (reason) => {
  const detail = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason);
  console.error(`[process] unhandledRejection\n${detail}`);
});
process.on("uncaughtException", (error: Error & { code?: string }) => {
  if (error.code === "ECONNRESET" || error.message?.includes("ECONNRESET")) {
    return;
  }
  console.error(`[process] uncaughtException\n${error.stack ?? error}`);
});
function shutdown() {
  try {
    proxyIntelligenceDb.close();
  } catch {
    // ignore error on shutdown
  }
  try {
    fleetRepo.close();
  } catch {
    // ignore error on shutdown
  }
  try {
    dualRouterRepo.close();
  } catch {
    // ignore error on shutdown
  }
  releaseDataLease();
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
