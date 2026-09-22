import type { NetworkResult, ReputationResult } from "../types.js";

export type ReputationProviderName = "ipinfo" | "ipqs" | "abuseipdb";
export type ProviderStatus = "ok" | "unavailable" | "error";

export interface RawProviderReport<T = unknown> {
  provider: ReputationProviderName;
  status: ProviderStatus;
  data?: T;
  statusCode?: number;
  error?: string;
  cached?: boolean;
}

export interface ProviderContext {
  apiKey?: string;
  endpoint?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface ReputationOptions {
  apiKeys?: Partial<Record<ReputationProviderName, string>>;
  endpoints?: Partial<Record<ReputationProviderName, string>>;
  timeoutMs?: number;
  fetch?: typeof fetch;
  cachePath?: string;
  cacheTtlAsnMs?: number;
  cacheTtlReputationMs?: number;
}

export interface AggregatedReputationResult {
  network: NetworkResult;
  reputation: ReputationResult & {
    privacySignals?: string[];
    maliciousSignals?: string[];
  };
  raw: RawProviderReport[];
}
