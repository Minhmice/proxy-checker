import type { ProxyIntelligenceDb, SqlParam } from "./proxy-intelligence-db.js";
import { parseProxyInput } from "../auditor/parser.js";
import type { ParsedProxyInput, ProxyAuditResult } from "../auditor/types.js";

export type ProxyLifecycleState = "working" | "unstable" | "dead" | "dangerous" | "unknown" | "invalid";

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

export interface ProxyIntelligenceRepository {
  importProxies(input: ProxyImportInput): Promise<ProxyImportSummary>;
  listProxies(filter?: ProxyInventoryFilter): Promise<ProxyInventoryPage>;
  getProxy(proxyKey: string): Promise<ProxyInventoryDetail | null>;
  resolveProxyKeys(filter: ProxyInventoryFilter): Promise<string[]>;
  exportWorkingProxies(filter?: WorkingExportFilter): Promise<ExportResult>;
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
  };

}