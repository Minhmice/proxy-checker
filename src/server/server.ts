import "./load-env.js";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import next from "next";
import { getSettingsSecrets, getSettingsPublic, onSettingsChange, updateSettings, verifyControlPassword } from "./app-config.js";
import { createInputChecker } from "./checker.js";
import { logActivity, logActivityThrottled } from "./activity-log.js";
import { createPoolRanker, PoolConflictError } from "./pool-ranker.js";
import { clearNineRouterSession, nineRouterConfigured, testNineRouterConnection } from "./nine-router-client.js";
import { bulkSetActive, listPools } from "./nine-router-client.js";
import { parseProxy, proxyUrl } from "./proxy-core.js";
import { createDiagnosticRunner } from "./detailed-checker.js";
import { createAuditorJobManager, AuditorJobError } from "./auditor-jobs.js";
import type { AuditorJobOptions } from "../lib/types.js";
import { openProxyIntelligenceDb } from "./proxy-intelligence-db.js";
import { createProxyIntelligenceRepository } from "./proxy-intelligence-repository.js";
import { createProxyIntelligenceJobManager } from "./proxy-intelligence-jobs.js";

import { checkProxy } from "../auditor/index.js";
import { createFleetRepository } from "../proxyfleet/db.js";
import { createFleetApiHandler } from "../proxyfleet/api-router.js";
import {
  createSession,
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
const proxyIntelligenceJobs = createProxyIntelligenceJobManager({
  db: proxyIntelligenceDb,
  repo: proxyIntelligenceRepo,
});

const fleetRepo = createFleetRepository({ sqlitePath: path.join(dataDir, "fleet.sqlite3") });
void fleetRepo.migrate().catch((err) => console.error("Fleet DB migration failed:", err));
const handleFleetApi = createFleetApiHandler({
  repo: fleetRepo,
  verifyAuth: verifyControlPassword,
});
const inputChecker = createInputChecker({
  inputDir,
  dataDir,
  getTtlMs: () => getSettingsSecrets().proxyTtlMinutes * 60_000,
});
const poolRanker = createPoolRanker({ dataDir });
const diagnostics = createDiagnosticRunner({ inputDir, dataDir });
const auditorJobs = createAuditorJobManager({ dataDir });

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
async function handleDiagnostics(request: http.IncomingMessage, response: http.ServerResponse, pathname: string) {
  if (request.method === "GET" && pathname === "/api/diagnostics/files") {
    return json(response, { files: diagnostics.files(), job: diagnostics.getJob() });
  }
  if (request.method === "GET" && pathname === "/api/diagnostics/job") {
    return json(response, { job: diagnostics.getJob() });
  }
  if (request.method === "POST" && pathname === "/api/diagnostics/upload") {
    const body = await readBody(request);
    const requestedName = typeof body.name === "string" ? path.basename(body.name) : "";
    const content = typeof body.content === "string" ? body.content : "";
    if (!requestedName.toLowerCase().endsWith(".txt") || !content.trim()) return json(response, { error: "Choose a non-empty .txt file" }, 400);
    if (Buffer.byteLength(content, "utf8") > 5_000_000) return json(response, { error: "Input files must be 5 MB or smaller" }, 413);
    const safeName = requestedName.replace(/[^a-zA-Z0-9._() -]/g, "_");
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(path.join(inputDir, safeName), content, "utf8");
    return json(response, { name: safeName, count: diagnostics.files().find((file) => file.name === safeName)?.count ?? 0 });
  }
  if (request.method === "POST" && pathname === "/api/diagnostics/run") {
    if (diagnostics.isRunning()) return json(response, { error: "Diagnostics already running" }, 409);
    const body = await readBody(request);
    if (typeof body.file !== "string" || !body.file.trim()) {
      return json(response, { error: "file must be a non-empty string" }, 400);
    }
    const available = diagnostics.files().map((f) => f.name);
    if (!available.includes(body.file)) {
      return json(response, { error: `File not found: ${body.file}` }, 404);
    }

    const hasCount = body.sampleCount !== undefined && body.sampleCount !== null;
    const hasPercent = body.samplePercent !== undefined && body.samplePercent !== null;

    if (!hasCount && !hasPercent) {
      return json(response, { error: "Either sampleCount or samplePercent must be provided" }, 400);
    }

    let sampleCount: number | undefined;
    let samplePercent: number | undefined;

    if (hasCount) {
      if (typeof body.sampleCount !== "number" || !Number.isFinite(body.sampleCount)) {
        return json(response, { error: "sampleCount must be a finite number" }, 400);
      }
      sampleCount = Math.floor(body.sampleCount);
    } else {
      if (typeof body.samplePercent !== "number" || !Number.isFinite(body.samplePercent)) {
        return json(response, { error: "samplePercent must be a finite number" }, 400);
      }
      samplePercent = body.samplePercent;
    }
    void diagnostics.run({
      file: typeof body.file === "string" ? body.file : undefined,
      samplePercent: hasPercent ? Number(body.samplePercent) : undefined,
      sampleCount: hasCount ? Number(body.sampleCount) : undefined,
    });
    return json(response, { started: true }, 202);
  }
  if (request.method === "POST" && (pathname === "/api/diagnostics/cancel" || pathname === "/api/diagnostics/stop")) {
    const stopped = diagnostics.stop();
    return json(response, { stopped, job: diagnostics.getJob() });
  }
  if (request.method === "POST" && pathname === "/api/diagnostics/promote") {
    const body = await readBody(request);
    const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 50) : [];
    if (!ids.length) return json(response, { error: "Select at least one successful diagnostic result" }, 400);
    const selected = diagnostics.getJob().results.filter((result) => ids.includes(result.id) && result.status === "SUCCESS");
    if (!selected.length) return json(response, { error: "No selected successful diagnostic results" }, 400);
    try {
      const result = await poolRanker.promoteDiagnostics(selected);
      return json(response, result);
    } catch (error) {
      return json(response, { error: `Could not reach 9Router: ${(error as Error).message}` }, 502);
    }
  }
  return json(response, { error: "not found" }, 404);
}

async function handleAuditor(request: http.IncomingMessage, response: http.ServerResponse, pathname: string) {
  if (!requireDashboardAuth(request).authenticated) {
    return json(response, { error: "Unauthorized" }, 401);
  }
  try {
    if (request.method === "POST" && pathname === "/api/auditor/jobs") {
      const body = await readBody(request, 5_100_000);
      const mode = body.mode as "single" | "bulk";
      const options = (body.options && typeof body.options === "object" ? body.options : {}) as unknown as AuditorJobOptions;

      if (mode === "single") {
        const proxy = typeof body.proxy === "string" ? body.proxy : "";
        const job = await auditorJobs.createSingle({ proxy, options });
        return json(response, { job }, 202);
      }
      if (mode === "bulk") {
        const name = typeof body.name === "string" ? body.name : "";
        const content = typeof body.content === "string" ? body.content : "";
        const job = await auditorJobs.createBulk({ name, content, options });
        return json(response, { job }, 202);
      }
      return json(response, { error: "Invalid audit mode: expected 'single' or 'bulk'" }, 400);
    }

    const jobActionMatch = pathname.match(/^\/api\/auditor\/jobs\/([^/]+)(?:\/(cancel|export))?$/);
    if (jobActionMatch) {
      const id = decodeURIComponent(jobActionMatch[1]!);
      const action = jobActionMatch[2];

      if (request.method === "GET" && !action) {
        const job = auditorJobs.getJob(id);
        if (!job) return json(response, { error: `Job not found: ${id}` }, 404);
        return json(response, { job });
      }

      if (request.method === "POST" && action === "cancel") {
        const job = await auditorJobs.cancelJob(id);
        return json(response, { job });
      }

      if (request.method === "GET" && action === "export") {
        const url = new URL(request.url ?? "/", "http://localhost");
        const format = (url.searchParams.get("format") || "json").toLowerCase() as "json" | "csv";
        const exported = await auditorJobs.exportJob(id, format);
        response.writeHead(200, {
          "Content-Type": exported.contentType,
          "Content-Disposition": `attachment; filename="${exported.filename}"`,
          "Content-Length": exported.body.length,
        });
        response.end(exported.body);
        return;
      }
    }

    if (request.method === "GET" && pathname === "/api/auditor/history") {
      const url = new URL(request.url ?? "/", "http://localhost");
      const rawLimit = Number(url.searchParams.get("limit") || 50);
      const limit = Number.isFinite(rawLimit) ? rawLimit : 50;
      const jobs = auditorJobs.listHistory(limit);
      return json(response, { jobs });
    }

    const historyActionMatch = pathname.match(/^\/api\/auditor\/history\/([^/]+)$/);
    if (historyActionMatch && request.method === "DELETE") {
      const id = decodeURIComponent(historyActionMatch[1]!);
      const deleted = await auditorJobs.deleteHistory(id);
      if (!deleted) return json(response, { error: `Job not found: ${id}` }, 404);
      response.writeHead(204);
      response.end();
      return;
    }

    return json(response, { error: "not found" }, 404);
  } catch (error) {
    const err = error as Error & { status?: number };
    const status = err.status || (error instanceof AuditorJobError ? error.status : 400);
    return json(response, { error: err.message || "Auditor operation failed" }, status);
  }
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
    const includeCredentials = parsedUrl.searchParams.get("includeCredentials") === "true";

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

onSettingsChange((_settings, changed) => {
  if (changed.some((key) => ["nineRouterUrl", "nineRouterPassword", "nineRouterApiKey"].includes(key))) {
    clearNineRouterSession();
  }
  if (changed.includes("nineRouterSyncMinutes") || changed.includes("nineRouterAutoSync")) {
    scheduleNineRouterSync();
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
  if (request.method === "POST" && pathname === "/api/intelligence/sync-working") {
    try {
      const body = (await readBody(request, 100_000).catch(() => ({}))) as Record<string, unknown>;
      const pools = poolRanker.listByTier("all");
      const summary = await proxyIntelligenceRepo.syncWorkingPools(pools);
      let job;
      if (Boolean(body.startAudit) && summary.proxyKeys.length > 0) {
        job = await proxyIntelligenceJobs.createJob({
          proxyKeys: summary.proxyKeys,
          options: { attempts: 2, timeoutMs: 15000, concurrency: 5 },
        });
      }
      return json(response, { ...summary, job });
    } catch (err) {
      return json(response, { error: (err as Error).message }, 500);
    }
  }
  if (request.method === "GET" && pathname === "/api/intelligence/jobs") {
    const jobs = proxyIntelligenceJobs.listJobs();
    return json(response, { jobs });
  }
  if (request.method === "POST" && pathname === "/api/intelligence/jobs") {
    const body = await readBody(request, 1_000_000);
    const proxyKeys = Array.isArray(body.proxyKeys) ? (body.proxyKeys as string[]) : undefined;
    const filter = typeof body.filter === "object" && body.filter !== null ? (body.filter as any) : undefined;
    const options = typeof body.options === "object" && body.options !== null ? (body.options as any) : undefined;

    try {
      const job = await proxyIntelligenceJobs.createJob({ proxyKeys, filter, options });
      return json(response, { job }, 202);
    } catch (err) {
      return json(response, { error: (err as Error).message }, 400);
    }
  }

  if (request.method === "GET" && pathname.startsWith("/api/intelligence/jobs/")) {
    const id = pathname.slice("/api/intelligence/jobs/".length);
    const job = proxyIntelligenceJobs.getJob(id);
    if (!job) return json(response, { error: "Job not found" }, 404);
    return json(response, { job });
  }

  if (request.method === "POST" && pathname.startsWith("/api/intelligence/jobs/") && pathname.endsWith("/cancel")) {
    const parts = pathname.split("/");
    const id = parts[parts.length - 2];
    const job = await proxyIntelligenceJobs.cancelJob(id);
    if (!job) return json(response, { error: "Job not found" }, 404);
    return json(response, { job });
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
      status: parsedUrl.searchParams.get("status") || "all",
      search: parsedUrl.searchParams.get("search") || undefined,
      protocol: parsedUrl.searchParams.get("protocol") || undefined,
      page: Number(parsedUrl.searchParams.get("page") || "1"),
      pageSize: Number(parsedUrl.searchParams.get("pageSize") || "50"),
      activePoolEndpoints,
      reservePoolEndpoints,
    };

    const res = await proxyIntelligenceRepo.getUnifiedProxies(filter);
    return json(response, res);
  }

  if (request.method === "POST" && pathname === "/api/proxies/check") {
    const body = (await readBody(request, 100_000).catch(() => ({}))) as Record<string, unknown>;
    const proxyKey = typeof body.proxyKey === "string" ? body.proxyKey : "";
    if (!proxyKey) return json(response, { error: "proxyKey is required" }, 400);

    try {
      const auditResult = await checkProxy(proxyKey, { attempts: 1, timeoutMs: 10000 });
      const verdict = auditResult.verdict;
      const auditId = crypto.randomUUID();
      const finishedTime = Date.now();

      proxyIntelligenceDb.transaction(() => {
        proxyIntelligenceDb.run(
          `INSERT INTO proxy_audits (
            id, proxy_key, verdict, lifecycle_state, overall_score,
            transport_score, privacy_score, reputation_score, reliability_score,
            started_at, finished_at, result_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            auditId,
            proxyKey,
            verdict,
            verdict === "PASS" ? "working" : "dead",
            auditResult.scores?.overallSafety ?? null,
            auditResult.scores?.transportSecurity ?? null,
            auditResult.scores?.privacy ?? null,
            auditResult.scores?.reputation ?? null,
            auditResult.scores?.reliability ?? null,
            finishedTime,
            finishedTime,
            JSON.stringify(auditResult),
          ]
        );

        proxyIntelligenceDb.run(
          `UPDATE proxies SET
            latency_ms = COALESCE(?, latency_ms),
            exit_ip = COALESCE(?, exit_ip),
            status = ?,
            checked_at = ?,
            updated_at = ?
          WHERE proxy_key = ?`,
          [
            auditResult.connectivity?.latencyMs ?? null,
            auditResult.exitIp?.ip ?? null,
            verdict === "FAIL" ? "dead" : "usable",
            finishedTime,
            finishedTime,
            proxyKey,
          ]
        );
      });

      const updated = await proxyIntelligenceRepo.getUnifiedProxies({ search: proxyKey, pageSize: 1 });
      const item = updated.items.find((i) => i.key === proxyKey) || updated.items[0];
      return json(response, { proxy: item, auditResult });
    } catch (err) {
      return json(response, { error: (err as Error).message }, 500);
    }
  }

  if (request.method === "GET" && pathname === "/api/proxies/history") {
    const key = parsedUrl.searchParams.get("key");
    if (!key) return json(response, { error: "key is required" }, 400);

    const rows = proxyIntelligenceDb.all<{
      id: string;
      verdict: string;
      finished_at: number;
      result_json: string;
    }>(
      `SELECT id, verdict, finished_at, result_json
       FROM proxy_audits
       WHERE proxy_key = ?
       ORDER BY finished_at DESC
       LIMIT 10`,
      [key]
    );

    const history = rows.map((r) => {
      let exitIp: string | null = null;
      let isp: string | null = null;
      let udp: "Yes" | "No" = "No";
      let latencyMs: number | null = null;

      if (typeof r.result_json === "string") {
        try {
          const parsed = JSON.parse(r.result_json);
          exitIp = (parsed.exitIp?.ip ?? parsed.evidence?.exitIp?.ip) ?? null;
          isp = (parsed.exitIp?.isp ?? parsed.evidence?.exitIp?.isp) ?? null;
          udp = (parsed.network?.udp ?? parsed.evidence?.network?.udp) ? "Yes" : "No";
          latencyMs = (parsed.connectivity?.latencyMs ?? parsed.evidence?.connectivity?.latencyMs) ?? null;
        } catch {}
      }

      return {
        id: r.id,
        status: r.verdict === "PASS" ? "passed" : "failed",
        exitIp,
        isp,
        udp,
        latencyMs,
        timestamp: r.finished_at,
      };
    });

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
        const isSecure = request.headers["x-forwarded-proto"] === "https" || (request.socket as any).encrypted === true;
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
      return json(response, { authenticated: authResult.authenticated });
    }

    if (!auth(request)) return json(response, { error: "Invalid control password" }, 401);

    if (pathname.startsWith("/api/ninerouter/")) return handleNineRouter(request, response, pathname);
    if (pathname.startsWith("/api/diagnostics/")) return handleDiagnostics(request, response, pathname);
    if (pathname.startsWith("/api/auditor/")) return handleAuditor(request, response, pathname);
    if (pathname.startsWith("/api/settings")) return handleSettings(request, response, pathname);
    if (pathname.startsWith("/api/intelligence/")) return handleIntelligence(request, response, pathname);
    if (pathname.startsWith("/api/proxies/")) return handleProxiesUnified(request, response, pathname);

    if (request.method === "GET" && pathname === "/api/best") {
      return json(response, { proxies: inputChecker.best().slice(0, 20), running: inputChecker.isRunning() });
    }
    if (request.method === "GET" && pathname === "/api/proxies") {
      const proxies = Object.values(inputChecker.readHistory())
        .sort((a, b) => b.checked_at - a.checked_at)
        .slice(0, 100);
      return json(response, { proxies, running: inputChecker.isRunning() });
    }
    if (request.method === "POST" && pathname === "/api/check") {
      inputChecker.runChecks(true);
      return json(response, { started: true }, 202);
    }
    if (request.method === "POST" && pathname === "/api/router/apply-best") {
      const selected = inputChecker.best()[0];
      if (!selected) return json(response, { error: "No usable proxy is available" }, 409);
      const proxy = inputChecker.loadProxies().find((item) => item.endpoint === selected.endpoint);
      if (!proxy) return json(response, { error: "Selected proxy is no longer present in input/" }, 409);
      fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
      const url = proxyUrl(proxy, true);
      fs.writeFileSync(runtimeFile, `ALL_PROXY=${url}\nHTTP_PROXY=${url}\nHTTPS_PROXY=${url}\n`);
      return json(response, { selected, restart_required: true });
    }

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
    inputChecker.runChecks();
    setInterval(() => inputChecker.runChecks(), 30_000);
    setInterval(() => {
      void poolRanker.refreshRemoteTracking();
    }, 60_000);
    scheduleNineRouterSync();
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
