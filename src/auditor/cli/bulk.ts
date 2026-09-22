import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseProxyInput } from "../parser.js";
import type { ProxyAuditResult } from "../types.js";
import { sanitizeCredentials } from "./formatters.js";

export interface BulkSuccessRecord {
  line: number;
  status: "ok";
  result: ProxyAuditResult;
}

export interface BulkErrorRecord {
  line: number;
  status: "error";
  error: string;
}

export type BulkRecord = BulkSuccessRecord | BulkErrorRecord;

export interface BulkOptions {
  concurrency?: number;
}

export function normalizeConcurrency(raw: number | undefined): number {
  if (raw === undefined) {
    return 5;
  }
  if (!Number.isInteger(raw) || raw < 1 || raw > 50) {
    throw new Error("Concurrency must be an integer between 1 and 50");
  }
  return raw;
}

export async function processProxyLines(
  lines: string[],
  options: BulkOptions,
  runner: (proxyLine: string) => Promise<ProxyAuditResult>,
): Promise<BulkRecord[]> {
  const concurrency = normalizeConcurrency(options.concurrency);
  const records: BulkRecord[] = new Array(lines.length);

  let nextIndex = 0;
  const workerCount = Math.min(concurrency, Math.max(lines.length, 1));

  async function worker(): Promise<void> {
    while (nextIndex < lines.length) {
      const index = nextIndex;
      nextIndex += 1;
      const lineNumber = index + 1;
      const rawLine = lines[index];
      const trimmed = rawLine.trim();

      if (!trimmed) {
        records[index] = {
          line: lineNumber,
          status: "error",
          error: "Empty proxy entry",
        };
        continue;
      }

      try {
        parseProxyInput(trimmed);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Malformed proxy";
        records[index] = {
          line: lineNumber,
          status: "error",
          error: sanitizeCredentials(message),
        };
        continue;
      }

      try {
        const audit = await runner(trimmed);
        records[index] = {
          line: lineNumber,
          status: "ok",
          result: audit,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Audit failed";
        records[index] = {
          line: lineNumber,
          status: "error",
          error: sanitizeCredentials(message),
        };
      }
    }
  }

  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return records;
}

export async function writeFileAtomic(destination: string, content: string): Promise<void> {
  const resolved = path.resolve(destination);
  const directory = path.dirname(resolved);
  const tempPath = path.join(directory, `.${path.basename(resolved)}.${randomUUID()}.tmp`);

  await writeFile(tempPath, content, "utf8");
  try {
    await rename(tempPath, resolved);
  } catch (error: unknown) {
    try {
      await rm(tempPath, { force: true });
    } catch {
      // Ignore secondary removal failure
    }
    throw error;
  }
}
