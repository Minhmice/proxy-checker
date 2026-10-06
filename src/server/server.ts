import "./load-env.js";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import next from "next";
import { getSettingsSecrets, getSettingsPublic, onSettingsChange, updateSettings, verifyControlPassword } from "./app-config.js";
import { logActivity, logActivityThrottled } from "./activity-log.js";
import { createPoolRanker, PoolConflictError } from "./pool-ranker.js";
import { createAntigravityRotator } from "./antigravity-rotator.js";
import { clearNineRouterSession, nineRouterConfigured, testNineRouterConnection } from "./nine-router-client.js";
import { bulkSetActive, listPools, testPool } from "./nine-router-client.js";
import { openProxyIntelligenceDb } from "./proxy-intelligence-db.js";
import { createProxyIntelligenceRepository } from "./proxy-intelligence-repository.js";
import { createFleetRepository } from "../proxyfleet/db.js";
import { createFleetApiHandler } from "../proxyfleet/api-router.js";
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

const inputDir = path.join(root, "input");
const dataDir = path.join(root, "data");
const runtimeFile = path.join(root, "runtime", "9router-proxy.env");
const proxyIntelligenceDb = openProxyIntelligenceDb(dataDir);
const proxyIntelligenceRepo = createProxyIntelligenceRepository({ db: proxyIntelligenceDb });

const fleetRepo = createFleetRepository({ sqlitePath: path.join(dataDir, "fleet.sqlite3") });
void fleetRepo
  .migrate()
  .then(() =>
    fleetRepo.bootstrapControllerNode({
      name: "controller-001",
      wireguardIp: "10.77.0.1",
      os: process.platform,
      arch: process.arch,
      agentVersion: "0.1.0",
    })
  )
  .catch((err) => console.error("Fleet DB migration/bootstrap failed:", err));
const handleFleetApi = createFleetApiHandler({
  repo: fleetRepo,
  verifyAuth: verifyControlPassword,
});
const poolRanker = createPoolRanker({ dataDir });
const antigravityRotator = createAntigravityRotator({
  dataDir,
  getUsableProxies: () =>
    Object.values(poolRanker.readState().pools)
      .filter((p) => p.status === "usable" && Boolean(p.remoteId))
      .map((p) => ({ remoteId: p.remoteId!, name: p.name })),
});

function auth(request: http.IncomingMessage): boolean {
  if (requireDashboardAuth(request).authenticated) return true;
  const parsedUrl = new URL(request.url ?? "/", "http://localhost");
  const queryAuth = parsedUrl.searchParams.get("password") || parsedUrl.searchParams.get("auth") || parsedUrl.searchParams.get("token");
  if (queryAuth && verifyControlPassword(queryAuth)) {
    return true;
  }
  return false;
}

function json(response: http.ServerResponse, payload: unknown, status = 200) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": body.length });
  response.end(body);
}

function readBody(request: http.IncomingMessage, maxBytes = 1_000_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    request.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        request.destroy();
        const err = new Error("Request payload too large") as Error & { status?: number };
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

async function handleNineRouter(request: http.IncomingMessage, response: http.ServerResponse, pathname: string) {
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
        logActivityThrottled("refresh-no-password", "warn", "Refresh: NINEROUTER_PASSWORD not set — cannot sync");
      } else if (!status.lastSyncAt) {
        logActivityThrottled("refresh-no-sync", "warn", "Refresh: no sync yet — click Sync now to pull proxies from 9Router");
      } else if (status.stats.total === 0) {
        logActivityThrottled("refresh-empty-pool", "warn", "Refresh: 0 proxies in pool state — 9Router may have no pools");
      } else if (status.stats.active === 0 && status.stats.reserve === 0) {
        logActivityThrottled(
          "refresh-all-dead",
          "warn",
          `Refresh: 0 active/reserve (${status.stats.dead} dead) — all proxies failed checks`
        );
      } else if (tier === "active") {
        logActivityThrottled(
          "refresh-no-active",
          "info",
          `Refresh: 0 active proxies shown (${status.stats.reserve} in reserve)`
        );
      }
    }
    const fresh = poolRanker.getStatus();
    return json(response, { pools, stats: fresh.stats, activity: fresh.activity, syncProgress: fresh.syncProgress });
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

  return json(response, { error: "not found" }, 404);
}

async function handleAntigravity(request: http.IncomingMessage, response: http.ServerResponse, pathname: string) {
  if (request.method === "GET" && pathname === "/api/antigravity/status") {
    return json(response, antigravityRotator.getSnapshot());
  }
  if (request.method === "POST" && pathname === "/api/antigravity/refresh") {
    try {
      const snapshot = await antigravityRotator.runRotation({ force: true });
      return json(response, { started: true, snapshot });
    } catch (err) {
      return json(response, { started: false, error: (err as Error).message }, 500);
    }
  }
  return json(response, { error: "not found" }, 404);
}

async function handleSettings(request: http.IncomingMessage, response: http.ServerResponse, pathname: string) {
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
        controlPassword: typeof body.controlPassword === "string" ? body.controlPassword : undefined,
        currentPassword: typeof body.currentPassword === "string" ? body.currentPassword : undefined,
        nineRouterUrl: typeof body.nineRouterUrl === "string" ? body.nineRouterUrl : undefined,
        nineRouterPassword: typeof body.nineRouterPassword === "string" ? body.nineRouterPassword : undefined,
        nineRouterApiKey: typeof body.nineRouterApiKey === "string" ? body.nineRouterApiKey : undefined,
        activePoolLimit: body.activePoolLimit !== undefined ? Number(body.activePoolLimit) : undefined,
        nineRouterAutoSync: body.nineRouterAutoSync !== undefined ? Boolean(body.nineRouterAutoSync) : undefined,
        nineRouterSyncMinutes: body.nineRouterSyncMinutes !== undefined ? Number(body.nineRouterSyncMinutes) : undefined,
        checkConcurrency: body.checkConcurrency !== undefined ? Number(body.checkConcurrency) : undefined,
        checkTimeoutMs: body.checkTimeoutMs !== undefined ? Number(body.checkTimeoutMs) : undefined,
        proxyTtlMinutes: body.proxyTtlMinutes !== undefined ? Number(body.proxyTtlMinutes) : undefined,
      });
      return json(response, result);
    } catch (error) {
      return json(response, { error: (error as Error).message }, 400);
    }
  }

  if (request.method === "POST" && pathname === "/api/settings/test-ninerouter") {
    const body = await readBody(request);
    const overrides = {
      url: typeof body.nineRouterUrl === "string" ? body.nineRouterUrl : undefined,
      password: typeof body.nineRouterPassword === "string" && body.nineRouterPassword.trim() ? body.nineRouterPassword : undefined,
      apiKey: typeof body.nineRouterApiKey === "string" && body.nineRouterApiKey.trim() ? body.nineRouterApiKey : undefined,
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
      return json(response, { error: "Exporting credentials requires explicit confirmation (confirmCredentials=yes)" }, 403);
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
const port = 1300;

let syncIntervalId: NodeJS.Timeout | null = null;

function runScheduledSync() {
  poolRanker.startSyncIfStale().catch((error) => {
    const message = (error as Error).message;
    logActivity("error", `Scheduled sync failed: ${message}`);
    console.error("Scheduled 9Router sync failed:", message);
  });
}

function scheduleNineRouterSync() {
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
    syncIntervalId = null;
  }
  const secrets = getSettingsSecrets();
  if (!nineRouterConfigured() || secrets.nineRouterAutoSync === false) return;

  const intervalMs = Math.max(1, secrets.nineRouterSyncMinutes) * 60_000;
  const lastSyncAt = poolRanker.readState().lastSyncAt;
  const isRecent = typeof lastSyncAt === "number" && Date.now() - lastSyncAt < intervalMs;

  if (isRecent) {
    const remainingMs = Math.max(10_000, intervalMs - (Date.now() - (lastSyncAt as number)));
    const remainingMins = Math.round(remainingMs / 60_000);
    logActivity("info", `Skipping startup sync: last sync was recent (${remainingMins}m remaining). Next sync scheduled.`);
    syncIntervalId = setTimeout(() => {
      runScheduledSync();
      syncIntervalId = setInterval(runScheduledSync, intervalMs);
    }, remainingMs);
  } else {
    runScheduledSync();
    syncIntervalId = setInterval(runScheduledSync, intervalMs);
  }
}

let antigravityIntervalId: NodeJS.Timeout | null = null;

function scheduleAntigravityRotator() {
  if (antigravityIntervalId) {
    clearInterval(antigravityIntervalId);
    antigravityIntervalId = null;
  }
  const secrets = getSettingsSecrets();
  if (!nineRouterConfigured() || secrets.antigravityRotatorEnabled === false) return;

  const intervalMs = Math.max(1, secrets.antigravityRotateMinutes) * 60_000;
  antigravityIntervalId = setInterval(() => {
    antigravityRotator.runRotation().catch((err) => {
      logActivity("error", `Antigravity scheduled rotation failed: ${(err as Error).message}`);
    });
  }, intervalMs);
}

onSettingsChange((_settings, changed) => {
  if (changed.some((key) => ["nineRouterUrl", "nineRouterPassword", "nineRouterApiKey"].includes(key))) {
    clearNineRouterSession();
  }
  if (changed.includes("nineRouterSyncMinutes") || changed.includes("nineRouterAutoSync")) {
    scheduleNineRouterSync();
  }
  if (changed.includes("antigravityRotateMinutes") || changed.includes("antigravityRotatorEnabled")) {
    scheduleAntigravityRotator();
  }
});
async function handleIntelligence(request: http.IncomingMessage, response: http.ServerResponse, pathname: string) {
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
    const summary = await proxyIntelligenceRepo.importProxies({ source, content });
    return json(response, summary);
  }
  if (request.method === "POST" && pathname === "/api/intelligence/import/preview") {
    const body = await readBody(request, 5_000_000);
    const source = typeof body.source === "string" ? body.source.trim() : "import.txt";
    const content = typeof body.content === "string" ? body.content : "";
    if (!content.trim()) return json(response, { error: "content cannot be empty" }, 400);
    const preview = await proxyIntelligenceRepo.previewImport({ source, content });
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
async function handleProxiesUnified(request: http.IncomingMessage, response: http.ServerResponse, pathname: string) {
  if (!requireDashboardAuth(request).authenticated) {
    return json(response, { error: "Unauthorized" }, 401);
  }
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
          const cleaned = p.proxyUrl.replace(/^[a-zA-Z0-9]+:\/\//, "").split("/")[0].split("@").pop() || "";
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
          const cleaned = p.proxyUrl.replace(/^[a-zA-Z0-9]+:\/\//, "").split("/")[0].split("@").pop() || "";
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

  if (request.method === "POST" && pathname === "/api/proxies/check") {
    const body = (await readBody(request, 100_000).catch(() => ({}))) as Record<string, unknown>;
    const proxyKey = typeof body.proxyKey === "string" ? body.proxyKey : "";
    if (!proxyKey) return json(response, { error: "proxyKey is required" }, 400);

    const proxyRow = proxyIntelligenceDb.get<{
      proxy_key: string;
      endpoint: string;
      remote_id?: string | null;
    }>("SELECT proxy_key, endpoint, remote_id FROM proxies WHERE proxy_key = ?", [proxyKey]);

    if (!proxyRow) return json(response, { error: "Proxy not found" }, 404);

    try {
      let isOk = false;
      let latency: number | null = null;
      if (proxyRow.remote_id) {
        const testRes = await testPool(proxyRow.remote_id);
        isOk = testRes.ok;
        latency = testRes.elapsedMs ?? null;
      }
      const finishedTime = Date.now();
      const verdict = isOk ? "PASS" : "FAIL";

      await proxyIntelligenceRepo.persistAuditSnapshot({
        proxyKey,
        result: { verdict, connectivity: { reachable: isOk, latencyMs: latency ?? undefined } },
        finishedAt: finishedTime,
      });

      const auditDetail = await proxyIntelligenceRepo.getAuditDetail(proxyKey);
      const updated = await proxyIntelligenceRepo.getUnifiedProxies({ proxyKey, pageSize: 1 });
      const item = updated.items[0];
      if (!item) return json(response, { error: "Proxy no longer exists" }, 404);
      return json(response, { proxy: item, auditDetail, auditResult: { verdict, latency } });
    } catch (err) {
      return json(response, { error: (err as Error).message }, 500);
    }
  }

  if (request.method === "GET" && pathname === "/api/proxies/history") {
    const key = parsedUrl.searchParams.get("key");
    if (!key) return json(response, { error: "key is required" }, 400);

    const hasHistoryTable = proxyIntelligenceDb.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='proxy_test_history'"
    ).length > 0;

    const history = hasHistoryTable ? proxyIntelligenceDb.all<{
      id: number;
      tested_at: number;
      ok: number;
      latency_ms: number | null;
      error_message: string | null;
    }>(
      `SELECT id, tested_at, ok, latency_ms, error_message
       FROM proxy_test_history
       WHERE proxy_key = ?
       ORDER BY tested_at DESC
       LIMIT 10`,
      [key]
    ).map((r) => ({
      id: String(r.id),
      status: (r.ok ? "passed" : "failed") as "passed" | "failed",
      exitIp: null,
      isp: null,
      udp: "No" as const,
      latencyMs: r.latency_ms,
      timestamp: r.tested_at,
    })) : [];

    return json(response, { history });
  }

  return json(response, { error: "not found" }, 404);
}



async function main() {
  const app = next({ dev, dir: root });
  const handle = app.getRequestHandler();
  await app.prepare();

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
    if (pathname === "/api/health") return json(response, { ok: true });
    if (pathname.startsWith("/api/fleet/")) {
      const handled = await handleFleetApi(request, response, pathname);
      if (handled) return;
    }
    if (request.method === "POST" && pathname === "/api/auth/login") {
      try {
        const body = await readBody(request, 10_000);
        const password = typeof body.password === "string" ? body.password : "";
        if (!password || !verifyControlPassword(password)) {
          return json(response, { error: "Invalid control password" }, 401);
        }
        const session = createSession();
        const isSecure = request.headers["x-forwarded-proto"] === "https" || Boolean("encrypted" in request.socket && request.socket.encrypted);
        response.setHeader("Set-Cookie", sessionCookie(session.token, isSecure));
        return json(response, { authenticated: true, expiresAt: session.expiresAt });
      } catch (err) {
        return json(response, { error: (err as Error).message }, 400);
      }
    }

    if (request.method === "POST" && pathname === "/api/auth/logout") {
      revokeSession(request.headers.cookie);
      response.setHeader("Set-Cookie", clearSessionCookie());
      return json(response, { authenticated: false });
    }

    if (request.method === "GET" && pathname === "/api/auth/session") {
      const authResult = requireDashboardAuth(request);
      if (authResult.authenticated && !readSession(request.headers.cookie)) {
        const session = createSession();
        const isSecure = request.headers["x-forwarded-proto"] === "https" || Boolean("encrypted" in request.socket && request.socket.encrypted);
        response.setHeader("Set-Cookie", sessionCookie(session.token, isSecure));
      }
      return json(response, { authenticated: authResult.authenticated });
    }

    if (!auth(request)) return json(response, { error: "Invalid control password" }, 401);

    if (pathname.startsWith("/api/ninerouter/")) return handleNineRouter(request, response, pathname);
    if (pathname.startsWith("/api/antigravity/")) return handleAntigravity(request, response, pathname);
    if (pathname.startsWith("/api/settings")) return handleSettings(request, response, pathname);
    if (pathname.startsWith("/api/intelligence/")) return handleIntelligence(request, response, pathname);
    if (pathname.startsWith("/api/proxies/")) return handleProxiesUnified(request, response, pathname);

    return json(response, { error: "not found" }, 404);
  });

  if (upgradeHandler) {
    server.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname === "/_next/webpack-hmr") return upgradeHandler(request, socket, head);
      socket.destroy();
    });
  }

  server.listen(port, () => {
    console.log(`minhmiceProxy listening on http://localhost:${port}`);
    setInterval(() => {
      void poolRanker.refreshRemoteTracking();
    }, 60_000);
    scheduleNineRouterSync();
    scheduleAntigravityRotator();
  });
}

process.on("unhandledRejection", (reason) => {
  const detail = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason);
  console.error(`[process] unhandledRejection\n${detail}`);
});
process.on("uncaughtException", (error) => {
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
