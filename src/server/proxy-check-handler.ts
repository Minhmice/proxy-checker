import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProxyIntelligenceDb } from "./proxy-intelligence-db.js";
import type { ProxyIntelligenceRepository } from "./proxy-intelligence-repository.js";
import type { testPool } from "./nine-router-client.js";
import { requireDashboardAuth } from "./session-auth.js";

export function createProxyCheckHandler(deps: {
  db: ProxyIntelligenceDb;
  repo: ProxyIntelligenceRepository;
  testPool: typeof testPool;
  readBody: (request: IncomingMessage, maxBytes?: number) => Promise<Record<string, unknown>>;
  json: (response: ServerResponse, payload: unknown, status?: number) => void;
}) {
  return async (request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> => {
    const checking = request.method === "POST" && pathname === "/api/proxies/check";
    const historyRequest = request.method === "GET" && pathname === "/api/proxies/history";
    if (!checking && !historyRequest) return false;
    const send = (payload: unknown, status = 200) => { deps.json(response, payload, status); return true; };
    if (!requireDashboardAuth(request).authenticated) return send({ error: "Unauthorized" }, 401);
    if (historyRequest) {
      const key = new URL(request.url ?? "/", "http://localhost").searchParams.get("key");
      if (!key) return send({ error: "key is required" }, 400);
      const history = deps.db.all<{ id: number; tested_at: number; ok: number; latency_ms: number | null; error_message: string | null }>(
        "SELECT id, tested_at, ok, latency_ms, error_message FROM proxy_test_history WHERE proxy_key = ? ORDER BY tested_at DESC, id DESC LIMIT 10", [key]
      ).map(row => ({ id: String(row.id), status: row.ok ? "passed" : "failed", exitIp: null, isp: null, udp: "Unknown", latencyMs: row.latency_ms, timestamp: row.tested_at, errorMessage: row.error_message }));
      return send({ history });
    }
    let body: Record<string, unknown>;
    try { body = await deps.readBody(request, 100_000); }
    catch { return send({ error: "Invalid request body" }, 400); }
    const key = typeof body?.proxyKey === "string" ? body.proxyKey : "";
    if (!key) return send({ error: "proxyKey is required" }, 400);
    const row = deps.db.get<{ remote_id: string | null }>("SELECT remote_id FROM proxies WHERE proxy_key = ?", [key]);
    if (!row) return send({ error: "Proxy not found" }, 404);
    if (!row.remote_id) return send({ error: "Proxy is not linked to a 9Router pool. Push it to 9Router before checking." }, 409);
    let result: Awaited<ReturnType<typeof testPool>>;
    try { result = await deps.testPool(row.remote_id); }
    catch (err) { return send({ error: err instanceof Error ? err.message : "9Router unavailable" }, 502); }
    if (result.failureKind === "transport") return send({ error: result.error || "9Router unavailable" }, 502);
    try {
      const latency = typeof result.elapsedMs === "number" && Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0 ? result.elapsedMs : undefined;
      await deps.repo.recordTestResult(key, result.ok, latency, result.ok ? undefined : result.error || result.statusText || "Proxy check failed");
      const updated = await deps.repo.getUnifiedProxies({ proxyKey: key, pageSize: 1 });
      const item = updated.items[0];
      if (!item) return send({ error: "Proxy no longer exists" }, 404);
      const auditDetail = await deps.repo.getAuditDetail(key);
      return send({ proxy: item, auditDetail, auditResult: { verdict: result.ok ? "PASS" : "FAIL", latency: latency ?? null } });
    } catch (err) { return send({ error: err instanceof Error ? err.message : "Unable to persist check" }, 500); }
  };
}
