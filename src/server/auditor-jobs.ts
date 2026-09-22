import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { checkProxy } from "../auditor/index.js";
import { parseProxyInput } from "../auditor/parser.js";
import { formatCsvRecords, sanitizeResult } from "../auditor/cli/formatters.js";
import type { BulkRecord } from "../auditor/cli/bulk.js";
import type {
  AuditorJob,
  AuditorJobMode,
  AuditorJobOptions,
  AuditorJobResult,
  AuditorJobStatus,
  ProxyAuditResult,
  ProxyInput,
} from "../lib/types.js";

export class AuditorJobError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "AuditorJobError";
    this.status = status;
  }
}

export interface AuditorJobManagerDeps {
  dataDir: string;
  auditProxy?: (proxy: ProxyInput, options?: Record<string, unknown>) => Promise<ProxyAuditResult>;
  now?: () => number;
  idFactory?: () => string;
}

interface QueuedItem {
  index: number;
  proxyRaw: string;
  proxySafe: string;
  parsedProxy?: ProxyInput;
  parseError?: string;
}

interface ActiveJobRuntime {
  job: AuditorJob;
  controller: AbortController;
  fullResults: AuditorJobResult[];
  activeWorkerPromise?: Promise<void>;
}

export interface AuditorExportResult {
  contentType: string;
  filename: string;
  body: Buffer;
}

export interface AuditorJobManager {
  createSingle(input: { proxy: string; options: AuditorJobOptions }): Promise<AuditorJob>;
  createBulk(input: { name: string; content: string; options: AuditorJobOptions }): Promise<AuditorJob>;
  getJob(id: string): AuditorJob | null;
  listHistory(limit?: number): AuditorJob[];
  cancelJob(id: string): Promise<AuditorJob>;
  deleteHistory(id: string): Promise<boolean>;
  exportJob(id: string, format: "json" | "csv"): Promise<AuditorExportResult>;
  isKnownJob(id: string): boolean;
}

const MAX_BULK_BYTES = 5_000_000; // 5 MB
const MAX_BULK_LINES = 10_000;
const MAX_HISTORY_JOBS = 50;
const MAX_PERSISTED_RESULTS_PER_JOB = 500;

function validateOptions(options: AuditorJobOptions): AuditorJobOptions {
  const attempts = Number(options.attempts);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new AuditorJobError("Options: attempts must be an integer between 1 and 10", 400);
  }
  const timeoutMs = Number(options.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 2_000 || timeoutMs > 60_000) {
    throw new AuditorJobError("Options: timeoutMs must be an integer between 2,000 and 60,000", 400);
  }
  const concurrency = Number(options.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) {
    throw new AuditorJobError("Options: concurrency must be an integer between 1 and 20", 400);
  }
  return {
    attempts,
    timeoutMs,
    concurrency,
    reputation: options.reputation !== false,
    browser: options.browser === true,
  };
}

export function createAuditorJobManager(deps: AuditorJobManagerDeps): AuditorJobManager {
  const dataDir = deps.dataDir;
  const historyFile = path.join(dataDir, "auditor-history.json");
  const exportsDir = path.join(dataDir, "auditor-exports");
  const auditFn = deps.auditProxy ?? checkProxy;
  const now = deps.now ?? (() => Date.now());
  const generateId = deps.idFactory ?? (() => crypto.randomUUID());

  let history: AuditorJob[] = [];
  const activeJobs = new Map<string, ActiveJobRuntime>();

  function loadHistory(): void {
    if (!fs.existsSync(historyFile)) {
      history = [];
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(historyFile, "utf8")) as AuditorJob[];
      if (Array.isArray(raw)) {
        history = raw.map((j) => {
          // Reconcile interrupted jobs on server restart
          if (j.status === "queued" || j.status === "running" || j.status === "cancelling") {
            return {
              ...j,
              status: "error" as AuditorJobStatus,
              finishedAt: j.finishedAt || now(),
              error: "Interrupted by server restart",
            };
          }
          return j;
        });
      } else {
        history = [];
      }
    } catch {
      history = [];
    }
  }

  function saveHistory(): void {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const temp = `${historyFile}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
      fs.writeFileSync(temp, JSON.stringify(history.slice(0, MAX_HISTORY_JOBS), null, 2), "utf8");
      fs.renameSync(temp, historyFile);
    } catch (err) {
      console.error("[AuditorJobManager] Failed to persist history:", err);
    }
  }

  // Load and reconcile on startup
  loadHistory();
  saveHistory();

  function getSnapshot(job: AuditorJob): AuditorJob {
    return JSON.parse(JSON.stringify(job)) as AuditorJob;
  }

  function saveExportFiles(jobId: string, fullResults: AuditorJobResult[]): void {
    try {
      fs.mkdirSync(exportsDir, { recursive: true });
      const jsonPath = path.join(exportsDir, `${jobId}.json`);
      const csvPath = path.join(exportsDir, `${jobId}.csv`);

      // 1. JSON export
      const jsonRecords = fullResults.map((r) => {
        if (r.result) {
          return {
            line: r.index,
            status: "ok",
            result: sanitizeResult(r.result),
          };
        }
        return {
          line: r.index,
          status: "error",
          error: r.error || "Execution failed",
        };
      });
      fs.writeFileSync(jsonPath, JSON.stringify(jsonRecords, null, 2), "utf8");

      // 2. CSV export
      const bulkRecords = fullResults.map((r) => {
        if (r.result) {
          return {
            line: r.index,
            status: "ok" as const,
            result: r.result,
          };
        }
        return {
          line: r.index,
          status: "error" as const,
          error: r.error || "Execution failed",
        };
      });
      fs.writeFileSync(csvPath, formatCsvRecords(bulkRecords), "utf8");
    } catch (err) {
      console.error(`[AuditorJobManager] Failed to write export files for job ${jobId}:`, err);
    }
  }

  function updateJobCounters(job: AuditorJob, itemResult: AuditorJobResult): void {
    job.checked += 1;
    if (itemResult.error || !itemResult.result) {
      job.failCount += 1;
      return;
    }
    const verdict = itemResult.result.verdict;
    if (verdict === "PASS") job.passCount += 1;
    else if (verdict === "WARN") job.warnCount += 1;
    else if (verdict === "FAIL") job.failCount += 1;
    else job.unknownCount += 1;
  }

  async function runJobQueue(runtime: ActiveJobRuntime, items: QueuedItem[]): Promise<void> {
    const { job, controller, fullResults } = runtime;
    job.startedAt = now();
    job.status = "running";

    let cursor = 0;
    let lastSavedAt = now();
    const concurrency = job.browserAudit ? Math.min(2, job.concurrency) : job.concurrency;
    const workerCount = Math.max(1, Math.min(concurrency, items.length || 1));

    async function worker(): Promise<void> {
      while (!controller.signal.aborted && cursor < items.length) {
        const item = items[cursor++];
        if (!item) break;

        const jobResult: AuditorJobResult = { index: item.index };

        if (item.parseError || !item.parsedProxy) {
          jobResult.error = item.parseError || "Invalid proxy input";
        } else {
          try {
            const auditResult = await auditFn(item.parsedProxy, {
              attempts: job.attempts,
              timeoutMs: job.timeoutMs,
              reputation: job.mode === "single" || !job.error ? true : false,
              browser: job.browserAudit,
              signal: controller.signal,
            });
            jobResult.result = sanitizeResult(auditResult) as ProxyAuditResult;
          } catch (err) {
            jobResult.error = (err as Error).message || "Audit execution failed";
          }
        }

        fullResults.push(jobResult);
        updateJobCounters(job, jobResult);

        // Keep in-memory view up to 500 items while running
        job.results = fullResults.slice(-MAX_PERSISTED_RESULTS_PER_JOB);
        if (fullResults.length > MAX_PERSISTED_RESULTS_PER_JOB) {
          job.resultsCapped = true;
        }

        const currentTime = now();
        if (currentTime - lastSavedAt >= 500) {
          lastSavedAt = currentTime;
          saveHistory();
        }
      }
    }

    try {
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
    } catch (err) {
      if (!job.error) {
        job.error = (err as Error).message || "Queue error";
      }
    } finally {
      job.finishedAt = now();
      if (controller.signal.aborted) {
        job.status = "cancelled";
      } else if (job.error) {
        job.status = "error";
      } else {
        job.status = "done";
      }

      // Generate export artifacts before capping in-memory results
      saveExportFiles(job.id, fullResults);

      // Cap results for storage
      job.results = fullResults.slice(-MAX_PERSISTED_RESULTS_PER_JOB);
      if (fullResults.length > MAX_PERSISTED_RESULTS_PER_JOB) {
        job.resultsCapped = true;
      }

      saveHistory();
      activeJobs.delete(job.id);
    }
  }

  async function createSingle(input: { proxy: string; options: AuditorJobOptions }): Promise<AuditorJob> {
    if (!input.proxy || typeof input.proxy !== "string" || !input.proxy.trim()) {
      throw new AuditorJobError("Proxy target cannot be empty", 400);
    }
    const validatedOpts = validateOptions(input.options);
    const id = generateId();

    let parsedProxy: ProxyInput | undefined;
    let safeTarget = "unknown";
    let parseError: string | undefined;

    try {
      const parsed = parseProxyInput(input.proxy.trim());
      parsedProxy = parsed.parsed;
      safeTarget = `${parsed.redacted.protocol}://${parsed.redacted.host}:${parsed.redacted.port}`;
    } catch (err) {
      parseError = (err as Error).message || "Malformed proxy URL";
    }

    const job: AuditorJob = {
      id,
      mode: "single",
      status: "queued",
      sourceName: "Single proxy",
      createdAt: now(),
      startedAt: null,
      finishedAt: null,
      total: 1,
      checked: 0,
      passCount: 0,
      warnCount: 0,
      failCount: 0,
      unknownCount: 0,
      duplicateCount: 0,
      browserAudit: validatedOpts.browser,
      attempts: validatedOpts.attempts,
      timeoutMs: validatedOpts.timeoutMs,
      concurrency: 1,
      results: [],
      resultsCapped: false,
      persistenceWarning: "",
      error: "",
    };

    const runtime: ActiveJobRuntime = {
      job,
      controller: new AbortController(),
      fullResults: [],
    };

    activeJobs.set(id, runtime);
    history.unshift(job);
    if (history.length > MAX_HISTORY_JOBS) {
      history = history.slice(0, MAX_HISTORY_JOBS);
    }
    saveHistory();

    const item: QueuedItem = {
      index: 1,
      proxyRaw: input.proxy.trim(),
      proxySafe: safeTarget,
      parsedProxy,
      parseError,
    };

    // Run in background without awaiting completion
    runtime.activeWorkerPromise = runJobQueue(runtime, [item]);

    return getSnapshot(job);
  }

  async function createBulk(input: { name: string; content: string; options: AuditorJobOptions }): Promise<AuditorJob> {
    const rawName = String(input.name || "").trim();
    if (!rawName.toLowerCase().endsWith(".txt")) {
      throw new AuditorJobError("Uploaded file must have .txt extension", 400);
    }
    if (!input.content || typeof input.content !== "string" || !input.content.trim()) {
      throw new AuditorJobError("File content cannot be empty", 400);
    }
    if (Buffer.byteLength(input.content, "utf8") > MAX_BULK_BYTES) {
      throw new AuditorJobError("File size exceeds 5 MB limit", 413);
    }

    const validatedOpts = validateOptions(input.options);
    const rawLines = input.content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (rawLines.length === 0) {
      throw new AuditorJobError("No proxy endpoints found in file", 400);
    }
    if (rawLines.length > MAX_BULK_LINES) {
      throw new AuditorJobError(`Bulk list exceeds limit of ${MAX_BULK_LINES} entries`, 400);
    }

    const seenEndpoints = new Set<string>();
    const items: QueuedItem[] = [];
    let duplicates = 0;

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i]!;
      let parsedProxy: ProxyInput | undefined;
      let safeTarget = `Line ${i + 1}`;
      let parseError: string | undefined;

      try {
        const parsed = parseProxyInput(line);
        parsedProxy = parsed.parsed;
        const endpointKey = `${parsed.parsed.protocol}://${parsed.parsed.host}:${parsed.parsed.port}`.toLowerCase();
        if (seenEndpoints.has(endpointKey)) {
          duplicates += 1;
          continue;
        }
        seenEndpoints.add(endpointKey);
        safeTarget = `${parsed.redacted.protocol}://${parsed.redacted.host}:${parsed.redacted.port}`;
      } catch (err) {
        parseError = (err as Error).message || "Invalid proxy input";
      }

      items.push({
        index: i + 1,
        proxyRaw: line,
        proxySafe: safeTarget,
        parsedProxy,
        parseError,
      });
    }

    const id = generateId();
    const job: AuditorJob = {
      id,
      mode: "bulk",
      status: "queued",
      sourceName: path.basename(rawName),
      createdAt: now(),
      startedAt: null,
      finishedAt: null,
      total: items.length,
      checked: 0,
      passCount: 0,
      warnCount: 0,
      failCount: 0,
      unknownCount: 0,
      duplicateCount: duplicates,
      browserAudit: validatedOpts.browser,
      attempts: validatedOpts.attempts,
      timeoutMs: validatedOpts.timeoutMs,
      concurrency: validatedOpts.concurrency,
      results: [],
      resultsCapped: false,
      persistenceWarning: "",
      error: "",
    };

    const runtime: ActiveJobRuntime = {
      job,
      controller: new AbortController(),
      fullResults: [],
    };

    activeJobs.set(id, runtime);
    history.unshift(job);
    if (history.length > MAX_HISTORY_JOBS) {
      history = history.slice(0, MAX_HISTORY_JOBS);
    }
    saveHistory();

    // Run in background without awaiting completion
    runtime.activeWorkerPromise = runJobQueue(runtime, items);

    return getSnapshot(job);
  }

  function getJob(id: string): AuditorJob | null {
    const active = activeJobs.get(id);
    if (active) return getSnapshot(active.job);
    const persisted = history.find((j) => j.id === id);
    return persisted ? getSnapshot(persisted) : null;
  }

  function listHistory(limit = MAX_HISTORY_JOBS): AuditorJob[] {
    const safeLimit = Math.max(1, Math.min(limit, MAX_HISTORY_JOBS));
    return history.slice(0, safeLimit).map(getSnapshot);
  }

  async function cancelJob(id: string): Promise<AuditorJob> {
    const runtime = activeJobs.get(id);
    if (!runtime) {
      const persisted = history.find((j) => j.id === id);
      if (!persisted) {
        throw new AuditorJobError(`Job not found: ${id}`, 404);
      }
      throw new AuditorJobError(`Cannot cancel job in ${persisted.status} state`, 409);
    }

    if (runtime.job.status === "done" || runtime.job.status === "error" || runtime.job.status === "cancelled") {
      throw new AuditorJobError(`Cannot cancel job in ${runtime.job.status} state`, 409);
    }

    if (runtime.job.status === "queued") {
      runtime.job.status = "cancelled";
      runtime.job.finishedAt = now();
      runtime.controller.abort();
      saveHistory();
      activeJobs.delete(id);
      return getSnapshot(runtime.job);
    }

    runtime.job.status = "cancelling";
    runtime.controller.abort();

    if (runtime.activeWorkerPromise) {
      await runtime.activeWorkerPromise;
    }

    return getSnapshot(runtime.job);
  }

  async function deleteHistory(id: string): Promise<boolean> {
    const runtime = activeJobs.get(id);
    if (runtime && (runtime.job.status === "queued" || runtime.job.status === "running" || runtime.job.status === "cancelling")) {
      throw new AuditorJobError(`Cannot delete active job ${id}`, 409);
    }

    const index = history.findIndex((j) => j.id === id);
    if (index === -1) return false;

    history.splice(index, 1);
    saveHistory();

    // Clean up export files
    try {
      const jsonFile = path.join(exportsDir, `${id}.json`);
      const csvFile = path.join(exportsDir, `${id}.csv`);
      if (fs.existsSync(jsonFile)) fs.unlinkSync(jsonFile);
      if (fs.existsSync(csvFile)) fs.unlinkSync(csvFile);
    } catch {
      // ignore unlink errors
    }

    return true;
  }

  async function exportJob(id: string, format: "json" | "csv"): Promise<AuditorExportResult> {
    const runtime = activeJobs.get(id);
    const job = runtime?.job || history.find((j) => j.id === id);
    if (!job) {
      throw new AuditorJobError(`Job not found: ${id}`, 404);
    }

    const fileNameBase = `audit-${job.id.slice(0, 8)}`;

    if (format === "json") {
      const filePath = path.join(exportsDir, `${id}.json`);
      if (fs.existsSync(filePath)) {
        return {
          contentType: "application/json",
          filename: `${fileNameBase}.json`,
          body: fs.readFileSync(filePath),
        };
      }
      // If not yet persisted or running, export in-memory results
      const resultsToExport = runtime?.fullResults || job.results;
      const jsonRecords = resultsToExport.map((r) => ({
        line: r.index,
        status: r.result ? "ok" : "error",
        result: r.result ? sanitizeResult(r.result) : undefined,
        error: r.error,
      }));
      return {
        contentType: "application/json",
        filename: `${fileNameBase}.json`,
        body: Buffer.from(JSON.stringify(jsonRecords, null, 2), "utf8"),
      };
    }

    if (format === "csv") {
      const filePath = path.join(exportsDir, `${id}.csv`);
      if (fs.existsSync(filePath)) {
        return {
          contentType: "text/csv; charset=utf-8",
          filename: `${fileNameBase}.csv`,
          body: fs.readFileSync(filePath),
        };
      }
      const resultsToExport = runtime?.fullResults || job.results;
      const bulkRecords: BulkRecord[] = resultsToExport.map((r) => {
        if (r.result) {
          return {
            line: r.index,
            status: "ok" as const,
            result: r.result,
          };
        }
        return {
          line: r.index,
          status: "error" as const,
          error: r.error || "Execution failed",
        };
      });
      return {
        contentType: "text/csv; charset=utf-8",
        filename: `${fileNameBase}.csv`,
        body: Buffer.from(formatCsvRecords(bulkRecords), "utf8"),
      };
    }

    throw new AuditorJobError(`Unsupported format: ${format}`, 400);
  }

  function isKnownJob(id: string): boolean {
    return activeJobs.has(id) || history.some((j) => j.id === id);
  }

  return {
    createSingle,
    createBulk,
    getJob,
    listHistory,
    cancelJob,
    deleteHistory,
    exportJob,
    isKnownJob,
  };
}
