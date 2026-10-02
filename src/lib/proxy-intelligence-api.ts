import { authHeaders } from "./api";
import type {
  ProxyInventoryFilter,
  ProxyInventoryPage,
  ProxyInventoryDetail,
  ProxyImportSummary,
} from "./types";
import type {
  IntelligenceJob,
  CreateIntelligenceJobPayload,
} from "../server/proxy-intelligence-jobs";

export type { IntelligenceJob, CreateIntelligenceJobPayload };

export interface ProxyImportPayload {
  source: string;
  content: string;
}

export async function fetchIntelligenceProxies(
  arg1?: string | ProxyInventoryFilter | AbortSignal,
  arg2?: ProxyInventoryFilter | AbortSignal,
  arg3?: AbortSignal
): Promise<ProxyInventoryPage> {
  let filter: ProxyInventoryFilter = {};
  let signal: AbortSignal | undefined;
  let password: string | undefined;

  if (typeof arg1 === "string") {
    password = arg1;
    if (typeof arg2 === "object" && !(arg2 instanceof AbortSignal)) filter = arg2;
    signal = arg3;
  } else if (typeof arg1 === "object" && !(arg1 instanceof AbortSignal)) {
    filter = arg1;
    if (arg2 instanceof AbortSignal) signal = arg2;
  } else if (arg1 instanceof AbortSignal) {
    signal = arg1;
  }

  const query = new URLSearchParams();
  if (filter.search) query.set("search", filter.search);
  if (filter.source && filter.source !== "all") query.set("source", filter.source);
  if (filter.protocol && filter.protocol !== "all") query.set("protocol", filter.protocol);
  if (filter.lifecycle && filter.lifecycle !== "all") query.set("lifecycle", filter.lifecycle);
  if (filter.verdict && filter.verdict !== "all") query.set("verdict", filter.verdict);
  if (filter.page) query.set("page", String(filter.page));
  if (filter.pageSize) query.set("pageSize", String(filter.pageSize));

  const url = `/api/intelligence/proxies?${query.toString()}`;
  const response = await fetch(url, {
    cache: "no-store",
    signal,
    credentials: "same-origin",
    headers: authHeaders(password),
  });

  if (!response.ok) {
    throw new Error(response.status === 401 ? "Wrong control password" : "Failed to load proxies");
  }

  return response.json() as Promise<ProxyInventoryPage>;
}

export async function fetchIntelligenceProxyDetail(
  arg1: string,
  arg2?: string | AbortSignal,
  arg3?: AbortSignal
): Promise<ProxyInventoryDetail> {
  let proxyKey: string;
  let signal: AbortSignal | undefined;
  let password: string | undefined;

  if (typeof arg2 === "string") {
    password = arg1;
    proxyKey = arg2;
    signal = arg3;
  } else {
    proxyKey = arg1;
    if (arg2 instanceof AbortSignal) signal = arg2;
  }

  const url = `/api/intelligence/proxies/${encodeURIComponent(proxyKey)}`;
  const response = await fetch(url, {
    cache: "no-store",
    signal,
    credentials: "same-origin",
    headers: authHeaders(password),
  });

  if (!response.ok) {
    throw new Error(response.status === 401 ? "Wrong control password" : "Proxy detail unavailable");
  }

  const data = (await response.json()) as { proxy: ProxyInventoryDetail };
  return data.proxy;
}

export async function importIntelligenceProxies(
  arg1: string | ProxyImportPayload,
  arg2?: ProxyImportPayload
): Promise<ProxyImportSummary> {
  const payload = typeof arg1 === "object" ? arg1 : arg2!;
  const password = typeof arg1 === "string" ? arg1 : undefined;

  const response = await fetch("/api/intelligence/import", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders(password),
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to import proxies");
  }

  return data as ProxyImportSummary;
}

export interface SyncWorkingPayload {
  startAudit?: boolean;
}

export interface SyncWorkingResult {
  imported: number;
  proxyKeys: string[];
  job?: IntelligenceJob;
}

export async function syncWorkingIntelligenceProxies(
  arg1?: string | SyncWorkingPayload,
  arg2?: SyncWorkingPayload
): Promise<SyncWorkingResult> {
  const payload = typeof arg1 === "object" ? arg1 : (arg2 ?? {});
  const password = typeof arg1 === "string" ? arg1 : undefined;

  const response = await fetch("/api/intelligence/sync-working", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders(password),
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to sync working proxies");
  }

  return data as SyncWorkingResult;
}

export async function createIntelligenceJob(
  arg1: string | CreateIntelligenceJobPayload,
  arg2?: CreateIntelligenceJobPayload
): Promise<IntelligenceJob> {
  const payload = typeof arg1 === "object" ? arg1 : arg2!;
  const password = typeof arg1 === "string" ? arg1 : undefined;

  const response = await fetch("/api/intelligence/jobs", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders(password),
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to start intelligence job");
  }

  return data.job as IntelligenceJob;
}

export async function fetchIntelligenceJob(
  arg1: string,
  arg2?: string | AbortSignal,
  arg3?: AbortSignal
): Promise<IntelligenceJob> {
  let id: string;
  let signal: AbortSignal | undefined;
  let password: string | undefined;

  if (typeof arg2 === "string") {
    password = arg1;
    id = arg2;
    signal = arg3;
  } else {
    id = arg1;
    if (arg2 instanceof AbortSignal) signal = arg2;
  }

  const response = await fetch(`/api/intelligence/jobs/${encodeURIComponent(id)}`, {
    cache: "no-store",
    signal,
    credentials: "same-origin",
    headers: authHeaders(password),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Job unavailable");
  }

  return data.job as IntelligenceJob;
}

export async function cancelIntelligenceJob(
  arg1: string,
  arg2?: string
): Promise<IntelligenceJob> {
  const id = arg2 !== undefined ? arg2 : arg1;
  const password = arg2 !== undefined ? arg1 : undefined;

  const response = await fetch(`/api/intelligence/jobs/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders(password),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to cancel job");
  }

  return data.job as IntelligenceJob;
}

export async function fetchIntelligenceJobs(
  arg1?: string | AbortSignal,
  arg2?: AbortSignal
): Promise<IntelligenceJob[]> {
  const signal = arg1 instanceof AbortSignal ? arg1 : arg2;
  const password = typeof arg1 === "string" ? arg1 : undefined;

  const response = await fetch("/api/intelligence/jobs", {
    cache: "no-store",
    signal,
    credentials: "same-origin",
    headers: authHeaders(password),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Jobs unavailable");
  }

  return (data.jobs || []) as IntelligenceJob[];
}
