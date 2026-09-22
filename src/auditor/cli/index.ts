import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { ProxyAuditResult } from "../types.js";
import { formatCsvRecords, formatHumanResult, sanitizeCredentials, sanitizeResult } from "./formatters.js";
import { normalizeConcurrency, processProxyLines, writeFileAtomic } from "./bulk.js";

export interface ProxyAuditCliOptions {
  timeoutMs?: number;
  attempts?: number;
  baseline?: boolean;
  reputation?: boolean;
  browser?: boolean;
  allowPrivateTargets?: boolean;
  signal?: AbortSignal;
  endpoints?: string[];
  headerEndpoint?: string;
  tlsEndpoint?: string;
  controlEndpoint?: string;
  controlSpkiSha256?: string;
  controlExpectedBody?: string;
  controlHmacKey?: string;
  ca?: string | Buffer;
  providerKeys?: {
    ipinfo?: string;
    ipqs?: string;
    abuseipdb?: string;
  };
  cachePath?: string;
  concurrency?: number;
}

export type AuditProxyRunner = (proxy: unknown, options?: ProxyAuditCliOptions) => Promise<ProxyAuditResult>;

const USAGE = `Usage:
  proxy-audit check <proxy> [--json] [--pretty] [--timeout <ms>] [--attempts <n>] [--no-reputation] [--browser]
  proxy-audit check-file <file> [--concurrency <n>] [--output <json>] [--csv <csv>] [--timeout <ms>] [--attempts <n>] [--no-reputation] [--browser]
  proxy-audit browser-check <proxy> [--json] [--pretty] [--timeout <ms>] [--attempts <n>]

Options:
  --json             Print JSON output to stdout
  --pretty           Format JSON output with indentation
  --timeout <ms>     Per-probe timeout in milliseconds (positive integer)
  --attempts <n>     Probe attempt count (positive integer)
  --no-reputation    Disable external reputation lookups
  --browser          Run browser automation audit
  --concurrency <n>  Concurrent bulk worker count (1-50, default 5)
  --output <file>    Destination JSON file for bulk audits (default: results.json)
  --csv <file>       Destination CSV file for bulk audits
  -h, --help         Show this help message
`;

async function loadCheckProxy(): Promise<AuditProxyRunner> {
  try {
    const mod = await import("../index.js");
    if (typeof mod.checkProxy === "function") {
      return mod.checkProxy;
    }
  } catch {
    // Try direct API module
  }

  try {
    const mod = await import("../api.js");
    if (typeof mod.checkProxy === "function") {
      return mod.checkProxy;
    }
  } catch {
    // API not yet ready
  }

  throw new Error("Audit engine not available");
}

function parsePositiveInteger(value: string | undefined, flagName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Option --${flagName} must be a positive integer`);
  }
  return parsed;
}

export interface CliExecutionResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export async function runCli(argv: string[], engineRunner?: AuditProxyRunner): Promise<CliExecutionResult> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        pretty: { type: "boolean", default: false },
        timeout: { type: "string" },
        attempts: { type: "string" },
        "no-reputation": { type: "boolean", default: false },
        browser: { type: "boolean", default: false },
        concurrency: { type: "string" },
        output: { type: "string" },
        csv: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Invalid CLI options";
    return {
      exitCode: 2,
      stderr: `${sanitizeCredentials(message)}\n\n${USAGE}`,
    };
  }

  if (parsed.values.help) {
    return {
      exitCode: 0,
      stdout: USAGE,
    };
  }

  const [command, target] = parsed.positionals;
  if (!command || !target) {
    return {
      exitCode: 2,
      stderr: USAGE,
    };
  }

  let timeoutMs: number | undefined;
  let attempts: number | undefined;
  let concurrency: number | undefined;
  try {
    timeoutMs = parsePositiveInteger(parsed.values.timeout, "timeout");
    attempts = parsePositiveInteger(parsed.values.attempts, "attempts");
    if (parsed.values.concurrency !== undefined) {
      const raw = parsePositiveInteger(parsed.values.concurrency, "concurrency");
      concurrency = normalizeConcurrency(raw);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Invalid numeric argument";
    return {
      exitCode: 2,
      stderr: `${sanitizeCredentials(message)}\n\n${USAGE}`,
    };
  }

  const baseOptions: ProxyAuditCliOptions = {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
    ...(parsed.values["no-reputation"] ? { reputation: false } : {}),
    ...(parsed.values.browser ? { browser: true } : {}),
  };

  if (command === "check" || command === "browser-check") {
    let checkFn = engineRunner;
    if (!checkFn) {
      try {
        checkFn = await loadCheckProxy();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Engine failed";
        return {
          exitCode: 1,
          stderr: sanitizeCredentials(message),
        };
      }
    }

    const singleOptions: ProxyAuditCliOptions = {
      ...baseOptions,
      ...(command === "browser-check" ? { browser: true } : {}),
    };

    let result: ProxyAuditResult;
    try {
      result = await checkFn(target, singleOptions);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Audit failed";
      return {
        exitCode: 1,
        stderr: sanitizeCredentials(message),
      };
    }

    if (parsed.values.json) {
      const sanitized = sanitizeResult(result);
      const output = parsed.values.pretty
        ? JSON.stringify(sanitized, null, 2)
        : JSON.stringify(sanitized);
      return {
        exitCode: result.verdict === "FAIL" ? 1 : 0,
        stdout: output,
      };
    }

    return {
      exitCode: result.verdict === "FAIL" ? 1 : 0,
      stdout: formatHumanResult(result),
    };
  }

  if (command === "check-file") {
    let fileContent: string;
    try {
      fileContent = await readFile(target, "utf8");
    } catch {
      return {
        exitCode: 1,
        stderr: `Could not read proxy file: ${target}`,
      };
    }

    const lines = fileContent.split(/\r?\n/).filter((line, index, all) => {
      if (index === all.length - 1 && line.trim() === "") {
        return false;
      }
      return true;
    });

    let checkFn = engineRunner;
    const records = await processProxyLines(lines, { concurrency }, async (proxyLine) => {
      if (!checkFn) {
        checkFn = await loadCheckProxy();
      }
      return await checkFn(proxyLine, baseOptions);
    });

    const jsonDestination = parsed.values.output || "results.json";
    const sanitizedRecords = records.map((record) => {
      if (record.status === "ok") {
        return {
          ...record,
          result: sanitizeResult(record.result),
        };
      }
      return record;
    });

    const jsonContent = parsed.values.pretty
      ? JSON.stringify(sanitizedRecords, null, 2)
      : JSON.stringify(sanitizedRecords);

    await writeFileAtomic(jsonDestination, jsonContent);

    if (parsed.values.csv) {
      await writeFileAtomic(parsed.values.csv, formatCsvRecords(records));
    }

    const hasErrors = records.some((record) => record.status === "error" || record.result?.verdict === "FAIL");
    return {
      exitCode: hasErrors ? 1 : 0,
      stdout: `Audited ${records.length} proxies. Results saved to ${jsonDestination}${parsed.values.csv ? ` and ${parsed.values.csv}` : ""}.`,
    };
  }

  return {
    exitCode: 2,
    stderr: `Unknown command: ${command}\n\n${USAGE}`,
  };
}
