import crypto from "node:crypto";
import type { ProxyIntelligenceDb, SqlParam } from "./proxy-intelligence-db.js";
import { parseProxyInput } from "../auditor/parser.js";
import { serializeAuditDetail } from "../auditor/detail.js";
import type { ParsedProxyInput, ProxyAuditDetail, ProxyAuditResult } from "../auditor/types.js";

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
  search?: string;
  source?: string;
  protocol?: string;
  lifecycle?: ProxyLifecycleState | "all";
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
  key: string;
  name: string;
  protocol: "http" | "https" | "socks4" | "socks5";
  host: string;
  port: number;
  status: "working" | "dead" | "regressed";
  udp: "Yes" | "No" | "Unknown";
  sync: "active" | "reserve" | "unsynced";
  latencyMs: number | null;
  exitIp: string | null;
  geo?: { city?: string; country?: string };
  isp?: string;
  timezone?: string;
  lastCheckedAt: number | null;
}

export interface UnifiedProxyCounts {
  all: number;
  working: number;
  regressed: number;
  dead: number;
}

export interface UnifiedProxyFilter {
  status?: "all" | "working" | "regressed" | "dead" | string;
  search?: string;
  protocol?: string;
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
    tier?: string;
    status?: string;
    isActiveOnRouter?: boolean;
    latency_ms?: number | null;
    exit_ip?: string | null;
  }>): Promise<{ imported: number; proxyKeys: string[] }>;
  getUnifiedProxies(filter?: UnifiedProxyFilter): Promise<{
    total: number;
    counts: UnifiedProxyCounts;
    items: UnifiedProxyItem[];
  }>;
  persistAuditSnapshot(input: PersistAuditSnapshotInput): Promise<void>;
  previewImport(input: ProxyImportInput): Promise<ProxyImportPreview>;
  getAuditDetail(proxyKey: string, auditId?: string): Promise<ProxyAuditDetail | null>;
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
        whereClauses.push("latest_a.verdict = ?");
        params.push(filter.verdict);
      }

      const whereSql = whereClauses.join(" AND ");

      const countRow = db.get<{ total: number }>(
        `SELECT COUNT(*) AS total
         FROM proxies p
         LEFT JOIN proxy_audits latest_a ON latest_a.rowid = (
           SELECT a2.rowid FROM proxy_audits a2
           WHERE a2.proxy_key = p.proxy_key
           ORDER BY a2.finished_at DESC
           LIMIT 1
         )
         WHERE ${whereSql}`,
        params
      );

      const total = countRow?.total ?? 0;

      const rows = db.all<Record<string, unknown>>(
        `SELECT
           p.proxy_key,
           p.endpoint,
           p.protocol,
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
           latest_a.verdict AS latest_verdict,
           latest_a.overall_score AS latest_score,
           latest_a.finished_at AS latest_audit_at
         FROM proxies p
         LEFT JOIN proxy_audits latest_a ON latest_a.rowid = (
           SELECT a2.rowid FROM proxy_audits a2
           WHERE a2.proxy_key = p.proxy_key
           ORDER BY a2.finished_at DESC
           LIMIT 1
         )
         WHERE ${whereSql}
         ORDER BY COALESCE(p.updated_at, p.created_at, 0) DESC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      );

      const items: ProxyInventoryItem[] = rows.map((r) => {
        const endpoint = String(r.endpoint ?? "");
        const parts = endpoint.split(":");
        const host = parts[0] ?? "";
        const port = Number(parts[1] ?? 0);

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
           p.updated_at
         FROM proxies p
         WHERE p.proxy_key = ?`,
        [proxyKey]
      );

      if (!row) return null;

      const endpoint = String(row.endpoint ?? "");
      const parts = endpoint.split(":");
      const host = parts[0] ?? "";
      const port = Number(parts[1] ?? 0);

      // Latest audit with full result JSON
      const latestAuditRow = db.get<{ result_json: string }>(
        `SELECT result_json FROM proxy_audits WHERE proxy_key = ? ORDER BY finished_at DESC LIMIT 1`,
        [proxyKey]
      );

      let latestAudit: ProxyAuditResult | null = null;
      if (latestAuditRow?.result_json) {
        try {
          latestAudit = JSON.parse(latestAuditRow.result_json) as ProxyAuditResult;
        } catch {
          // ignore corrupted json
        }
      }

      // Recent audit snapshots (summary only)
      const auditRows = db.all<Record<string, unknown>>(
        `SELECT id, verdict, lifecycle_state, overall_score, finished_at
         FROM proxy_audits
         WHERE proxy_key = ?
         ORDER BY finished_at DESC
         LIMIT 10`,
        [proxyKey]
      );

      const auditHistory = auditRows.map((a) => ({
        id: String(a.id),
        verdict: String(a.verdict),
        lifecycleState: (a.lifecycle_state as ProxyLifecycleState) ?? "unknown",
        overallScore: a.overall_score !== null ? Number(a.overall_score) : null,
        finishedAt: a.finished_at ? Number(a.finished_at) : null,
      }));

      // Recent diagnostics
      const diagRows = db.all<Record<string, unknown>>(
        `SELECT id, status, latency_ms, checked_at, error_message
         FROM proxy_diagnostics
         WHERE proxy_key = ?
         ORDER BY checked_at DESC
         LIMIT 10`,
        [proxyKey]
      );

      const diagnosticHistory = diagRows.map((d) => ({
        id: String(d.id),
        status: String(d.status),
        latencyMs: d.latency_ms !== null ? Number(d.latency_ms) : null,
        checkedAt: Number(d.checked_at),
        errorMessage: d.error_message ? String(d.error_message) : null,
      }));

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
        latestAudit,
        auditHistory,
        diagnosticHistory,
      };
    },

    async resolveProxyKeys(filter: ProxyInventoryFilter): Promise<string[]> {
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

      const rows = db.all<{ proxy_key: string }>(
        `SELECT p.proxy_key FROM proxies p WHERE ${whereClauses.join(" AND ")}`,
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
           p.username,
           p.password
         FROM proxies p
         JOIN proxy_audits a ON a.rowid = (
           SELECT a2.rowid FROM proxy_audits a2
           WHERE a2.proxy_key = p.proxy_key
           ORDER BY a2.finished_at DESC
           LIMIT 1
         )
         WHERE a.verdict = 'PASS'
           AND COALESCE(a.reliability_score, 0) >= ?
           AND a.finished_at >= ?
           AND NOT EXISTS (
             SELECT 1 FROM proxy_audit_risks r
             WHERE r.audit_id = a.id AND r.severity = 'critical'
           )
         ORDER BY a.reliability_score DESC`,
        [minRel, minTime]
      );

      const dateStr = new Date().toISOString().slice(0, 10);
      if (format === "csv") {
        const header = "protocol,host,port,username,password\n";
        const lines = rows.map((r) => {
          const parts = String(r.endpoint ?? "").split(":");
          const host = parts[0] ?? "";
          const port = parts[1] ?? "";
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

          const existing = db.get<{ proxy_key: string }>("SELECT proxy_key FROM proxies WHERE proxy_key = ?", [key]);
          if (existing) {
            db.run(
              `UPDATE proxies SET
                source = '9router-working',
                lifecycle_state = 'working',
                status = 'usable',
                latency_ms = COALESCE(?, latency_ms),
                exit_ip = COALESCE(?, exit_ip),
                password = COALESCE(?, password),
                updated_at = ?
              WHERE proxy_key = ?`,
              [item.latency_ms ?? null, item.exit_ip ?? null, p.password ?? null, now, key]
            );
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
                "usable",
                item.exit_ip ?? null,
                item.latency_ms ?? null,
                now,
                1,
                0,
                null,
                "9router-working",
                "working",
                p.username ?? null,
                p.password ?? null,
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
    async getUnifiedProxies(filter: UnifiedProxyFilter = {}): Promise<{
      total: number;
      counts: UnifiedProxyCounts;
      items: UnifiedProxyItem[];
    }> {
      const page = Math.max(1, filter.page ?? 1);
      const pageSize = Math.max(1, Math.min(100, filter.pageSize ?? 50));
      const offset = (page - 1) * pageSize;

      const baseWhere: string[] = ["1 = 1"];
      const baseParams: SqlParam[] = [];

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
           SUM(CASE WHEN (p.status = 'usable' OR COALESCE(latest_a.verdict, '') = 'PASS') THEN 1 ELSE 0 END) AS total_working,
           SUM(CASE WHEN NOT (p.status = 'usable' OR COALESCE(latest_a.verdict, '') = 'PASS') AND (COALESCE(p.successes, 0) > 0 OR COALESCE(audit_pass.has_pass, 0) = 1) THEN 1 ELSE 0 END) AS total_regressed,
           SUM(CASE WHEN NOT (p.status = 'usable' OR COALESCE(latest_a.verdict, '') = 'PASS') AND NOT (COALESCE(p.successes, 0) > 0 OR COALESCE(audit_pass.has_pass, 0) = 1) THEN 1 ELSE 0 END) AS total_dead
         FROM proxies p
         LEFT JOIN proxy_audits latest_a ON latest_a.rowid = (
           SELECT a2.rowid FROM proxy_audits a2
           WHERE a2.proxy_key = p.proxy_key
           ORDER BY a2.finished_at DESC
           LIMIT 1
         )
         LEFT JOIN (
           SELECT proxy_key, 1 AS has_pass FROM proxy_audits WHERE verdict = 'PASS' GROUP BY proxy_key
         ) audit_pass ON audit_pass.proxy_key = p.proxy_key
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

      if (filter.status === "working") {
        statusWhere.push("(p.status = 'usable' OR COALESCE(latest_a.verdict, '') = 'PASS')");
      } else if (filter.status === "regressed") {
        statusWhere.push("NOT (p.status = 'usable' OR COALESCE(latest_a.verdict, '') = 'PASS') AND (COALESCE(p.successes, 0) > 0 OR COALESCE(audit_pass.has_pass, 0) = 1)");
      } else if (filter.status === "dead") {
        statusWhere.push("NOT (p.status = 'usable' OR COALESCE(latest_a.verdict, '') = 'PASS') AND NOT (COALESCE(p.successes, 0) > 0 OR COALESCE(audit_pass.has_pass, 0) = 1)");
      }

      const statusWhereSql = statusWhere.join(" AND ");

      const countFilteredRow = db.get<{ total: number }>(
        `SELECT COUNT(*) AS total
         FROM proxies p
         LEFT JOIN proxy_audits latest_a ON latest_a.rowid = (
           SELECT a2.rowid FROM proxy_audits a2
           WHERE a2.proxy_key = p.proxy_key
           ORDER BY a2.finished_at DESC
           LIMIT 1
         )
         LEFT JOIN (
           SELECT proxy_key, 1 AS has_pass FROM proxy_audits WHERE verdict = 'PASS' GROUP BY proxy_key
         ) audit_pass ON audit_pass.proxy_key = p.proxy_key
         WHERE ${statusWhereSql}`,
        statusParams
      );

      const total = Number(countFilteredRow?.total ?? 0);

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
           latest_a.verdict AS latest_verdict,
           latest_a.result_json,
           audit_pass.has_pass,
           CASE
             WHEN (p.status = 'usable' OR COALESCE(latest_a.verdict, '') = 'PASS') THEN 'working'
             WHEN (COALESCE(p.successes, 0) > 0 OR COALESCE(audit_pass.has_pass, 0) = 1) THEN 'regressed'
             ELSE 'dead'
           END AS computed_status
         FROM proxies p
         LEFT JOIN proxy_audits latest_a ON latest_a.rowid = (
           SELECT a2.rowid FROM proxy_audits a2
           WHERE a2.proxy_key = p.proxy_key
           ORDER BY a2.finished_at DESC
           LIMIT 1
         )
         LEFT JOIN (
           SELECT proxy_key, 1 AS has_pass FROM proxy_audits WHERE verdict = 'PASS' GROUP BY proxy_key
         ) audit_pass ON audit_pass.proxy_key = p.proxy_key
         WHERE ${statusWhereSql}
         ORDER BY
           CASE WHEN (p.status = 'usable' OR COALESCE(latest_a.verdict, '') = 'PASS') THEN 0 WHEN (COALESCE(p.successes, 0) > 0 OR COALESCE(audit_pass.has_pass, 0) = 1) THEN 1 ELSE 2 END ASC,
           p.latency_ms ASC NULLS LAST,
           p.checked_at DESC NULLS LAST
         LIMIT ? OFFSET ?`,
        [...statusParams, pageSize, offset]
      );

      const items: UnifiedProxyItem[] = rows.map((r) => {
        let geo: { city?: string; country?: string } | undefined;
        let isp: string | undefined;
        let timezone: string | undefined;
        let udpVal: "Yes" | "No" | "Unknown" = String(r.protocol).toLowerCase() === "socks5" ? "Yes" : "No";

        if (typeof r.result_json === "string") {
          try {
            const parsed = JSON.parse(r.result_json);
            const exitIpObj = parsed.exitIp || parsed.evidence?.exitIp;
            if (exitIpObj) {
              geo = exitIpObj.geo;
              isp = exitIpObj.isp;
              timezone = exitIpObj.timezone;
            }
            const netObj = parsed.network || parsed.evidence?.network;
            if (netObj?.udp !== undefined) {
              udpVal = netObj.udp ? "Yes" : "No";
            }
          } catch {}
        }

        const endpoint = String(r.endpoint ?? "");
        let syncStatus: "active" | "reserve" | "unsynced" = "unsynced";
        if (filter.activePoolEndpoints?.has(endpoint)) {
          syncStatus = "active";
        } else if (filter.reservePoolEndpoints?.has(endpoint)) {
          syncStatus = "reserve";
        }

        return {
          key: String(r.proxy_key),
          name: endpoint,
          protocol: String(r.protocol).toLowerCase() as any,
          host: String(r.host || endpoint.split(":")[0]),
          port: Number(r.port || endpoint.split(":")[1] || 0),
          status: r.computed_status as "working" | "dead" | "regressed",
          udp: udpVal,
          sync: syncStatus,
          latencyMs: r.latency_ms !== null && r.latency_ms !== undefined ? Number(r.latency_ms) : null,
          exitIp: r.exit_ip ? String(r.exit_ip) : null,
          geo,
          isp,
          timezone,
          lastCheckedAt: r.checked_at ? Number(r.checked_at) : null,
        };
      });

      return {
        total,
        counts,
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
      const lifecycle = verdict === "FAIL" ? "dead" : "working";

      db.transaction(() => {
        // 1. Insert audit record
        db.run(
          `INSERT INTO proxy_audits (
            id, proxy_key, verdict, lifecycle_state, overall_score,
            transport_score, privacy_score, reputation_score, reliability_score,
            started_at, finished_at, result_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            auditId,
            input.proxyKey,
            verdict,
            lifecycle,
            input.result.scores?.overallSafety ?? null,
            input.result.scores?.transportSecurity ?? null,
            input.result.scores?.privacy ?? null,
            input.result.scores?.reputation ?? null,
            input.result.scores?.reliability ?? null,
            startedTime,
            finishedTime,
            JSON.stringify(input.result),
          ]
        );

        // 2. Insert typed risks
        if (Array.isArray(input.result.riskFactors)) {
          for (const r of input.result.riskFactors) {
            db.run(
              `INSERT INTO proxy_audit_risks (
                id, audit_id, risk_code, severity, title, explanation
              ) VALUES (?, ?, ?, ?, ?, ?)`,
              [
                crypto.randomUUID(),
                auditId,
                r.code ?? r.id,
                r.severity,
                r.title ?? r.id,
                r.description ?? r.message ?? "",
              ]
            );
          }
        }

        // 3. Update proxy snapshot
        db.run(
          `UPDATE proxies SET
            last_verdict = ?,
            last_checked_at = ?,
            last_latency_ms = COALESCE(?, last_latency_ms),
            last_exit_ip = COALESCE(?, last_exit_ip),
            last_failure_code = ?,
            ever_passed = CASE WHEN ? = 'PASS' THEN 1 ELSE ever_passed END,
            status = CASE WHEN ? = 'FAIL' THEN 'dead' ELSE 'usable' END,
            lifecycle_state = ?,
            latency_ms = COALESCE(?, latency_ms),
            exit_ip = COALESCE(?, exit_ip),
            checked_at = ?,
            updated_at = ?
          WHERE proxy_key = ?`,
          [
            verdict,
            finishedTime,
            latency,
            exitIp,
            failureCode,
            verdict,
            verdict,
            lifecycle,
            latency,
            exitIp,
            finishedTime,
            finishedTime,
            input.proxyKey,
          ]
        );

        // 4. Update audit job counters if jobId is provided
        if (input.jobId) {
          db.run(
            `UPDATE audit_jobs SET
              completed = completed + 1,
              passed = passed + CASE WHEN ? = 'PASS' THEN 1 ELSE 0 END,
              warned = warned + CASE WHEN ? = 'WARN' THEN 1 ELSE 0 END,
              failed = failed + CASE WHEN ? = 'FAIL' THEN 1 ELSE 0 END
            WHERE id = ?`,
            [verdict, verdict, verdict, input.jobId]
          );
        }
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
    async getAuditDetail(proxyKey: string, auditId?: string): Promise<ProxyAuditDetail | null> {
      let row: { id: string; proxy_key: string; verdict: string; finished_at: number; result_json: string } | undefined;
      if (auditId) {
        row = db.get<{ id: string; proxy_key: string; verdict: string; finished_at: number; result_json: string }>(
          "SELECT id, proxy_key, verdict, finished_at, result_json FROM proxy_audits WHERE id = ? AND proxy_key = ?",
          [auditId, proxyKey]
        );
      } else {
        row = db.get<{ id: string; proxy_key: string; verdict: string; finished_at: number; result_json: string }>(
          "SELECT id, proxy_key, verdict, finished_at, result_json FROM proxy_audits WHERE proxy_key = ? ORDER BY finished_at DESC LIMIT 1",
          [proxyKey]
        );
      }
      if (!row || !row.result_json) return null;
      try {
        const parsed = JSON.parse(row.result_json);
        return serializeAuditDetail(parsed, proxyKey, row.id);
      } catch {
        return null;
      }
    },
  };

}