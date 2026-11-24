import "./load-env.js";
import { getRequestListener } from "@hono/node-server";
import { createApiApp } from "./api/app.js";
import * as nineRouterClient from "./nine-router-client.js";
import * as appConfig from "./app-config.js";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import next from "next";
import {
  getSettingsSecrets,
  getSettingsPublic,
  onSettingsChange,
  updateSettings,
  verifyControlPassword,
} from "./app-config.js";
import { logActivity, logScoped } from "./activity-log.js";
import { createAntigravityRotator } from "./antigravity-rotator.js";
import { createUnifiedSyncCoordinator } from "./unified-sync-coordinator.js";
import {
  clearNineRouterSession,
  nineRouterConfigured,
  testNineRouterConnection,
} from "./nine-router-client.js";
import { acquireDataLease } from "../db/common/maintenance-lease.js";
import { triggerFullBackupAndSync } from "./backup/git-sync.js";
import { requireDashboardAuth } from "./session-auth.js";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

const dataDir = path.resolve(process.env.APP_DATA_DIR || path.join(root, "data"));
const releaseDataLease = acquireDataLease(dataDir, "application");
const antigravityRotator = createAntigravityRotator({ dataDir });
const unifiedSyncCoordinator = createUnifiedSyncCoordinator({ antigravityRotator });

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
  _request: http.IncomingMessage,
  response: http.ServerResponse,
  _pathname: string,
) {
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
      });
      return json(response, { started: true, snapshot });
    } catch (err) {
      return json(response, { started: false, error: (err as Error).message }, 500);
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
        antigravityRotatorEnabled:
          body.antigravityRotatorEnabled !== undefined
            ? Boolean(body.antigravityRotatorEnabled)
            : undefined,
        antigravityRotateMinutes:
          body.antigravityRotateMinutes !== undefined
            ? Number(body.antigravityRotateMinutes)
            : undefined,
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
  const configured = nineRouterConfigured();
  const rotationDue =
    configured &&
    settings.antigravityRotatorEnabled !== false &&
    now - lastScheduledRotationAt >= Math.max(1, settings.antigravityRotateMinutes) * 60_000;

  logScoped("Server", "runScheduledMaintenance", "info", "Maintenance tick", {
    configured,
    rotationDue,
  });
  if (rotationDue) lastScheduledRotationAt = now;

  try {
    const report = await unifiedSyncCoordinator.runUnifiedSyncCycle({
      force: false,
      rotation: rotationDue,
    });
    if (report.error) {
      const maintError = report.error;
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
    changed.some((key) => ["antigravityRotateMinutes", "antigravityRotatorEnabled"].includes(key))
  ) {
    scheduleMaintenance();
  }
  void triggerFullBackupAndSync().catch((err) => {
    logActivity("warn", `Settings change backup sync failed: ${(err as Error).message}`);
  });
});

async function main() {
  const app = next({ dev, dir: root });
  const handle = app.getRequestHandler();
  await app.prepare();

  const apiApp = createApiApp({
    verifyControlPassword,
    antigravityRotator,
    unifiedSyncCoordinator,
    router: nineRouterClient,
    settings: appConfig,
    legacyHandlers: {
      handleNineRouter,
      handleAntigravity,
      handleSettings,
    },
  });
  const apiRequestListener = getRequestListener(apiApp.fetch);
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (!pathname.startsWith("/api/")) return handle(request, response);

    return apiRequestListener(request, response);
  });

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
