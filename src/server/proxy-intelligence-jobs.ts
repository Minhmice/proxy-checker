import crypto from "node:crypto";
import type { ProxyIntelligenceDb } from "./proxy-intelligence-db.js";
import type {
  ProxyIntelligenceRepository,
  ProxyInventoryFilter,
  ProxyLifecycleState,
} from "./proxy-intelligence-repository.js";
import { checkProxy } from "../auditor/index.js";
import { sanitizeResult } from "../auditor/cli/formatters.js";
import type { ProxyAuditResult, ProxyInput, ProxyProtocol } from "../auditor/types.js";
import type { AuditorJobOptions } from "../lib/types.js";

export type IntelligenceJobStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "done"
  | "failed"
  | "error"
  | "interrupted";

export interface CreateIntelligenceJobPayload {
  proxyKeys?: string[];
  filter?: ProxyInventoryFilter;
  options?: Partial<AuditorJobOptions>;
}

export interface IntelligenceJob {
  id: string;
  status: IntelligenceJobStatus;
  total: number;
  checked: number;
  passCount: number;
  warnCount: number;
  failCount: number;
  unknownCount: number;
  startedAt: number | null;
  finishedAt: number | null;
  error?: string;
}

export interface ProxyIntelligenceJobManagerDeps {
  db: ProxyIntelligenceDb;
  repo: ProxyIntelligenceRepository;
  auditFn?: (proxy: ProxyInput, options?: Record<string, unknown>) => Promise<ProxyAuditResult>;
  now?: () => number;
}

export interface ProxyIntelligenceJobManager {
  createJob(payload: CreateIntelligenceJobPayload): Promise<IntelligenceJob>;
  getJob(id: string): IntelligenceJob | null;
  cancelJob(id: string): Promise<IntelligenceJob | null>;
  listJobs(): IntelligenceJob[];
}

export function createProxyIntelligenceJobManager(
  deps: ProxyIntelligenceJobManagerDeps
): ProxyIntelligenceJobManager {
  const db = deps.db;
  const repo = deps.repo;
  const auditFn = deps.auditFn ?? checkProxy;
  const now = deps.now ?? (() => Date.now());

  const jobs = new Map<string, { job: IntelligenceJob; controller: AbortController }>();

  // Mark any orphaned jobs from prior server runs as interrupted
  try {
    db.run(
      "UPDATE audit_jobs SET state = 'interrupted', finished_at = ? WHERE state IN ('queued', 'running', 'cancelling')",
      [now()]
    );
  } catch {}

  async function runJob(
    jobId: string,
    keys: string[],
    options: Partial<AuditorJobOptions>,
    controller: AbortController
  ) {
    const jobWrapper = jobs.get(jobId);
    if (!jobWrapper) return;
    const { job } = jobWrapper;

    job.status = "running";
    job.startedAt = now();
    db.run("UPDATE audit_jobs SET state = 'running', started_at = ? WHERE id = ?", [job.startedAt, jobId]);

    const concurrency = Math.max(1, Math.min(20, options.concurrency ?? 5));
    let cursor = 0;

    async function worker() {
      while (!controller.signal.aborted && cursor < keys.length) {
        const key = keys[cursor++];
        if (!key) break;

        const proxyRow = db.get<{
          proxy_key: string;
          protocol: string;
          endpoint: string;
          username?: string;
          password?: string;
        }>("SELECT proxy_key, protocol, endpoint, username, password FROM proxies WHERE proxy_key = ?", [key]);

        if (!proxyRow) {
          job.checked++;
          continue;
        }

        const parts = proxyRow.endpoint.split(":");
        const host = parts[0] ?? "";
        const port = Number(parts[1] ?? 80);

        try {
          const auditResult = await auditFn(
            {
              protocol: proxyRow.protocol as ProxyProtocol,
              host,
              port,
              username: proxyRow.username,
              password: proxyRow.password,
            },
            {
              attempts: options.attempts ?? 1,
              timeoutMs: options.timeoutMs ?? 15000,
              reputation: options.reputation ?? true,
              browser: options.browser ?? false,
              signal: controller.signal,
            }
          );

          const sanitized = sanitizeResult(auditResult) as ProxyAuditResult;
          const verdict = sanitized.verdict;
          const auditId = crypto.randomUUID();
          const finishedTime = now();

          await repo.persistAuditSnapshot({
            proxyKey: key,
            result: sanitized,
            auditId,
            jobId,
            startedAt: job.startedAt ?? finishedTime,
            finishedAt: finishedTime,
          });

          if (verdict === "PASS") job.passCount++;
          else if (verdict === "WARN") job.warnCount++;
          else if (verdict === "FAIL") job.failCount++;
          else job.unknownCount++;
        } catch {
          job.failCount++;
        }

        job.checked++;
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, keys.length) }, () => worker());
    await Promise.all(workers);

    if (controller.signal.aborted) {
      job.status = "cancelled";
    } else {
      job.status = "done";
    }
    job.finishedAt = now();

    const dbFinalState = controller.signal.aborted ? "cancelled" : "completed";
    db.run(
      "UPDATE audit_jobs SET state = ?, finished_at = ?, completed = ?, passed = ?, warned = ?, failed = ? WHERE id = ?",
      [dbFinalState, job.finishedAt, job.checked, job.passCount, job.warnCount, job.failCount, jobId]
    );
  }

  return {
    async createJob(payload: CreateIntelligenceJobPayload): Promise<IntelligenceJob> {
      let keys: string[] = [];

      if (Array.isArray(payload.proxyKeys) && payload.proxyKeys.length > 0) {
        keys = payload.proxyKeys;
      } else if (payload.filter) {
        keys = await repo.resolveProxyKeys(payload.filter);
      }

      if (keys.length === 0) {
        throw new Error("No proxies match the requested filter or selection");
      }

      const id = crypto.randomUUID();
      const controller = new AbortController();
      const currentTime = now();

      const job: IntelligenceJob = {
        id,
        status: "queued",
        total: keys.length,
        checked: 0,
        passCount: 0,
        warnCount: 0,
        failCount: 0,
        unknownCount: 0,
        startedAt: null,
        finishedAt: null,
      };

      jobs.set(id, { job, controller });

      db.run(
        `INSERT INTO audit_jobs (id, state, created_at, started_at, finished_at, total, completed, passed, warned, failed, cancelled, options_json)
         VALUES (?, 'queued', ?, null, null, ?, 0, 0, 0, 0, 0, ?)`,
        [id, currentTime, keys.length, JSON.stringify(payload.options ?? {})]
      );

      setImmediate(() => {
        void runJob(id, keys, payload.options ?? {}, controller);
      });

      return { ...job };
    },

    getJob(id: string): IntelligenceJob | null {
      const entry = jobs.get(id);
      if (entry) return { ...entry.job };

      const row = db.get<{
        id: string;
        state: string;
        total: number;
        completed: number;
        passed: number;
        warned: number;
        failed: number;
        cancelled: number;
        created_at: number;
        started_at: number | null;
        finished_at: number | null;
      }>("SELECT * FROM audit_jobs WHERE id = ?", [id]);

      if (!row) return null;

      let status: IntelligenceJobStatus;
      if (row.state === "completed") status = "done";
      else status = row.state as IntelligenceJobStatus;

      return {
        id: row.id,
        status,
        total: Number(row.total || 0),
        checked: Number(row.completed || 0),
        passCount: Number(row.passed || 0),
        warnCount: Number(row.warned || 0),
        failCount: Number(row.failed || 0),
        unknownCount: 0,
        startedAt: row.started_at ? Number(row.started_at) : null,
        finishedAt: row.finished_at ? Number(row.finished_at) : null,
      };
    },

    async cancelJob(id: string): Promise<IntelligenceJob | null> {
      const entry = jobs.get(id);
      if (entry) {
        entry.controller.abort();
        entry.job.status = "cancelling";
        db.run("UPDATE audit_jobs SET state = 'cancelling' WHERE id = ?", [id]);
        return { ...entry.job };
      }
      db.run(
        "UPDATE audit_jobs SET state = 'cancelled', finished_at = ? WHERE id = ? AND state IN ('queued', 'running', 'cancelling')",
        [now(), id]
      );
      return this.getJob(id);
    },

    listJobs(): IntelligenceJob[] {
      const dbRows = db.all<{
        id: string;
        state: string;
        total: number;
        completed: number;
        passed: number;
        warned: number;
        failed: number;
        cancelled: number;
        created_at: number;
        started_at: number | null;
        finished_at: number | null;
      }>("SELECT * FROM audit_jobs ORDER BY created_at DESC LIMIT 50");

      return dbRows.map((row) => {
        const active = jobs.get(row.id);
        if (active) return { ...active.job };

        let status: IntelligenceJobStatus;
        if (row.state === "completed") status = "done";
        else status = row.state as IntelligenceJobStatus;

        return {
          id: row.id,
          status,
          total: Number(row.total || 0),
          checked: Number(row.completed || 0),
          passCount: Number(row.passed || 0),
          warnCount: Number(row.warned || 0),
          failCount: Number(row.failed || 0),
          unknownCount: 0,
          startedAt: row.started_at ? Number(row.started_at) : null,
          finishedAt: row.finished_at ? Number(row.finished_at) : null,
        };
      });
    },
  };
}
