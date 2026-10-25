import { authHeaders } from "./api";
import { isAbortError } from "./request-lifecycle";
import type {
  ProxyInventoryFilter,
  ProxyInventoryPage,
  ProxyInventoryDetail,
  ProxyImportSummary,
  ProxyImportPreview,
} from "./types";
export interface CreateIntelligenceJobPayload {
  proxyKeys?: string[];
  filter?: ProxyInventoryFilter;
  options?: Record<string, unknown>;
}

export interface IntelligenceJob {
  id: string;
  status: string;
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
export interface ProxyImportPayload {
  source: string;
  content: string;
}

export async function fetchIntelligenceProxies(
  arg1?: string | ProxyInventoryFilter | AbortSignal,
  arg2?: ProxyInventoryFilter | AbortSignal,
  arg3?: AbortSignal,
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
  const emptyPage: ProxyInventoryPage = {
    items: [],
    page: 1,
    pageSize: 50,
    total: 0,
  };
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal,
      credentials: "same-origin",
      headers: authHeaders(password),
    });
    if (signal?.aborted) return emptyPage;
    if (!response.ok) {
      throw new Error(
        response.status === 401 ? "Wrong control password" : "Failed to load proxies",
      );
    }
    const data = await response.json();
    if (signal?.aborted) return emptyPage;
    return data as ProxyInventoryPage;
  } catch (err: unknown) {
    if (signal?.aborted || isAbortError(err)) {
      return emptyPage;
    }
    throw err;
  }
}

export async function fetchIntelligenceProxyDetail(
  arg1: string,
  arg2?: string | AbortSignal,
  arg3?: AbortSignal,
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
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal,
      credentials: "same-origin",
      headers: authHeaders(password),
    });
    if (signal?.aborted) return {} as ProxyInventoryDetail;
    if (!response.ok) {
      throw new Error(
        response.status === 401 ? "Wrong control password" : "Proxy detail unavailable",
      );
    }
    const data = (await response.json()) as { proxy: ProxyInventoryDetail };
    if (signal?.aborted) return {} as ProxyInventoryDetail;
    return data.proxy;
  } catch (err: unknown) {
    if (signal?.aborted || isAbortError(err)) return {} as ProxyInventoryDetail;
    throw err;
  }
}

export async function importIntelligenceProxies(
  arg1: string | ProxyImportPayload,
  arg2?: ProxyImportPayload,
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

export async function previewIntelligenceImport(
  arg1: string | ProxyImportPayload,
  arg2?: ProxyImportPayload,
): Promise<ProxyImportPreview> {
  const payload = typeof arg1 === "object" ? arg1 : arg2!;
  const password = typeof arg1 === "string" ? arg1 : undefined;

  const response = await fetch("/api/intelligence/import/preview", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders(password),
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to preview import");
  }

  return data.preview as ProxyImportPreview;
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
  arg2?: SyncWorkingPayload,
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
  arg2?: CreateIntelligenceJobPayload,
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
  arg3?: AbortSignal,
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

  const emptyJob: IntelligenceJob = {
    id,
    status: "cancelled",
    total: 0,
    checked: 0,
    passCount: 0,
    warnCount: 0,
    failCount: 0,
    unknownCount: 0,
    startedAt: null,
    finishedAt: null,
  };
  try {
    const response = await fetch(`/api/intelligence/jobs/${encodeURIComponent(id)}`, {
      cache: "no-store",
      signal,
      credentials: "same-origin",
      headers: authHeaders(password),
    });
    if (signal?.aborted) return emptyJob;
    const data = await response.json();
    if (signal?.aborted) return emptyJob;
    if (!response.ok) {
      throw new Error(data.error || "Job unavailable");
    }
    return data.job as IntelligenceJob;
  } catch (err: unknown) {
    if (signal?.aborted || isAbortError(err)) return emptyJob;
    throw err;
  }
}
export async function cancelIntelligenceJob(arg1: string, arg2?: string): Promise<IntelligenceJob> {
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
  arg2?: AbortSignal,
): Promise<IntelligenceJob[]> {
  const signal = arg1 instanceof AbortSignal ? arg1 : arg2;
  const password = typeof arg1 === "string" ? arg1 : undefined;

  try {
    const response = await fetch("/api/intelligence/jobs", {
      cache: "no-store",
      signal,
      credentials: "same-origin",
      headers: authHeaders(password),
    });
    if (signal?.aborted) return [];
    const data = await response.json();
    if (signal?.aborted || !data) return [];
    if (!response.ok) {
      throw new Error(data.error || "Jobs unavailable");
    }
    return (data.jobs || []) as IntelligenceJob[];
  } catch (err: unknown) {
    if (signal?.aborted || isAbortError(err)) return [];
    throw err;
  }
}
