import crypto from "node:crypto";
import type { ProxyIntelligenceDb, SqlParam } from "./proxy-intelligence-db.js";
import { parseProxyInput, type ParsedProxyInput } from "../lib/proxy-parser.js";
import type { ProxyAuditDetail, ProxyAuditResult } from "../lib/types.js";

export type ProxyLifecycleState = "working" | "unstable" | "dead" | "dangerous" | "unknown";

export interface ProxyInventoryItem {
  proxyKey: string;
  endpoint: string;
  protocol: string;
  host: string;
  port: number;
  username?: string;
  hasAuth: boolean;
  source: string;
  lifecycleState: ProxyLifecycleState;
  status: string;
  latencyMs: number | null;
  exitIp: string | null;
  successes: number;
  failures: number;
  lastError: string | null;
  checkedAt: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  latestVerdict?: string | null;
  latestScore?: number | null;
  latestAuditAt?: number | null;
  isPinned?: boolean;
  tags?: string[];
  remoteId?: string | null;
  routerState?: string;
  removedAt?: number | null;
  lastLatencyMs?: number | null;
}
export interface ProxyInventoryDetail extends ProxyInventoryItem {
  latestAudit?: ProxyAuditResult | null;
  auditHistory?: Array<{
    id: string;
    verdict: string;
    lifecycleState: ProxyLifecycleState;
    overallScore: number | null;
    finishedAt: number | null;
  }>;
  diagnosticHistory?: Array<{
    id: string;
    status: string;
    latencyMs: number | null;
    checkedAt: number;
    errorMessage: string | null;
  }>;
}

export interface ProxyInventoryFilter {
  proxyKey?: string;
  search?: string;
  source?: string;
  protocol?: string;
  lifecycle?: ProxyLifecycleState | "all";
  health?: "all" | "working" | "regressed" | "dead" | string;
  status?: "all" | "working" | "regressed" | "dead" | string;
  sort?: "health" | "lastChecked" | "latency" | "endpoint";
  direction?: "asc" | "desc";
  verdict?: string | "all";
  country?: string;
  asn?: string;
  isp?: string;
  minReliability?: number;
  maxLatencyMs?: number;
  auditAge?: "never" | "24h" | "7d" | "stale" | "all";
  hasCriticalRisk?: boolean;
  page?: number;
  pageSize?: number;
}

export interface ProxyInventoryPage {
  items: ProxyInventoryItem[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ProxyImportInput {
  source: string;
  content: string;
}

export interface ProxyImportSummary {
  source: string;
  totalLines: number;
  inserted: number;
  updated: number;
  invalid: number;
  duplicates: number;
}

export interface PersistAuditSnapshotInput {
  proxyKey: string;
  result: ProxyAuditResult;
  auditId?: string;
  jobId?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface ProxyImportPreview {
  source: string;
  totalLines: number;
  valid: number;
  invalid: number;
  duplicates: number;
  protocols: Record<string, number>;
  invalidLines: Array<{ line: number; text: string; error: string }>;
  sampleValid: Array<{ endpoint: string; protocol: string }>;
}

export interface WorkingExportFilter {
  format?: "txt" | "csv";
  includeCredentials?: boolean;
  minReliability?: number;
  maxAuditAgeMs?: number;
}

export interface ExportResult {
  filename: string;
  contentType: string;
  body: string;
}
export interface UnifiedProxyItem {
  // New spec fields
  proxyKey: string;
  host: string;
  port: number;
  protocol: "http" | "https" | "socks4" | "socks5";
  source: string | null;
  poolTier: "active" | "reserve" | null;
  health: "working" | "regressed" | "dead";
  everPassed: boolean;
  lastAudit: {
    id: string;
    verdict: "PASS" | "WARN" | "FAIL" | "UNKNOWN";
    checkedAt: string;
    exitIp?: string;
    country?: string;
    isp?: string;
    latencyMs?: number;
    overallSafety?: number;
    primaryReasonCode?: string;
  } | null;

  // Legacy compatibility fields
  key: string;
  name: string;
  status: "working" | "dead" | "regressed";
  udp: "Yes" | "No" | "Unknown";
  sync: "active" | "reserve" | "unsynced";
  latencyMs: number | null;
  exitIp: string | null;
  geo?: { city?: string; country?: string };
  isp?: string;
  timezone?: string;
  lastCheckedAt: number | null;
  isPinned: boolean;
  tags: string[];
  remoteId: string | null;
  routerState: "active" | "reserve" | "removed" | "unmanaged";
  removedAt: number | null;
  lastLatencyMs: number | null;
}
export interface UnifiedProxyCounts {
  all: number;
  working: number;
  regressed: number;
  dead: number;
}

export interface UnifiedProxyResponse {
  total: number;
  counts: UnifiedProxyCounts;
  pagination: { page: number; pageSize: number; total: number };
  facets: {
    all: number;
    working: number;
    regressed: number;
    dead: number;
    protocols: Record<string, number>;
  };
  meta: { generatedAt: string };
  items: UnifiedProxyItem[];
}

export interface UnifiedProxyFilter {
  proxyKey?: string;
  status?: "all" | "working" | "regressed" | "dead" | string;
  health?: "all" | "working" | "regressed" | "dead" | string;
  search?: string;
  protocol?: string;
  source?: string;
  sort?: "health" | "lastChecked" | "latency" | "endpoint";
  direction?: "asc" | "desc";
  page?: number;
  pageSize?: number;
  activePoolEndpoints?: Set<string>;
  reservePoolEndpoints?: Set<string>;
}


export interface ProxyIntelligenceRepository {
  importProxies(input: ProxyImportInput): Promise<ProxyImportSummary>;
  listProxies(filter?: ProxyInventoryFilter): Promise<ProxyInventoryPage>;
  getProxy(proxyKey: string): Promise<ProxyInventoryDetail | null>;
  resolveProxyKeys(filter: ProxyInventoryFilter): Promise<string[]>;
  exportWorkingProxies(filter?: WorkingExportFilter): Promise<ExportResult>;
  syncWorkingPools(pools: Array<{
    endpoint?: string;
    proxyUrl: string;
    remoteId?: string | null;
    tier?: string;
    status?: string;
    isActiveOnRouter?: boolean;
    latency_ms?: number | null;
    exit_ip?: string | null;
  }>): Promise<{ imported: number; proxyKeys: string[] }>;
  getUnifiedProxies(filter?: UnifiedProxyFilter): Promise<UnifiedProxyResponse>;
  persistAuditSnapshot(input: PersistAuditSnapshotInput): Promise<void>;
  previewImport(input: ProxyImportInput): Promise<ProxyImportPreview>;
  getAuditDetail(proxyKey: string, auditId?: string): Promise<ProxyAuditDetail | null>;
  setPin(proxyKey: string, isPinned: boolean): Promise<boolean>;
  updateTags(proxyKey: string, tags: string[]): Promise<void>;
  recordTestResult(proxyKey: string, ok: boolean, latencyMs?: number, errorMessage?: string): Promise<void>;
  softDeleteFromRouter(proxyKey: string, errorMessage?: string): Promise<void>;
  hardDeleteProxy(proxyKey: string, force?: boolean): Promise<{ deleted: boolean; remoteId: string | null }>;
  syncManagedFleetEndpoints(rows: Array<{
    nodeId: string;
    endpointId: string;
    proxyUrl: string;
  }>): Promise<number>;
  unlinkManagedFleetNode(nodeId: string, options?: {
    cleanupRemoteRef?: (remoteId: string, proxyKey: string) => Promise<void>;
    force?: boolean;
  }): Promise<void>;
  listManagedFleetAuditTargets(): Promise<Array<{
    nodeId: string;
    endpointId: string;
    proxyKey: string;
    proxyUrl: string;
    remoteId: string | null;
  }>>;
  cleanupPendingManagedFleetEndpoints(options?: {
    cleanupRemoteRef?: (remoteId: string, proxyKey: string) => Promise<void>;
    force?: boolean;
  }): Promise<{ cleaned: number; pendingRemaining: number }>;
  getManagedFleetNodeRemoteRefs?(nodeId: string): Promise<Array<{
    endpointId: string;
    proxyKey: string;
    remoteId: string | null;
    isPinned: boolean;
  }>>;
}

function computeProxyKey(protocol: string, host: string, port: number, username?: string | null): string {
  const normProto = protocol.toLowerCase();
  const normHost = host.toLowerCase();
  return `${normProto}://${username ? `${encodeURIComponent(username)}@` : ""}${normHost}:${port}`;
}

export function createProxyIntelligenceRepository(deps: { db: ProxyIntelligenceDb }): ProxyIntelligenceRepository {
  const db = deps.db;

  return {
    async importProxies(input: ProxyImportInput): Promise<ProxyImportSummary> {
      const lines = input.content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
      const now = Date.now();
      let inserted = 0;
      let updated = 0;
      let invalid = 0;
      let duplicates = 0;

      const seenKeys = new Set<string>();

      db.transaction(() => {
        for (const line of lines) {
          // Infer scheme from source name if bare host:port
          const defaultScheme = input.source.toLowerCase().includes("socks") ? "socks5" : "http";
          let parsedResult;
          try {
            parsedResult = parseProxyInput(line, defaultScheme);
          } catch {
            invalid++;
            continue;
          }
          if (!parsedResult || !parsedResult.parsed) {
            invalid++;
            continue;
          }
          const parsed = parsedResult;
          const p: ParsedProxyInput = parsed.parsed;
          const key = computeProxyKey(p.protocol, p.host, p.port, p.username);

          if (seenKeys.has(key)) {
            duplicates++;
            continue;
          }
          seenKeys.add(key);

          const existing = db.get<{ proxy_key: string }>("SELECT proxy_key FROM proxies WHERE proxy_key = ?", [key]);

          if (existing) {
            db.run(
              `UPDATE proxies SET
                source = ?,
                password = COALESCE(?, password),
                updated_at = ?
              WHERE proxy_key = ?`,
              [input.source, p.password ?? null, now, key]
            );
            updated++;
          } else {
            db.run(
              `INSERT INTO proxies (
                proxy_key, endpoint, protocol, host, port, status, exit_ip,
                latency_ms, checked_at, successes, failures, last_error,
                source, lifecycle_state, username, password, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                key,
                `${p.host}:${p.port}`,
                p.protocol,
                p.host,
                p.port,
                "dead",
                null,
                null,
                0,
                0,
                0,
                null,
                input.source,
                "unknown",
                p.username ?? null,
                p.password ?? null,
                now,
                now,
              ]
            );
            inserted++;
          }
        }
      });

      return {
        source: input.source,
        totalLines: lines.length,
        inserted,
        updated,
        invalid,
        duplicates,
      };
    },

    async listProxies(filter: ProxyInventoryFilter = {}): Promise<ProxyInventoryPage> {
      const page = Math.max(1, filter.page ?? 1);
      const pageSize = Math.max(1, Math.min(100, filter.pageSize ?? 20));
      const offset = (page - 1) * pageSize;

      const whereClauses: string[] = ["1 = 1"];
      const params: SqlParam[] = [];

      if (filter.search?.trim()) {
        const term = `%${filter.search.trim().toLowerCase()}%`;
        whereClauses.push("(LOWER(p.proxy_key) LIKE ? OR LOWER(p.endpoint) LIKE ? OR LOWER(COALESCE(p.exit_ip, '')) LIKE ?)");
        params.push(term, term, term);
      }

      if (filter.source && filter.source !== "all") {
        whereClauses.push("p.source = ?");
        params.push(filter.source);
      }

      if (filter.protocol && filter.protocol !== "all") {
        whereClauses.push("p.protocol = ?");
        params.push(filter.protocol.toLowerCase());
      }

      if (filter.lifecycle && filter.lifecycle !== "all") {
        whereClauses.push("p.lifecycle_state = ?");
        params.push(filter.lifecycle);
      }

      if (filter.verdict && filter.verdict !== "all") {
        whereClauses.push("p.last_verdict = ?");
        params.push(filter.verdict);
      }

      const whereSql = whereClauses.join(" AND ");

      const countRow = db.get<{ total: number }>(
        `SELECT COUNT(*) AS total
         FROM proxies p
         WHERE ${whereSql}`,
        params
      );

      const total = countRow?.total ?? 0;

      const rows = db.all<Record<string, unknown>>(
        `SELECT
           p.proxy_key,
           p.endpoint,
           p.protocol,
           p.host,
           p.port,
           p.status,
           p.exit_ip,
           p.latency_ms,
           p.checked_at,
           p.successes,
           p.failures,
           p.last_error,
           p.source,
           p.lifecycle_state,
           p.username,
           CASE WHEN p.password IS NOT NULL AND p.password != '' THEN 1 ELSE 0 END AS has_password,
           p.created_at,
           p.updated_at,
           p.last_verdict AS latest_verdict,
           NULL AS latest_score,
           p.last_checked_at AS latest_audit_at,
           p.is_pinned,
           p.tags,
           p.remote_id,
           p.router_state,
           p.removed_at,
           p.last_latency_ms
         FROM proxies p
         WHERE ${whereSql}
         ORDER BY
           CASE WHEN (p.status = 'dead' OR p.lifecycle_state = 'dead') AND COALESCE(p.checked_at, 0) = 0 THEN 0
                WHEN (p.status = 'dead' OR p.lifecycle_state = 'dead') THEN 1
                ELSE 0 END ASC,
           CASE WHEN (p.status = 'dead' OR p.lifecycle_state = 'dead') THEN p.checked_at ELSE NULL END ASC NULLS FIRST,
           COALESCE(p.updated_at, p.created_at, 0) DESC,
           p.proxy_key ASC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      );

      const items: ProxyInventoryItem[] = rows.map((r) => {
        const endpoint = String(r.endpoint ?? "");
        let host = String(r.host ?? "").trim().replace(/^\[|\]$/g, "");
        let port = Number(r.port ?? 0);
        if (!host || !port) {
          try {
            const rawTarget = endpoint.includes("://") ? endpoint : `${r.protocol}://${endpoint}`;
            const parsed = parseProxyInput(rawTarget);
            host = parsed.parsed.host;
            port = parsed.parsed.port;
          } catch {
            const lastColon = endpoint.lastIndexOf(":");
            if (lastColon > 0) {
              host = endpoint.slice(0, lastColon).replace(/^\[|\]$/g, "");
              port = Number(endpoint.slice(lastColon + 1)) || 0;
            } else {
              host = endpoint;
              port = 0;
            }
          }
        }

        return {
          proxyKey: String(r.proxy_key),
          endpoint,
          protocol: String(r.protocol ?? "http"),
          host,
          port,
          username: r.username ? String(r.username) : undefined,
          hasAuth: Boolean(r.has_password || r.username),
          source: String(r.source ?? "legacy"),
          lifecycleState: (r.lifecycle_state as ProxyLifecycleState) ?? "unknown",
          status: String(r.status ?? "dead"),
          latencyMs: r.latency_ms !== null ? Number(r.latency_ms) : null,
          exitIp: r.exit_ip ? String(r.exit_ip) : null,
          successes: Number(r.successes ?? 0),
          failures: Number(r.failures ?? 0),
          lastError: r.last_error ? String(r.last_error) : null,
          checkedAt: r.checked_at ? Number(r.checked_at) : null,
          createdAt: r.created_at ? Number(r.created_at) : null,
          updatedAt: r.updated_at ? Number(r.updated_at) : null,
          latestVerdict: r.latest_verdict ? String(r.latest_verdict) : null,
          latestScore: r.latest_score !== null ? Number(r.latest_score) : null,
          latestAuditAt: r.latest_audit_at ? Number(r.latest_audit_at) : null,
          isPinned: Boolean(r.is_pinned),
          tags: typeof r.tags === "string" && r.tags ? r.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
          remoteId: r.remote_id ? String(r.remote_id) : null,
          routerState: typeof r.router_state === "string" ? r.router_state : "unmanaged",
          removedAt: r.removed_at ? Number(r.removed_at) : null,
          lastLatencyMs: r.last_latency_ms !== null && r.last_latency_ms !== undefined ? Number(r.last_latency_ms) : null,
        };
      });

      return {
        items,
        page,
        pageSize,
        total,
      };
    },

    async getProxy(proxyKey: string): Promise<ProxyInventoryDetail | null> {
      const row = db.get<Record<string, unknown>>(
        `SELECT
           p.proxy_key,
           p.endpoint,
           p.protocol,
           p.host,
           p.port,
           p.status,
           p.exit_ip,
           p.latency_ms,
           p.checked_at,
           p.successes,
           p.failures,
           p.last_error,
           p.source,
           p.lifecycle_state,
           p.username,
           CASE WHEN p.password IS NOT NULL AND p.password != '' THEN 1 ELSE 0 END AS has_password,
           p.created_at,
           p.updated_at,
           p.last_verdict,
           p.last_verdict AS latest_verdict,
           NULL AS latest_score,
           p.last_checked_at AS latest_audit_at,
           p.is_pinned,
           p.tags,
           p.remote_id,
           p.router_state,
           p.removed_at,
           p.last_latency_ms
         FROM proxies p
         WHERE p.proxy_key = ?`,
        [proxyKey]
      );

      if (!row) return null;

      const endpoint = String(row.endpoint ?? "");
      let host = String(row.host ?? "").trim().replace(/^\[|\]$/g, "");
      let port = Number(row.port ?? 0);
      if (!host || !port) {
        try {
          const rawTarget = endpoint.includes("://") ? endpoint : `${row.protocol}://${endpoint}`;
          const parsed = parseProxyInput(rawTarget);
          host = parsed.parsed.host;
          port = parsed.parsed.port;
        } catch {
          const lastColon = endpoint.lastIndexOf(":");
          if (lastColon > 0) {
            host = endpoint.slice(0, lastColon).replace(/^\[|\]$/g, "");
            port = Number(endpoint.slice(lastColon + 1)) || 0;
          } else {
            host = endpoint;
            port = 0;
          }
        }
      }
      const latestAudit: ProxyAuditResult | null = null;
      const auditHistory: Array<{
        id: string;
        verdict: string;
        lifecycleState: ProxyLifecycleState;
        overallScore: number | null;
        finishedAt: number | null;
      }> = [];
      const diagnosticHistory: Array<{
        id: string;
        status: string;
        latencyMs: number | null;
        checkedAt: number;
        errorMessage: string | null;
      }> = [];
      return {
        proxyKey: String(row.proxy_key),
        endpoint,
        protocol: String(row.protocol ?? "http"),
        host,
        port,
        username: row.username ? String(row.username) : undefined,
        hasAuth: Boolean(row.has_password || row.username),
        source: String(row.source ?? "legacy"),
        lifecycleState: (row.lifecycle_state as ProxyLifecycleState) ?? "unknown",
        status: String(row.status ?? "dead"),
        latencyMs: row.latency_ms !== null ? Number(row.latency_ms) : null,
        exitIp: row.exit_ip ? String(row.exit_ip) : null,
        successes: Number(row.successes ?? 0),
        failures: Number(row.failures ?? 0),
        lastError: row.last_error ? String(row.last_error) : null,
        checkedAt: row.checked_at ? Number(row.checked_at) : null,
        createdAt: row.created_at ? Number(row.created_at) : null,
        updatedAt: row.updated_at ? Number(row.updated_at) : null,
        latestVerdict: (row.latest_verdict ?? row.last_verdict) ? String(row.latest_verdict ?? row.last_verdict) : null,
        latestScore: row.latest_score !== null && row.latest_score !== undefined ? Number(row.latest_score) : null,
        latestAuditAt: row.latest_audit_at !== null && row.latest_audit_at !== undefined ? Number(row.latest_audit_at) : null,
        isPinned: Boolean(row.is_pinned),
        tags: typeof row.tags === "string" && row.tags ? row.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
        remoteId: row.remote_id ? String(row.remote_id) : null,
        routerState: typeof row.router_state === "string" ? row.router_state : "unmanaged",
        removedAt: row.removed_at ? Number(row.removed_at) : null,
        lastLatencyMs: row.last_latency_ms !== null && row.last_latency_ms !== undefined ? Number(row.last_latency_ms) : null,
        latestAudit,
        auditHistory,
        diagnosticHistory,
      };
    },

    async resolveProxyKeys(filter: ProxyInventoryFilter): Promise<string[]> {
      const whereClauses: string[] = ["1 = 1"];
      const params: SqlParam[] = [];

      if (filter.proxyKey?.trim()) {
        whereClauses.push("p.proxy_key = ?");
        params.push(filter.proxyKey.trim());
      }

      if (filter.search?.trim()) {
        const term = `%${filter.search.trim().toLowerCase()}%`;
        whereClauses.push("(LOWER(p.proxy_key) LIKE ? OR LOWER(p.endpoint) LIKE ? OR LOWER(COALESCE(p.exit_ip, '')) LIKE ? OR LOWER(COALESCE(p.host, '')) LIKE ?)");
        params.push(term, term, term, term);
      }

      if (filter.source && filter.source !== "all") {
        whereClauses.push("p.source = ?");
        params.push(filter.source);
      }

      if (filter.protocol && filter.protocol !== "all") {
        whereClauses.push("LOWER(p.protocol) = ?");
        params.push(filter.protocol.toLowerCase());
      }

      if (filter.lifecycle && filter.lifecycle !== "all") {
        whereClauses.push("p.lifecycle_state = ?");
        params.push(filter.lifecycle);
      }

      const healthFilter = filter.health || filter.status;
      if (healthFilter === "working") {
        whereClauses.push("(p.status = 'usable' OR p.last_verdict = 'PASS')");
      } else if (healthFilter === "regressed") {
        whereClauses.push("NOT (p.status = 'usable' OR p.last_verdict = 'PASS') AND (COALESCE(p.successes, 0) > 0 OR p.ever_passed = 1)");
      } else if (healthFilter === "dead") {
        whereClauses.push("NOT (p.status = 'usable' OR p.last_verdict = 'PASS') AND NOT (COALESCE(p.successes, 0) > 0 OR p.ever_passed = 1)");
      }

      const rows = db.all<{ proxy_key: string }>(
        `SELECT p.proxy_key
         FROM proxies p
         WHERE ${whereClauses.join(" AND ")}
         ORDER BY
           CASE WHEN (p.status = 'usable' OR p.last_verdict = 'PASS') THEN 0
                WHEN (COALESCE(p.successes, 0) > 0 OR p.ever_passed = 1) THEN 1
                ELSE 2
           END ASC,
           CASE WHEN (p.status = 'usable' OR p.last_verdict = 'PASS') THEN p.latency_ms ELSE NULL END ASC NULLS LAST,
           CASE WHEN NOT (p.status = 'usable' OR p.last_verdict = 'PASS') AND COALESCE(p.checked_at, 0) = 0 THEN 0
                WHEN NOT (p.status = 'usable' OR p.last_verdict = 'PASS') THEN 1
                ELSE NULL
           END ASC NULLS LAST,
           CASE WHEN NOT (p.status = 'usable' OR p.last_verdict = 'PASS') THEN p.checked_at ELSE NULL END ASC NULLS LAST,
           CASE WHEN (p.status = 'usable' OR p.last_verdict = 'PASS') THEN p.checked_at ELSE NULL END DESC NULLS LAST,
           p.proxy_key ASC`,
        params
      );

      return rows.map((r) => r.proxy_key);
    },
    async exportWorkingProxies(filter: WorkingExportFilter = {}): Promise<ExportResult> {
      const format = filter.format ?? "txt";
      const includeCreds = Boolean(filter.includeCredentials);
      const minRel = filter.minReliability ?? 90;
      const maxAge = filter.maxAuditAgeMs ?? 24 * 3600 * 1000;
      const minTime = Date.now() - maxAge;

      const rows = db.all<Record<string, unknown>>(
        `SELECT
           p.protocol,
           p.endpoint,
           p.host,
           p.port,
           p.username,
           p.password
         FROM proxies p
         WHERE p.status = 'usable' OR p.last_verdict = 'PASS'
         ORDER BY p.latency_ms ASC NULLS LAST`,
        []
      );

      const dateStr = new Date().toISOString().slice(0, 10);
      if (format === "csv") {
        const header = "protocol,host,port,username,password\n";
        const lines = rows.map((r) => {
          let host = String(r.host ?? "").trim().replace(/^\[|\]$/g, "");
          let port = String(r.port ?? "");
          if (!host || !port) {
            const lastColon = String(r.endpoint ?? "").lastIndexOf(":");
            if (lastColon > 0) {
              host = String(r.endpoint ?? "").slice(0, lastColon).replace(/^\[|\]$/g, "");
              port = String(r.endpoint ?? "").slice(lastColon + 1);
            } else {
              host = String(r.endpoint ?? "");
              port = "";
            }
          }
          const u = includeCreds && r.username ? String(r.username) : "";
          const p = includeCreds && r.password ? String(r.password) : "";
          return `"${r.protocol}","${host}",${port},"${u}","${p}"`;
        });
        return {
          filename: `working-proxies-${dateStr}.csv`,
          contentType: "text/csv; charset=utf-8",
          body: header + lines.join("\n"),
        };
      }

      const lines = rows.map((r) => {
        const proto = String(r.protocol ?? "http");
        const ep = String(r.endpoint ?? "");
        if (includeCreds && r.username && r.password) {
          return `${proto}://${encodeURIComponent(String(r.username))}:${encodeURIComponent(String(r.password))}@${ep}`;
        }
        return `${proto}://${ep}`;
      });

      return {
        filename: `working-proxies-${dateStr}.txt`,
        contentType: "text/plain; charset=utf-8",
        body: lines.join("\n"),
      };
    },
    async syncWorkingPools(pools) {
      const validPools = pools.filter((p) => p.status === "usable" || p.tier === "active" || Boolean(p.isActiveOnRouter));
      const now = Date.now();
      const proxyKeys: string[] = [];
      let imported = 0;

      db.transaction(() => {
        for (const item of validPools) {
          let parsedResult;
          try {
            parsedResult = parseProxyInput(item.proxyUrl);
          } catch {
            continue;
          }
          if (!parsedResult?.parsed) continue;
          const p = parsedResult.parsed;
          const key = computeProxyKey(p.protocol, p.host, p.port, p.username);
          proxyKeys.push(key);

          const routerState = item.tier === "active" ? "active" : item.tier === "reserve" ? "reserve" : "unmanaged";
          const existing = db.get<{ proxy_key: string }>("SELECT proxy_key FROM proxies WHERE proxy_key = ?", [key]);
          if (existing) {
            db.run(
              `UPDATE proxies SET
                source = '9router-working',
                lifecycle_state = 'working',
                status = 'usable',
                last_verdict = 'PASS',
                ever_passed = 1,
                latency_ms = COALESCE(?, latency_ms),
                exit_ip = COALESCE(?, exit_ip),
                password = COALESCE(?, password),
                remote_id = COALESCE(?, remote_id),
                router_state = ?,
                updated_at = ?
              WHERE proxy_key = ?`,
              [item.latency_ms ?? null, item.exit_ip ?? null, p.password ?? null, item.remoteId ?? null, routerState, now, key]
            );
          } else {
            db.run(
              `INSERT INTO proxies (
                proxy_key, endpoint, protocol, host, port, status, exit_ip,
                latency_ms, checked_at, successes, failures, last_error,
                source, lifecycle_state, last_verdict, ever_passed, username, password, remote_id, router_state, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                key,
                `${p.host}:${p.port}`,
                p.protocol,
                p.host,
                p.port,
                "usable",
                item.exit_ip ?? null,
                item.latency_ms ?? null,
                now,
                1,
                0,
                null,
                "9router-working",
                "working",
                "PASS",
                1,
                p.username ?? null,
                p.password ?? null,
                item.remoteId ?? null,
                routerState,
                now,
                now,
              ]
            );
          }
          imported++;
        }
      });

      return { imported, proxyKeys };
    },
    async getUnifiedProxies(filter: UnifiedProxyFilter = {}): Promise<UnifiedProxyResponse> {
      const page = Math.max(1, filter.page ?? 1);
      const pageSize = Math.max(1, Math.min(100, filter.pageSize ?? 50));
      const offset = (page - 1) * pageSize;

      const baseWhere: string[] = ["1 = 1"];
      const baseParams: SqlParam[] = [];

      if (filter.proxyKey?.trim()) {
        baseWhere.push("p.proxy_key = ?");
        baseParams.push(filter.proxyKey.trim());
      }

      if (filter.source && filter.source !== "all") {
        baseWhere.push("p.source = ?");
        baseParams.push(filter.source);
      }

      if (filter.search?.trim()) {
        const term = `%${filter.search.trim().toLowerCase()}%`;
        baseWhere.push("(LOWER(p.proxy_key) LIKE ? OR LOWER(p.endpoint) LIKE ? OR LOWER(COALESCE(p.exit_ip, '')) LIKE ? OR LOWER(COALESCE(p.host, '')) LIKE ?)");
        baseParams.push(term, term, term, term);
      }

      if (filter.protocol && filter.protocol !== "all") {
        baseWhere.push("LOWER(p.protocol) = ?");
        baseParams.push(filter.protocol.toLowerCase());
      }

      const baseWhereSql = baseWhere.join(" AND ");

      // 1. Calculate overall counts for all, working, regressed, dead
      const countsRow = db.get<{
        total_all: number;
        total_working: number;
        total_regressed: number;
        total_dead: number;
      }>(
        `SELECT
           COUNT(*) AS total_all,
           SUM(CASE WHEN (p.status = 'usable' OR COALESCE(p.last_verdict, '') = 'PASS') THEN 1 ELSE 0 END) AS total_working,
           SUM(CASE WHEN NOT (p.status = 'usable' OR COALESCE(p.last_verdict, '') = 'PASS') AND (COALESCE(p.successes, 0) > 0 OR p.ever_passed = 1) THEN 1 ELSE 0 END) AS total_regressed,
           SUM(CASE WHEN NOT (p.status = 'usable' OR COALESCE(p.last_verdict, '') = 'PASS') AND NOT (COALESCE(p.successes, 0) > 0 OR p.ever_passed = 1) THEN 1 ELSE 0 END) AS total_dead
         FROM proxies p
         WHERE ${baseWhereSql}`,
        baseParams
      );

      const counts: UnifiedProxyCounts = {
        all: Number(countsRow?.total_all ?? 0),
        working: Number(countsRow?.total_working ?? 0),
        regressed: Number(countsRow?.total_regressed ?? 0),
        dead: Number(countsRow?.total_dead ?? 0),
      };

      // 2. Filter by status if specified
      const statusWhere = [...baseWhere];
      const statusParams = [...baseParams];

      const statusFilter = filter.health || filter.status;
      if (statusFilter === "working") {
        statusWhere.push("(p.status = 'usable' OR COALESCE(p.last_verdict, '') = 'PASS')");
      } else if (statusFilter === "regressed") {
        statusWhere.push("NOT (p.status = 'usable' OR COALESCE(p.last_verdict, '') = 'PASS') AND (COALESCE(p.successes, 0) > 0 OR p.ever_passed = 1)");
      } else if (statusFilter === "dead") {
        statusWhere.push("NOT (p.status = 'usable' OR COALESCE(p.last_verdict, '') = 'PASS') AND NOT (COALESCE(p.successes, 0) > 0 OR p.ever_passed = 1)");
      }

      const statusWhereSql = statusWhere.join(" AND ");

      const countFilteredRow = db.get<{ total: number }>(
        `SELECT COUNT(*) AS total
         FROM proxies p
         WHERE ${statusWhereSql}`,
        statusParams
      );

      const total = Number(countFilteredRow?.total ?? 0);

      let orderBySql: string;
      const direction = filter.direction?.toLowerCase() === "desc" ? "DESC" : "ASC";
      if (filter.sort === "latency") {
        orderBySql = `p.latency_ms ${direction} NULLS LAST, p.proxy_key ASC`;
      } else if (filter.sort === "lastChecked") {
        const checkDir = filter.direction?.toLowerCase() === "asc" ? "ASC" : "DESC";
        orderBySql = `p.checked_at ${checkDir} NULLS LAST, p.proxy_key ASC`;
      } else if (filter.sort === "endpoint") {
        orderBySql = `p.endpoint ${direction}, p.proxy_key ASC`;
      } else {
        orderBySql = `
          CASE
            WHEN (p.status = 'usable' OR COALESCE(p.last_verdict, '') = 'PASS') THEN 0
            WHEN (COALESCE(p.successes, 0) > 0 OR p.ever_passed = 1) THEN 1
            ELSE 2
          END ASC,
          CASE
            WHEN (p.status = 'usable' OR COALESCE(p.last_verdict, '') = 'PASS') THEN p.latency_ms
            ELSE NULL
          END ASC NULLS LAST,
          CASE
            WHEN NOT (p.status = 'usable' OR COALESCE(p.last_verdict, '') = 'PASS') AND COALESCE(p.checked_at, 0) = 0 THEN 0
            WHEN NOT (p.status = 'usable' OR COALESCE(p.last_verdict, '') = 'PASS') THEN 1
            ELSE NULL
          END ASC NULLS LAST,
          CASE
            WHEN NOT (p.status = 'usable' OR COALESCE(p.last_verdict, '') = 'PASS') THEN p.checked_at
            ELSE NULL
          END ASC NULLS LAST,
          CASE
            WHEN (p.status = 'usable' OR COALESCE(p.last_verdict, '') = 'PASS') THEN p.checked_at
            ELSE NULL
          END DESC NULLS LAST,
          p.proxy_key ASC`;
      }

      const rows = db.all<Record<string, unknown>>(
        `SELECT
           p.proxy_key,
           p.endpoint,
           p.protocol,
           p.host,
           p.port,
           p.status,
           p.source,
           p.exit_ip,
           p.latency_ms,
           p.checked_at,
           p.successes,
           p.failures,
           p.ever_passed,
           p.last_verdict,
           p.last_failure_code,
           p.is_pinned,
           p.tags,
           p.remote_id,
           p.router_state,
           p.removed_at,
           p.last_latency_ms,
           NULL AS latest_audit_id,
           p.last_verdict AS latest_verdict,
           p.last_checked_at AS latest_finished_at,
           NULL AS overall_score,
           NULL AS result_json,
           p.ever_passed AS has_pass,
           CASE
             WHEN (p.status = 'usable' OR COALESCE(p.last_verdict, '') = 'PASS') THEN 'working'
             WHEN (COALESCE(p.successes, 0) > 0 OR p.ever_passed = 1) THEN 'regressed'
             ELSE 'dead'
           END AS computed_status
         FROM proxies p
         WHERE ${statusWhereSql}
         ORDER BY ${orderBySql}
         LIMIT ? OFFSET ?`,
        [...statusParams, pageSize, offset]
      );

      const protoRows = db.all<{ proto: string; count: number }>(
        "SELECT LOWER(protocol) AS proto, COUNT(*) AS count FROM proxies GROUP BY LOWER(protocol)"
      );
      const protocols: Record<string, number> = {};
      for (const pr of protoRows) {
        if (pr.proto) protocols[pr.proto] = Number(pr.count || 0);
      }

      const items: UnifiedProxyItem[] = rows.map((r) => {
        let geo: { city?: string; country?: string } | undefined;
        let isp: string | undefined;
        let timezone: string | undefined;
        let udpVal: "Yes" | "No" | "Unknown" = String(r.protocol).toLowerCase() === "socks5" ? "Yes" : "No";
        let parsedAuditResult: Record<string, unknown> | null = null;

        if (typeof r.result_json === "string") {
          try {
            const parsed = JSON.parse(r.result_json);
            if (parsed && typeof parsed === "object") {
              parsedAuditResult = parsed as Record<string, unknown>;
              const evidenceObj = parsedAuditResult.evidence && typeof parsedAuditResult.evidence === "object"
                ? (parsedAuditResult.evidence as Record<string, unknown>)
                : null;
              const exitIpObj = (parsedAuditResult.exitIp && typeof parsedAuditResult.exitIp === "object"
                ? parsedAuditResult.exitIp
                : evidenceObj?.exitIp && typeof evidenceObj.exitIp === "object"
                  ? evidenceObj.exitIp
                  : null) as Record<string, unknown> | null;
              if (exitIpObj) {
                geo = exitIpObj.geo as { city?: string; country?: string } | undefined;
                isp = typeof exitIpObj.isp === "string" ? exitIpObj.isp : undefined;
                timezone = typeof exitIpObj.timezone === "string" ? exitIpObj.timezone : undefined;
              }
              const netObj = (parsedAuditResult.network && typeof parsedAuditResult.network === "object"
                ? parsedAuditResult.network
                : evidenceObj?.network && typeof evidenceObj.network === "object"
                  ? evidenceObj.network
                  : null) as Record<string, unknown> | null;
              if (netObj && netObj.udp !== undefined) {
                udpVal = netObj.udp ? "Yes" : "No";
              }
            }
          } catch {}
        }

        const endpoint = String(r.endpoint ?? "");
        let itemHost = String(r.host ?? "").trim().replace(/^\[|\]$/g, "");
        let itemPort = Number(r.port ?? 0);
        if (!itemHost || !itemPort) {
          try {
            const rawTarget = endpoint.includes("://") ? endpoint : `${r.protocol}://${endpoint}`;
            const parsed = parseProxyInput(rawTarget);
            itemHost = parsed.parsed.host;
            itemPort = parsed.parsed.port;
          } catch {
            const lastColon = endpoint.lastIndexOf(":");
            if (lastColon > 0) {
              itemHost = endpoint.slice(0, lastColon).replace(/^\[|\]$/g, "");
              itemPort = Number(endpoint.slice(lastColon + 1)) || 0;
            } else {
              itemHost = endpoint;
              itemPort = 0;
            }
          }
        }

        let syncStatus: "active" | "reserve" | "unsynced" = "unsynced";
        if (filter.activePoolEndpoints?.has(endpoint)) {
          syncStatus = "active";
        } else if (filter.reservePoolEndpoints?.has(endpoint)) {
          syncStatus = "reserve";
        }

        const computedStatus = r.computed_status as "working" | "dead" | "regressed";
        const isWorking = computedStatus === "working";
        const currentLatency = isWorking && r.latency_ms !== null && r.latency_ms !== undefined ? Number(r.latency_ms) : null;

        const effectiveVerdict = (r.last_verdict || r.latest_verdict) as "PASS" | "WARN" | "FAIL" | undefined;
        let lastAudit = null;
        if (effectiveVerdict) {
          let auditLatency: number | undefined;
          const connObj = parsedAuditResult?.connectivity && typeof parsedAuditResult.connectivity === "object"
            ? (parsedAuditResult.connectivity as Record<string, unknown>)
            : null;
          if (connObj && connObj.latencyMs !== undefined && connObj.latencyMs !== null) {
            auditLatency = Number(connObj.latencyMs);
          } else if (isWorking && r.latency_ms !== null && r.latency_ms !== undefined) {
            auditLatency = Number(r.latency_ms);
          }
          lastAudit = {
            id: String(r.latest_audit_id || "audit-latest"),
            verdict: effectiveVerdict,
            checkedAt: r.latest_finished_at ? new Date(Number(r.latest_finished_at)).toISOString() : new Date().toISOString(),
            exitIp: r.exit_ip ? String(r.exit_ip) : undefined,
            country: geo?.country,
            isp,
            latencyMs: auditLatency,
            overallSafety: r.overall_score !== null && r.overall_score !== undefined ? Number(r.overall_score) : undefined,
            primaryReasonCode: r.last_failure_code ? String(r.last_failure_code) : undefined,
          };
        }

        const key = String(r.proxy_key);
        const poolTier = syncStatus === "unsynced" ? null : (syncStatus as "active" | "reserve");
        const protoStr = String(r.protocol).toLowerCase();
        const protocol: "http" | "https" | "socks4" | "socks5" =
          protoStr === "socks4" || protoStr === "socks5" || protoStr === "https" ? protoStr : "http";

        return {
          proxyKey: key,
          host: itemHost,
          port: itemPort,
          protocol,
          source: r.source ? String(r.source) : null,
          poolTier,
          health: computedStatus,
          everPassed: Boolean(r.ever_passed || r.has_pass || effectiveVerdict === "PASS"),
          lastAudit,

          key,
          name: endpoint,
          status: computedStatus,
          udp: udpVal,
          sync: syncStatus,
          latencyMs: currentLatency,
          exitIp: r.exit_ip ? String(r.exit_ip) : null,
          geo,
          isp,
          timezone,
          lastCheckedAt: r.checked_at ? Number(r.checked_at) : null,
          isPinned: Boolean(r.is_pinned),
          tags: typeof r.tags === "string" && r.tags ? r.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
          remoteId: r.remote_id ? String(r.remote_id) : null,
          routerState: (r.router_state as "active" | "reserve" | "removed" | "unmanaged") || "unmanaged",
          removedAt: r.removed_at ? Number(r.removed_at) : null,
          lastLatencyMs: r.last_latency_ms !== null && r.last_latency_ms !== undefined ? Number(r.last_latency_ms) : null,
        };
      });

      return {
        total,
        counts,
        pagination: { page, pageSize, total },
        facets: {
          all: counts.all,
          working: counts.working,
          regressed: counts.regressed,
          dead: counts.dead,
          protocols,
        },
        meta: {
          generatedAt: new Date().toISOString(),
        },
        items,
      };

    },
    async persistAuditSnapshot(input: PersistAuditSnapshotInput): Promise<void> {
      const auditId = input.auditId || crypto.randomUUID();
      const finishedTime = input.finishedAt || Date.now();
      const startedTime = input.startedAt || finishedTime;
      const verdict = input.result.verdict;
      const latency = input.result.connectivity?.latencyMs ?? null;
      const exitIp = input.result.exitIp?.ip ?? null;
      const failureCode = input.result.riskFactors?.find((r) => r.severity === "critical")?.code ?? null;
      const criticalRisk = input.result.riskFactors?.some((r) => r.severity === "critical");
      let lifecycle: ProxyLifecycleState = "unknown";
      if (criticalRisk) {
        lifecycle = "dangerous";
      } else if (verdict === "FAIL") {
        lifecycle = "dead";
      } else if (input.result.scores?.reliability !== null && input.result.scores?.reliability !== undefined && input.result.scores.reliability < 80) {
        lifecycle = "unstable";
      } else if (verdict === "PASS" || verdict === "WARN") {
        lifecycle = "working";
      }

      db.transaction(() => {
        db.run(
          `UPDATE proxies SET
            last_verdict = ?,
            last_checked_at = ?,
            last_latency_ms = CASE WHEN ? = 'FAIL' THEN NULL ELSE COALESCE(?, last_latency_ms) END,
            last_exit_ip = COALESCE(?, last_exit_ip),
            last_failure_code = ?,
            ever_passed = CASE WHEN ? = 'PASS' THEN 1 ELSE ever_passed END,
            status = CASE WHEN ? = 'FAIL' THEN 'dead' ELSE 'usable' END,
            lifecycle_state = ?,
            latency_ms = CASE WHEN ? = 'FAIL' THEN NULL ELSE COALESCE(?, latency_ms) END,
            exit_ip = COALESCE(?, exit_ip),
            checked_at = ?,
            updated_at = ?
          WHERE proxy_key = ?`,
          [
            verdict,
            finishedTime,
            verdict,
            latency,
            exitIp,
            failureCode,
            verdict,
            verdict,
            lifecycle,
            verdict,
            latency,
            exitIp,
            finishedTime,
            finishedTime,
            input.proxyKey,
          ]
        );
      });
    },
    async previewImport(input: ProxyImportInput): Promise<ProxyImportPreview> {
      const lines = input.content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
      const protocols: Record<string, number> = {};
      const invalidLines: Array<{ line: number; text: string; error: string }> = [];
      const sampleValid: Array<{ endpoint: string; protocol: string }> = [];
      let valid = 0;
      let duplicates = 0;
      const seenKeys = new Set<string>();

      for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx]!;
        const defaultScheme = input.source.toLowerCase().includes("socks") ? "socks5" : "http";
        let parsedResult;
        try {
          parsedResult = parseProxyInput(line, defaultScheme);
        } catch (err) {
          invalidLines.push({ line: idx + 1, text: line, error: (err as Error).message });
          continue;
        }

        if (!parsedResult?.parsed) {
          invalidLines.push({ line: idx + 1, text: line, error: "Invalid proxy format" });
          continue;
        }

        const p = parsedResult.parsed;
        const key = computeProxyKey(p.protocol, p.host, p.port, p.username);
        if (seenKeys.has(key)) {
          duplicates++;
          continue;
        }
        seenKeys.add(key);

        valid++;
        protocols[p.protocol] = (protocols[p.protocol] ?? 0) + 1;
        if (sampleValid.length < 5) {
          sampleValid.push({ endpoint: `${p.host}:${p.port}`, protocol: p.protocol });
        }
      }

      return {
        source: input.source,
        totalLines: lines.length,
        valid,
        invalid: invalidLines.length,
        duplicates,
        protocols,
        invalidLines: invalidLines.slice(0, 50),
        sampleValid,
      };
    },
    async getAuditDetail(proxyKey: string): Promise<ProxyAuditDetail | null> {
      const row = db.get<{ proxy_key: string; status: string; last_verdict?: string; last_latency_ms?: number }>(
        "SELECT proxy_key, status, last_verdict, last_latency_ms FROM proxies WHERE proxy_key = ?",
        [proxyKey]
      );
      if (!row) return null;
      const verdict = (row.last_verdict === "PASS" || row.last_verdict === "WARN" || row.last_verdict === "FAIL")
        ? row.last_verdict
        : (row.status === "usable" ? "PASS" : "FAIL");
      return {
        proxyKey: row.proxy_key,
        verdict,
      };
    },
    async setPin(proxyKey: string, isPinned: boolean): Promise<boolean> {
      const pinVal = isPinned ? 1 : 0;
      db.run("UPDATE proxies SET is_pinned = ?, updated_at = ? WHERE proxy_key = ?", [pinVal, Date.now(), proxyKey]);
      return isPinned;
    },
    async updateTags(proxyKey: string, tags: string[]): Promise<void> {
      const serialized = tags.map((t) => t.trim()).filter(Boolean).join(",");
      db.run("UPDATE proxies SET tags = ?, updated_at = ? WHERE proxy_key = ?", [serialized, Date.now(), proxyKey]);
    },
    async recordTestResult(proxyKeyOrUrl: string, ok: boolean, latencyMs?: number, errorMessage?: string): Promise<void> {
      const testedAt = Date.now();
      let resolvedKey = proxyKeyOrUrl;
      try {
        const parsed = parseProxyInput(proxyKeyOrUrl);
        if (parsed?.parsed) {
          resolvedKey = computeProxyKey(parsed.parsed.protocol, parsed.parsed.host, parsed.parsed.port, parsed.parsed.username);
        }
      } catch {}

      let matchedKey = resolvedKey;
      const existing = db.get<{ proxy_key: string }>("SELECT proxy_key FROM proxies WHERE proxy_key = ?", [resolvedKey]);
      if (!existing) {
        const fallbackRow = db.get<{ proxy_key: string }>("SELECT proxy_key FROM proxies WHERE proxy_key = ?", [proxyKeyOrUrl]);
        if (fallbackRow) {
          matchedKey = fallbackRow.proxy_key;
        } else {
          try {
            const u = new URL(proxyKeyOrUrl.includes("://") ? proxyKeyOrUrl : `http://${proxyKeyOrUrl}`);
            const hostPort = u.host;
            const epRow = db.get<{ proxy_key: string }>(
              "SELECT proxy_key FROM proxies WHERE endpoint = ? ORDER BY CASE WHEN source = '9router-working' THEN 0 ELSE 1 END LIMIT 1",
              [hostPort]
            );
            if (epRow) matchedKey = epRow.proxy_key;
          } catch {}
        }
      }

      db.transaction(() => {
        db.run(
          `INSERT INTO proxy_test_history (proxy_key, tested_at, ok, latency_ms, error_message)
           VALUES (?, ?, ?, ?, ?)`,
          [matchedKey, testedAt, ok ? 1 : 0, latencyMs ?? null, errorMessage ?? null]
        );
        if (ok) {
          db.run(
            `UPDATE proxies SET
              status = 'usable',
              lifecycle_state = 'working',
              last_verdict = 'PASS',
              last_error = NULL,
              last_failure_code = NULL,
              last_checked_at = ?,
              last_latency_ms = ?,
              latency_ms = ?,
              successes = successes + 1,
              ever_passed = 1,
              checked_at = ?,
              updated_at = ?
             WHERE proxy_key = ?`,
            [testedAt, latencyMs ?? null, latencyMs ?? null, testedAt, testedAt, matchedKey]
          );
        } else {
          db.run(
            `UPDATE proxies SET
              status = 'dead',
              last_verdict = 'FAIL',
              lifecycle_state = CASE WHEN ever_passed = 1 THEN 'regressed' ELSE 'dead' END,
              latency_ms = NULL,
              last_latency_ms = NULL,
              last_checked_at = ?,
              last_error = ?,
              failures = failures + 1,
              checked_at = ?,
              updated_at = ?
             WHERE proxy_key = ?`,
            [testedAt, errorMessage ?? null, testedAt, testedAt, matchedKey]
          );
        }
      });
    },
    async softDeleteFromRouter(proxyKey: string, errorMessage?: string): Promise<void> {
      const now = Date.now();
      db.run(
        `UPDATE proxies SET
          status = 'dead',
          router_state = 'removed',
          remote_id = NULL,
          removed_at = ?,
          last_error = COALESCE(?, last_error),
          updated_at = ?
         WHERE proxy_key = ?`,
        [now, errorMessage ?? null, now, proxyKey]
      );
    },
    async hardDeleteProxy(proxyKey: string, force?: boolean): Promise<{ deleted: boolean; remoteId: string | null }> {
      const row = db.get<{ is_pinned: number; remote_id: string | null }>(
        "SELECT is_pinned, remote_id FROM proxies WHERE proxy_key = ?",
        [proxyKey]
      );
      if (!row) {
        return { deleted: false, remoteId: null };
      }
      if (row.is_pinned === 1 && !force) {
        throw new Error(`Proxy ${proxyKey} is pinned. Unpin or use force to delete.`);
      }
      db.transaction(() => {
        db.run("DELETE FROM proxy_test_history WHERE proxy_key = ?", [proxyKey]);
        db.run("DELETE FROM proxies WHERE proxy_key = ?", [proxyKey]);
      });
      return { deleted: true, remoteId: row.remote_id ? String(row.remote_id) : null };
    },
    async syncManagedFleetEndpoints(rows: Array<{
      nodeId: string;
      endpointId: string;
      proxyUrl: string;
    }>): Promise<number> {
      if (!rows || rows.length === 0) return 0;
      const now = Date.now();
      let count = 0;

      db.transaction(() => {
        for (const row of rows) {
          let parsedResult;
          try {
            parsedResult = parseProxyInput(row.proxyUrl, "http");
          } catch {
            continue;
          }
          if (!parsedResult?.parsed) continue;

          const p = parsedResult.parsed;
          const key = computeProxyKey(p.protocol, p.host, p.port, p.username);
          const userPart = p.username ? `${encodeURIComponent(p.username)}@` : "";
          const endpointDisplay = `${p.protocol}://${userPart}${p.host}:${p.port}`;

          const existing = db.get<{
            proxy_key: string;
            source: string;
            is_pinned: number;
            remote_id: string | null;
            router_state: string;
            tags: string;
            password: string | null;
          }>(
            "SELECT proxy_key, source, is_pinned, remote_id, router_state, tags, password FROM proxies WHERE proxy_key = ?",
            [key]
          );

          const isPreExistingShared = Boolean(
            existing &&
            existing.source !== "proxyfleet" &&
            existing.source !== "9router-working"
          );
          const ownedExclusive = isPreExistingShared ? 0 : 1;

          if (existing) {
            if (existing.source === "proxyfleet") {
              const updatedPassword = p.password ?? existing.password;
              db.run(
                `UPDATE proxies SET
                  endpoint = ?,
                  password = ?,
                  updated_at = ?
                 WHERE proxy_key = ?`,
                [endpointDisplay, updatedPassword, now, key]
              );
            } else {
              db.run(
                `UPDATE proxies SET updated_at = ? WHERE proxy_key = ?`,
                [now, key]
              );
            }
          } else {
            db.run(
              `INSERT INTO proxies (
                proxy_key, endpoint, protocol, host, port, username, password,
                source, lifecycle_state, status, latency_ms, exit_ip,
                successes, failures, last_error, checked_at, created_at, updated_at,
                ever_passed, is_pinned, tags, remote_id, router_state
              ) VALUES (
                ?, ?, ?, ?, ?, ?, ?,
                'proxyfleet', 'unknown', 'dead', NULL, NULL,
                0, 0, NULL, 0, ?, ?,
                0, 0, 'fleet', NULL, 'unmanaged'
              )`,
              [
                key,
                endpointDisplay,
                p.protocol,
                p.host,
                p.port,
                p.username ?? null,
                p.password ?? null,
                now,
                now,
              ]
            );
          }

          const existingMappings = db.all<{ proxy_key: string; pending_cleanup: number }>(
            "SELECT proxy_key, pending_cleanup FROM fleet_managed_endpoints WHERE node_id = ? AND endpoint_id = ?",
            [row.nodeId, row.endpointId]
          );

          const activeMapping = existingMappings.find((m) => m.pending_cleanup === 0);

          if (activeMapping) {
            if (activeMapping.proxy_key !== key) {
              const oldProxyKey = activeMapping.proxy_key;
              const oldProxy = db.get<{ source: string; remote_id: string | null; is_pinned: number; router_state: string }>(
                "SELECT source, remote_id, is_pinned, router_state FROM proxies WHERE proxy_key = ?",
                [oldProxyKey]
              );
              const hasExternalRefs = oldProxy && (oldProxy.remote_id || oldProxy.is_pinned === 1 || oldProxy.router_state === "active");

              if (hasExternalRefs) {
                db.run(
                  "UPDATE fleet_managed_endpoints SET pending_cleanup = 1, updated_at = ? WHERE node_id = ? AND endpoint_id = ? AND proxy_key = ?",
                  [now, row.nodeId, row.endpointId, oldProxyKey]
                );
              } else {
                db.run(
                  "DELETE FROM fleet_managed_endpoints WHERE node_id = ? AND endpoint_id = ? AND proxy_key = ?",
                  [row.nodeId, row.endpointId, oldProxyKey]
                );
                const otherMappings = db.get<{ count: number }>(
                  "SELECT COUNT(*) as count FROM fleet_managed_endpoints WHERE proxy_key = ?",
                  [oldProxyKey]
                );
                if (!otherMappings || otherMappings.count === 0) {
                  if (oldProxy && oldProxy.source === "proxyfleet") {
                    db.run("DELETE FROM proxy_test_history WHERE proxy_key = ?", [oldProxyKey]);
                    db.run("DELETE FROM proxies WHERE proxy_key = ?", [oldProxyKey]);
                  }
                }
              }

              db.run(
                `INSERT INTO fleet_managed_endpoints (node_id, endpoint_id, proxy_key, created_at, updated_at, pending_cleanup, owned_exclusive)
                 VALUES (?, ?, ?, ?, ?, 0, ?)
                 ON CONFLICT (node_id, endpoint_id, proxy_key) DO UPDATE SET updated_at = ?, pending_cleanup = 0`,
                [row.nodeId, row.endpointId, key, now, now, ownedExclusive, now]
              );
            } else {
              db.run(
                "UPDATE fleet_managed_endpoints SET updated_at = ?, pending_cleanup = 0 WHERE node_id = ? AND endpoint_id = ? AND proxy_key = ?",
                [now, row.nodeId, row.endpointId, key]
              );
            }
          } else {
            db.run(
              `INSERT INTO fleet_managed_endpoints (node_id, endpoint_id, proxy_key, created_at, updated_at, pending_cleanup, owned_exclusive)
               VALUES (?, ?, ?, ?, ?, 0, ?)
               ON CONFLICT (node_id, endpoint_id, proxy_key) DO UPDATE SET updated_at = ?, pending_cleanup = 0`,
              [row.nodeId, row.endpointId, key, now, now, ownedExclusive, now]
            );
          }

          count++;
        }
      });

      return count;
    },
    async unlinkManagedFleetNode(nodeId: string, options?: {
      cleanupRemoteRef?: (remoteId: string, proxyKey: string) => Promise<void>;
      force?: boolean;
    }): Promise<void> {
      const mappings = db.all<{
        node_id: string;
        endpoint_id: string;
        proxy_key: string;
        pending_cleanup: number;
        owned_exclusive: number;
      }>(
        "SELECT node_id, endpoint_id, proxy_key, pending_cleanup, owned_exclusive FROM fleet_managed_endpoints WHERE node_id = ?",
        [nodeId]
      );

      if (!mappings || mappings.length === 0) {
        return;
      }

      for (const m of mappings) {
        const proxy = db.get<{
          proxy_key: string;
          source: string;
          is_pinned: number;
          remote_id: string | null;
          router_state: string;
        }>(
          "SELECT proxy_key, source, is_pinned, remote_id, router_state FROM proxies WHERE proxy_key = ?",
          [m.proxy_key]
        );

        if (!proxy) {
          db.run(
            "DELETE FROM fleet_managed_endpoints WHERE node_id = ? AND endpoint_id = ? AND proxy_key = ?",
            [m.node_id, m.endpoint_id, m.proxy_key]
          );
          continue;
        }

        const otherFleetRefsBefore = db.get<{ count: number }>(
          "SELECT COUNT(*) as count FROM fleet_managed_endpoints WHERE proxy_key = ? AND NOT (node_id = ? AND endpoint_id = ?)",
          [m.proxy_key, m.node_id, m.endpoint_id]
        );
        const isSharedAcrossFleet = Boolean(otherFleetRefsBefore && otherFleetRefsBefore.count > 0);

        if (isSharedAcrossFleet) {
          db.run(
            "DELETE FROM fleet_managed_endpoints WHERE node_id = ? AND endpoint_id = ? AND proxy_key = ?",
            [m.node_id, m.endpoint_id, m.proxy_key]
          );
          continue;
        }

        const isFleetExclusive = m.owned_exclusive === 1;
        const hasRemoteRef = Boolean(proxy.remote_id || proxy.router_state === "active");

        if (hasRemoteRef) {
          if (!isFleetExclusive) {
            db.run(
              "DELETE FROM fleet_managed_endpoints WHERE node_id = ? AND endpoint_id = ? AND proxy_key = ?",
              [m.node_id, m.endpoint_id, m.proxy_key]
            );
            continue;
          }

          if (options?.cleanupRemoteRef && proxy.remote_id) {
            try {
              await options.cleanupRemoteRef(proxy.remote_id, proxy.proxy_key);
            } catch (cleanupErr) {
              const reason = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
              throw new Error(
                `Cannot unlink fleet node ${nodeId}: endpoint ${m.endpoint_id} (proxy ${m.proxy_key}) remote cleanup failed: ${reason}`
              );
            }

            let deleteSucceeded = false;
            db.transaction(() => {
              const current = db.get<{ remote_id: string | null }>(
                "SELECT remote_id FROM proxies WHERE proxy_key = ?",
                [m.proxy_key]
              );
              const otherRefs = db.get<{ count: number }>(
                "SELECT COUNT(*) as count FROM fleet_managed_endpoints WHERE proxy_key = ? AND NOT (node_id = ? AND endpoint_id = ?)",
                [m.proxy_key, m.node_id, m.endpoint_id]
              );
              if (current?.remote_id !== proxy.remote_id || (otherRefs?.count ?? 0) > 0) return;
              const deleteRes = db.run(
                "DELETE FROM fleet_managed_endpoints WHERE node_id = ? AND endpoint_id = ? AND proxy_key = ? AND pending_cleanup = ? AND owned_exclusive = 1",
                [m.node_id, m.endpoint_id, m.proxy_key, m.pending_cleanup]
              );
              if (deleteRes.changes > 0) {
                deleteSucceeded = true;
                db.run(
                  "UPDATE proxies SET remote_id = NULL, router_state = 'unmanaged' WHERE proxy_key = ? AND remote_id = ?",
                  [m.proxy_key, proxy.remote_id]
                );
              }
            });

            if (!deleteSucceeded) {
              continue;
            }
          } else if (!options?.force) {
            throw new Error(
              `Cannot unlink fleet node ${nodeId}: endpoint ${m.endpoint_id} (proxy ${m.proxy_key}) has active remote reference '${proxy.remote_id ?? proxy.router_state}' pending cleanup`
            );
          } else {
            db.run(
              "DELETE FROM fleet_managed_endpoints WHERE node_id = ? AND endpoint_id = ? AND proxy_key = ?",
              [m.node_id, m.endpoint_id, m.proxy_key]
            );
          }
        } else {
          db.run(
            "DELETE FROM fleet_managed_endpoints WHERE node_id = ? AND endpoint_id = ? AND proxy_key = ?",
            [m.node_id, m.endpoint_id, m.proxy_key]
          );
        }

        const otherRefs = db.get<{ count: number }>(
          "SELECT COUNT(*) as count FROM fleet_managed_endpoints WHERE proxy_key = ?",
          [m.proxy_key]
        );
        if (!otherRefs || otherRefs.count === 0) {
          const freshProxy = db.get<{ source: string; is_pinned: number; remote_id: string | null }>(
            "SELECT source, is_pinned, remote_id FROM proxies WHERE proxy_key = ?",
            [m.proxy_key]
          );
          if (freshProxy && freshProxy.source === "proxyfleet" && !freshProxy.is_pinned && !freshProxy.remote_id) {
            db.run("DELETE FROM proxy_test_history WHERE proxy_key = ?", [m.proxy_key]);
            db.run("DELETE FROM proxies WHERE proxy_key = ?", [m.proxy_key]);
          }
        }
      }
    },
    async cleanupPendingManagedFleetEndpoints(options?: {
      cleanupRemoteRef?: (remoteId: string, proxyKey: string) => Promise<void>;
      force?: boolean;
    }): Promise<{ cleaned: number; pendingRemaining: number }> {
      const pending = db.all<{
        node_id: string;
        endpoint_id: string;
        proxy_key: string;
        owned_exclusive: number;
      }>(
        "SELECT node_id, endpoint_id, proxy_key, owned_exclusive FROM fleet_managed_endpoints WHERE pending_cleanup = 1"
      );

      let cleaned = 0;
      let pendingRemaining = 0;

      for (const m of pending) {
        const otherActive = db.get<{ count: number }>(
          "SELECT COUNT(*) as count FROM fleet_managed_endpoints WHERE proxy_key = ? AND pending_cleanup = 0",
          [m.proxy_key]
        );

        if (otherActive && otherActive.count > 0) {
          db.run(
            "DELETE FROM fleet_managed_endpoints WHERE node_id = ? AND endpoint_id = ? AND proxy_key = ? AND pending_cleanup = 1",
            [m.node_id, m.endpoint_id, m.proxy_key]
          );
          cleaned++;
          continue;
        }

        const proxy = db.get<{
          proxy_key: string;
          source: string;
          is_pinned: number;
          remote_id: string | null;
          router_state: string;
        }>(
          "SELECT proxy_key, source, is_pinned, remote_id, router_state FROM proxies WHERE proxy_key = ?",
          [m.proxy_key]
        );

        if (!proxy) {
          db.run(
            "DELETE FROM fleet_managed_endpoints WHERE node_id = ? AND endpoint_id = ? AND proxy_key = ? AND pending_cleanup = 1",
            [m.node_id, m.endpoint_id, m.proxy_key]
          );
          cleaned++;
          continue;
        }

        const isFleetExclusive = m.owned_exclusive === 1;
        const hasRemoteRef = Boolean(proxy.remote_id || proxy.router_state === "active");

        if (!isFleetExclusive) {
          db.run(
            "DELETE FROM fleet_managed_endpoints WHERE node_id = ? AND endpoint_id = ? AND proxy_key = ? AND pending_cleanup = 1",
            [m.node_id, m.endpoint_id, m.proxy_key]
          );
          cleaned++;
          continue;
        }
        if (hasRemoteRef) {
          if (options?.cleanupRemoteRef && proxy.remote_id) {
            try {
              await options.cleanupRemoteRef(proxy.remote_id, proxy.proxy_key);
              let deleteSucceeded = false;
              db.transaction(() => {
                const current = db.get<{ remote_id: string | null }>(
                  "SELECT remote_id FROM proxies WHERE proxy_key = ?",
                  [m.proxy_key]
                );
                const otherActive = db.get<{ count: number }>(
                  "SELECT COUNT(*) as count FROM fleet_managed_endpoints WHERE proxy_key = ? AND pending_cleanup = 0",
                  [m.proxy_key]
                );
                if (current?.remote_id !== proxy.remote_id || (otherActive?.count ?? 0) > 0) return;
                const res = db.run(
                  "DELETE FROM fleet_managed_endpoints WHERE node_id = ? AND endpoint_id = ? AND proxy_key = ? AND pending_cleanup = 1 AND owned_exclusive = 1",
                  [m.node_id, m.endpoint_id, m.proxy_key]
                );
                if (res.changes > 0) {
                  deleteSucceeded = true;
                  db.run(
                    "UPDATE proxies SET remote_id = NULL, router_state = 'unmanaged' WHERE proxy_key = ? AND remote_id = ?",
                    [m.proxy_key, proxy.remote_id]
                  );
                }
              });
              if (deleteSucceeded) {
                cleaned++;
                const otherRefs = db.get<{ count: number }>(
                  "SELECT COUNT(*) as count FROM fleet_managed_endpoints WHERE proxy_key = ?",
                  [m.proxy_key]
                );
                if (!otherRefs || otherRefs.count === 0) {
                  if (proxy.is_pinned === 0) {
                    db.run("DELETE FROM proxy_test_history WHERE proxy_key = ?", [m.proxy_key]);
                    db.run("DELETE FROM proxies WHERE proxy_key = ?", [m.proxy_key]);
                  }
                }
              } else {
                pendingRemaining++;
              }
            } catch {
              pendingRemaining++;
            }
          } else if (options?.force) {
            db.run(
              "DELETE FROM fleet_managed_endpoints WHERE node_id = ? AND endpoint_id = ? AND proxy_key = ? AND pending_cleanup = 1",
              [m.node_id, m.endpoint_id, m.proxy_key]
            );
            cleaned++;
          } else {
            pendingRemaining++;
          }
        } else {
          db.run(
            "DELETE FROM fleet_managed_endpoints WHERE node_id = ? AND endpoint_id = ? AND proxy_key = ? AND pending_cleanup = 1",
            [m.node_id, m.endpoint_id, m.proxy_key]
          );
          cleaned++;
          const otherRefs = db.get<{ count: number }>(
            "SELECT COUNT(*) as count FROM fleet_managed_endpoints WHERE proxy_key = ?",
            [m.proxy_key]
          );
          if (!otherRefs || otherRefs.count === 0) {
            if (proxy.is_pinned === 0) {
              db.run("DELETE FROM proxy_test_history WHERE proxy_key = ?", [m.proxy_key]);
              db.run("DELETE FROM proxies WHERE proxy_key = ?", [m.proxy_key]);
            }
          }
        }
      }

      return { cleaned, pendingRemaining };
    },
    async listManagedFleetAuditTargets(): Promise<Array<{
      nodeId: string;
      endpointId: string;
      proxyKey: string;
      proxyUrl: string;
      remoteId: string | null;
    }>> {
      const rows = db.all<{
        node_id: string;
        endpoint_id: string;
        proxy_key: string;
        endpoint: string;
        remote_id: string | null;
      }>(`
        SELECT
          f.node_id,
          f.endpoint_id,
          f.proxy_key,
          p.endpoint,
          p.remote_id
        FROM fleet_managed_endpoints f
        JOIN proxies p ON f.proxy_key = p.proxy_key
        WHERE f.pending_cleanup = 0
        ORDER BY f.node_id, f.endpoint_id
      `);
      return rows.map((r) => ({
        nodeId: r.node_id,
        endpointId: r.endpoint_id,
        proxyKey: r.proxy_key,
        proxyUrl: r.endpoint,
        remoteId: r.remote_id ? String(r.remote_id) : null,
      }));
    },
    async getManagedFleetNodeRemoteRefs(nodeId: string): Promise<Array<{
      endpointId: string;
      proxyKey: string;
      remoteId: string | null;
      isPinned: boolean;
    }>> {
      const rows = db.all<{
        endpoint_id: string;
        proxy_key: string;
        remote_id: string | null;
        is_pinned: number;
      }>(`
        SELECT
          f.endpoint_id,
          f.proxy_key,
          p.remote_id,
          p.is_pinned
        FROM fleet_managed_endpoints f
        JOIN proxies p ON f.proxy_key = p.proxy_key
        WHERE f.node_id = ?
        ORDER BY f.endpoint_id
      `, [nodeId]);
      return rows.map((r) => ({
        endpointId: r.endpoint_id,
        proxyKey: r.proxy_key,
        remoteId: r.remote_id ? String(r.remote_id) : null,
        isPinned: Boolean(r.is_pinned),
      }));
    },
  };

}