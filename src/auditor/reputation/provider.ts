import type { NetworkResult, ReputationResult } from "../types.js";
import { validateTargetHost } from "../security/ssrf.js";

export type ReputationProviderName = "ipinfo" | "ipqs" | "abuseipdb";
export type ProviderStatus = "success" | "unavailable" | "error";

export interface RawProviderReport<T = unknown> {
  provider: ReputationProviderName;
  status: ProviderStatus;
  checkedAt: string;
  data?: T;
  raw?: unknown;
  statusCode?: number;
  error?: string;
  cached?: boolean;
}

export interface ProviderContext {
  apiKey?: string;
  endpoint?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  deadlineMs?: number;
  now?: () => number;
}

export interface ReputationOptions {
  apiKeys?: Partial<Record<ReputationProviderName, string>>;
  endpoints?: Partial<Record<ReputationProviderName, string>>;
  timeoutMs?: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  deadlineMs?: number;
  cachePath?: string;
  cacheTtlAsnMs?: number;
  cacheTtlReputationMs?: number;
  now?: () => number;
}

export interface AggregatedReputationResult {
  network: NetworkResult;
  reputation: ReputationResult & {
    privacySignals?: string[];
    maliciousSignals?: string[];
  };
  raw: RawProviderReport[];
}

export const MAX_PROVIDER_BODY_BYTES = 1024 * 1024;
const SENSITIVE_KEY = /(?:api[-_]?key|authorization|password|secret|token)/i;

export function providerCheckedAt(context: ProviderContext): string {
  return new Date((context.now ?? Date.now)()).toISOString();
}

export function redactProviderPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactProviderPayload);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactProviderPayload(child);
  }
  return output;
}

export async function validateProviderEndpoint(endpoint: string, context: ProviderContext): Promise<URL> {
  const url = new URL(endpoint);
  if (url.protocol !== "https:") throw new Error("Provider endpoint must use HTTPS");
  if (!context.fetch) {
    const validation = await validateTargetHost(url.hostname, {
      allowPrivateTargets: false,
      timeoutMs: context.timeoutMs ?? 5000,
    });
    if (!validation.valid) throw new Error("Provider endpoint is not public");
  }
  return url;
}

export function providerRequestSignal(context: ProviderContext): AbortSignal {
  const timeoutMs = context.timeoutMs ?? 5000;
  const remaining = context.deadlineMs === undefined
    ? timeoutMs
    : Math.min(timeoutMs, Math.max(0, context.deadlineMs - Date.now()));
  const signals = [AbortSignal.timeout(Math.max(1, remaining))];
  if (context.signal) signals.push(context.signal);
  return AbortSignal.any(signals);
}

export async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_BODY_BYTES) {
    throw new Error("Provider response exceeds 1 MiB limit");
  }
  if (!response.body) return undefined;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PROVIDER_BODY_BYTES) {
        await reader.cancel();
        throw new Error("Provider response exceeds 1 MiB limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(body);
  return text ? JSON.parse(text) : undefined;
}
