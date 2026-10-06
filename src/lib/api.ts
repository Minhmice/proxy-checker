import type {
  DiagnosticJob,
  DetailedDiagnosticResult,
  PoolRecord,
  PoolStatus,
  MetricsSnapshot,
  SettingsResponse,
  SettingsUpdatePayload,
  NineRouterTestResult,
  UnifiedProxyItem,
  UnifiedProxyResponse,
  UnifiedProxyHistoryEntry,
  ProxyAuditDetail,
  AntigravityRotatorSnapshot,
} from "./types";
import { isAbortError } from "./request-lifecycle";
export function jsonHeaders(customHeaders?: HeadersInit): HeadersInit {
  return {
    "Content-Type": "application/json",
    ...customHeaders,
  };
}

export function authHeaders(password?: string): HeadersInit {
  if (password) {
    return {
      Authorization: `Basic ${btoa(`admin:${password}`)}`,
      "Content-Type": "application/json",
    };
  }
  return {
    "Content-Type": "application/json",
  };
}

export async function login(password: string): Promise<boolean> {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ password }),
    credentials: "same-origin",
  });
  if (!response.ok) {
    let msg = "Invalid control password";
    try {
      const body = await response.json();
      if (body.error) msg = body.error;
    } catch {}
    throw new Error(msg);
  }
  return true;
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "same-origin",
  }).catch(() => {});
}

export async function checkSession(signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch("/api/auth/session", {
      cache: "no-store",
      credentials: "same-origin",
      signal,
    });
    if (!response.ok) return false;
    const body = await response.json();
    return Boolean(body.authenticated);
  } catch {
    return false;
  }
}

const STORAGE_KEY = "minhmiceproxy-password";
const STORAGE_DATE_KEY = "minhmiceproxy-password-date";
const COOKIE_NAME = "minhmiceproxy-auth";
export function getStoredPassword(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const now = new Date();
    const today = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    if (sessionStorage.getItem(STORAGE_DATE_KEY) === today) {
      const pass = sessionStorage.getItem(STORAGE_KEY);
      if (pass) return pass;
    }
    const match = document.cookie.split("; ").find((c) => c.startsWith(`${COOKIE_NAME}=`));
    if (match) {
      const cookiePass = decodeURIComponent(match.slice(COOKIE_NAME.length + 1));
      sessionStorage.setItem(STORAGE_KEY, cookiePass);
      sessionStorage.setItem(STORAGE_DATE_KEY, today);
      return cookiePass;
    }
  } catch {}
  return null;
}

export function storePassword(password: string): void {
  if (typeof window === "undefined") return;
  try {
    const now = new Date();
    const today = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    sessionStorage.setItem(STORAGE_KEY, password);
    sessionStorage.setItem(STORAGE_DATE_KEY, today);
    document.cookie = `${COOKIE_NAME}=${encodeURIComponent(password)}; path=/; max-age=86400; SameSite=Lax`;
  } catch {}
}

export async function clearStoredPassword(): Promise<void> {
  if (typeof window !== "undefined") {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem(STORAGE_DATE_KEY);
      document.cookie = `${COOKIE_NAME}=; path=/; max-age=0; SameSite=Lax`;
    } catch {}
  }
  await logout();
}

export async function fetchStatus(arg1?: string | AbortSignal, arg2?: AbortSignal): Promise<PoolStatus> {
  const signal = arg1 instanceof AbortSignal ? arg1 : (arg2 instanceof AbortSignal ? arg2 : undefined);
  const password = typeof arg1 === "string" ? arg1 : undefined;

  const response = await fetch("/api/ninerouter/status", {
    cache: "no-store",
    signal,
    credentials: "same-origin",
    headers: authHeaders(password),
  }).catch((err) => {
    if (isAbortError(err)) return null;
    throw err;
  });
  if (!response) {
    return {
      running: false,
      configured: false,
      lastSyncAt: null,
      lastError: "",
      stats: { total: 0, active: 0, reserve: 0, dead: 0 },
      syncIntervalMinutes: 15,
      activeLimit: 20,
    };
  }
  if (response.status === 401) throw new Error("Wrong control password");
  if (!response.ok) throw new Error("Control service is unavailable");
  return response.json();
}
export async function fetchPools(arg1?: string | AbortSignal, arg2?: string | AbortSignal, arg3?: AbortSignal): Promise<PoolRecord[]> {
  let tier: string | undefined;
  let signal: AbortSignal | undefined;
  let password: string | undefined;

  if (typeof arg1 === "string") {
    if (typeof arg2 === "string") {
      password = arg1;
      tier = arg2;
      signal = arg3;
    } else if (arg2 instanceof AbortSignal) {
      tier = arg1;
      signal = arg2;
    } else {
      tier = arg1;
    }
  } else if (arg1 instanceof AbortSignal) {
    signal = arg1;
  }

  const query = tier ? `?tier=${tier}` : "";
  const response = await fetch(`/api/ninerouter/pools${query}`, {
    cache: "no-store",
    headers: authHeaders(password),
    credentials: "same-origin",
    signal,
  }).catch((err) => {
    if (isAbortError(err)) return null;
    throw err;
  });
  if (!response) return [];
  if (response.status === 401) throw new Error("Wrong control password");
  if (!response.ok) throw new Error("Control service is unavailable");
  const body = await response.json();
  return body.pools ?? [];
}

export async function fetchMetrics(arg1?: number | string | AbortSignal, arg2?: number | AbortSignal, arg3?: AbortSignal): Promise<MetricsSnapshot[]> {
  let hours = 24;
  let signal: AbortSignal | undefined;
  let password: string | undefined;

  if (typeof arg1 === "string") {
    password = arg1;
    if (typeof arg2 === "number") hours = arg2;
    signal = arg3;
  } else if (typeof arg1 === "number") {
    hours = arg1;
    if (arg2 instanceof AbortSignal) signal = arg2;
  } else if (arg1 instanceof AbortSignal) {
    signal = arg1;
  }

  const response = await fetch(`/api/ninerouter/metrics?hours=${hours}`, {
    cache: "no-store",
    headers: authHeaders(password),
    credentials: "same-origin",
    signal,
  }).catch((err) => {
    if (isAbortError(err)) return null;
    throw err;
  });
  if (!response) return [];
  if (response.status === 401) throw new Error("Wrong control password");
  if (!response.ok) throw new Error("Metrics unavailable");
  const body = await response.json();
  return body.snapshots ?? [];
}
export async function syncPools(password?: string) {
  const response = await fetch("/api/ninerouter/sync", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders(password),
  });
  if (response.status === 401) throw new Error("Wrong control password");
  if (!response.ok) throw new Error("Failed to start sync");
  return response.json();
}

export async function togglePool(arg1: string, arg2: string | boolean, arg3?: boolean) {
  let id: string;
  let isActive: boolean;
  let password: string | undefined;

  if (typeof arg3 === "boolean") {
    password = arg1;
    id = String(arg2);
    isActive = arg3;
  } else {
    id = arg1;
    isActive = Boolean(arg2);
  }

  const response = await fetch("/api/ninerouter/activate", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders(password),
    body: JSON.stringify({ id, isActive }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Toggle failed");
  return body.pool as PoolRecord;
}

export async function fetchDiagnosticFiles(password?: string) {
  const response = await fetch("/api/diagnostics/files", {
    cache: "no-store",
    credentials: "same-origin",
    headers: authHeaders(password),
  });
  if (!response.ok) throw new Error(response.status === 401 ? "Wrong control password" : "Diagnostic files unavailable");
  return response.json() as Promise<{ files: Array<{ name: string; count: number }>; job: DiagnosticJob }>;
}

export async function fetchDiagnosticJob(arg1?: string | AbortSignal, arg2?: AbortSignal) {
  const signal = arg1 instanceof AbortSignal ? arg1 : (arg2 instanceof AbortSignal ? arg2 : undefined);
  const password = typeof arg1 === "string" ? arg1 : undefined;

  const response = await fetch("/api/diagnostics/job", {
    cache: "no-store",
    signal,
    credentials: "same-origin",
    headers: authHeaders(password),
  }).catch((err) => {
    if (isAbortError(err)) return null;
    throw err;
  });
  if (!response) return null;
  if (!response.ok) throw new Error(response.status === 401 ? "Wrong control password" : "Diagnostic job unavailable");
  return (await response.json()).job as DiagnosticJob;
}

export async function uploadDiagnosticFile(arg1: string, arg2: string, arg3?: string) {
  let name: string;
  let content: string;
  let password: string | undefined;

  if (arg3 !== undefined) {
    password = arg1;
    name = arg2;
    content = arg3;
  } else {
    name = arg1;
    content = arg2;
  }

  const response = await fetch("/api/diagnostics/upload", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders(password),
    body: JSON.stringify({ name, content }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not upload input list");
  return body as { name: string; count: number };
}

export async function renamePool(arg1: string, arg2: string, arg3?: string) {
  let localId: string;
  let name: string;
  let password: string | undefined;

  if (arg3 !== undefined) {
    password = arg1;
    localId = arg2;
    name = arg3;
  } else {
    localId = arg1;
    name = arg2;
  }

  const response = await fetch(`/api/ninerouter/pools/${encodeURIComponent(localId)}`, {
    method: "PATCH",
    credentials: "same-origin",
    headers: authHeaders(password),
    body: JSON.stringify({ name: name.trim() }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not rename proxy");
  return body.pool as PoolRecord;
}

export async function removePool(arg1: string, arg2?: string) {
  const localId = arg2 !== undefined ? arg2 : arg1;
  const password = arg2 !== undefined ? arg1 : undefined;

  const response = await fetch(`/api/ninerouter/pools/${encodeURIComponent(localId)}`, {
    method: "DELETE",
    credentials: "same-origin",
    headers: authHeaders(password),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not remove proxy");
  return body.pool as PoolRecord;
}

export async function runDiagnostics(arg1: string | { file: string; samplePercent?: number; sampleCount?: number }, arg2?: { file: string; samplePercent?: number; sampleCount?: number }) {
  const options = typeof arg1 === "object" ? arg1 : arg2!;
  const password = typeof arg1 === "string" ? arg1 : undefined;

  const response = await fetch("/api/diagnostics/run", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders(password),
    body: JSON.stringify(options),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not start diagnostics");
  return body as { started: boolean };
}

export async function stopDiagnostics(password?: string) {
  const response = await fetch("/api/diagnostics/cancel", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders(password),
  });
  if (response.status === 401) throw new Error("Wrong control password");
  if (!response.ok) throw new Error("Could not stop diagnostics");
  return response.json() as Promise<{ stopped: boolean; job: DiagnosticJob }>;
}

export async function promoteDiagnostics(arg1: string | string[], arg2?: string[]) {
  const ids = Array.isArray(arg1) ? arg1 : arg2!;
  const password = typeof arg1 === "string" ? arg1 : undefined;

  const response = await fetch("/api/diagnostics/promote", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders(password),
    body: JSON.stringify({ ids }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not promote diagnostics");
  return body as { promoted: number; skipped: number; results: string[]; skippedIds: string[] };
}

export function formatTime(value: number | null): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

export async function fetchSettings(arg1?: string | AbortSignal, arg2?: AbortSignal) {
  const signal = arg1 instanceof AbortSignal ? arg1 : (arg2 instanceof AbortSignal ? arg2 : undefined);
  const password = typeof arg1 === "string" ? arg1 : undefined;

  const response = await fetch("/api/settings", {
    cache: "no-store",
    signal,
    credentials: "same-origin",
    headers: authHeaders(password),
  }).catch((err) => {
    if (isAbortError(err)) return null;
    throw err;
  });
  if (!response) {
    return {
      settings: {
        controlPasswordSet: false,
        nineRouterPasswordSet: false,
        nineRouterApiKeySet: false,
        nineRouterUrl: "",
        nineRouterAutoSync: false,
        activePoolLimit: 20,
        nineRouterSyncMinutes: 15,
        checkConcurrency: 20,
        checkTimeoutMs: 5000,
        proxyTtlMinutes: 60,
        antigravityRotatorEnabled: true,
        antigravityActiveLimit: 3,
        antigravityRotateMinutes: 10,
        antigravitySessionThreshold: 20,
      },
      meta: { restartRequired: [], source: "settings" as const },
    };
  }
  if (response.status === 401) throw new Error("Wrong control password");
  if (!response.ok) throw new Error("Settings unavailable");
  return response.json() as Promise<SettingsResponse>;
}

export async function updateSettings(arg1: string | SettingsUpdatePayload, arg2?: SettingsUpdatePayload) {
  const patch = typeof arg1 === "object" ? arg1 : arg2!;
  const password = typeof arg1 === "string" ? arg1 : undefined;

  const response = await fetch("/api/settings", {
    method: "PUT",
    credentials: "same-origin",
    headers: authHeaders(password),
    body: JSON.stringify(patch),
  });
  const body = await response.json();
  if (response.status === 401) throw new Error("Wrong control password");
  if (!response.ok) throw new Error(body.error || "Could not save settings");
  return body as SettingsResponse;
}

export async function testNineRouterConnection(
  arg1?: string | { nineRouterUrl?: string; nineRouterPassword?: string; nineRouterApiKey?: string },
  arg2?: { nineRouterUrl?: string; nineRouterPassword?: string; nineRouterApiKey?: string }
) {
  const patch = typeof arg1 === "object" ? arg1 : arg2;
  const password = typeof arg1 === "string" ? arg1 : undefined;

  const response = await fetch("/api/settings/test-ninerouter", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders(password),
    body: JSON.stringify(patch ?? {}),
  });
  const body = await response.json();
  if (response.status === 401) throw new Error("Wrong control password");
  return body as NineRouterTestResult;
}

export async function downloadProxyExport(
  arg1: string | ("txt" | "csv"),
  arg2?: ("txt" | "csv") | boolean,
  arg3: boolean | { scope?: string } = false,
  arg4?: { scope?: string }
): Promise<{ blob: Blob; filename: string }> {
  let format: "txt" | "csv" = "txt";
  let includeCredentials = false;
  let password: string | undefined;
  let scope: string | undefined;

  if (typeof arg1 === "string" && (arg1 === "txt" || arg1 === "csv")) {
    format = arg1;
    includeCredentials = Boolean(arg2);
    if (typeof arg3 === "object" && arg3 !== null) {
      scope = arg3.scope;
    }
  } else if (typeof arg1 === "string") {
    password = arg1;
    format = (arg2 === "csv" ? "csv" : "txt");
    includeCredentials = Boolean(arg3);
    if (arg4) scope = arg4.scope;
  }

  const query = new URLSearchParams({
    format,
    includeCredentials: String(includeCredentials),
  });
  if (includeCredentials) {
    query.set("confirmCredentials", "yes");
  }
  if (scope) {
    query.set("scope", scope);
  }
  const response = await fetch(`/api/settings/proxy-export?${query.toString()}`, {
    credentials: "same-origin",
    headers: authHeaders(password),
  });
  if (response.status === 401) throw new Error("Wrong control password");
  if (!response.ok) {
    let msg = "Failed to export proxies";
    try {
      const body = await response.json();
      if (body.error) msg = body.error;
    } catch {}
    throw new Error(msg);
  }
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition");
  let filename = `proxies-${format === "csv" ? "export.csv" : "export.txt"}`;
  if (disposition) {
    const match = disposition.match(/filename="?([^"]+)"?/);
    if (match?.[1]) filename = match[1];
  }
  return { blob, filename };
}

export async function fetchUnifiedProxies(
  arg1?: string | {
    health?: string;
    status?: string;
    search?: string;
    protocol?: string;
    source?: string;
    sort?: string;
    direction?: string;
    page?: number;
    pageSize?: number;
  } | AbortSignal,
  arg2?: {
    health?: string;
    status?: string;
    search?: string;
    protocol?: string;
    source?: string;
    sort?: string;
    direction?: string;
    page?: number;
    pageSize?: number;
  } | AbortSignal,
  arg3?: AbortSignal
): Promise<UnifiedProxyResponse> {
  let params: {
    health?: string;
    status?: string;
    search?: string;
    protocol?: string;
    source?: string;
    sort?: string;
    direction?: string;
    page?: number;
    pageSize?: number;
  } | undefined;
  let signal: AbortSignal | undefined;
  let password: string | undefined;

  if (arg1 instanceof AbortSignal) {
    signal = arg1;
  } else if (typeof arg1 === "string") {
    password = arg1;
    if (typeof arg2 === "object" && !(arg2 instanceof AbortSignal)) params = arg2;
    signal = arg3;
  } else if (typeof arg1 === "object" && arg1 !== null) {
    params = arg1;
    if (arg2 instanceof AbortSignal) signal = arg2;
  }

  const query = new URLSearchParams();
  if (params?.health) query.set("health", params.health);
  if (params?.status) query.set("status", params.status);
  if (params?.search) query.set("search", params.search);
  if (params?.protocol) query.set("protocol", params.protocol);
  if (params?.source) query.set("source", params.source);
  if (params?.sort) query.set("sort", params.sort);
  if (params?.direction) query.set("direction", params.direction);
  if (params?.page) query.set("page", String(params.page));
  if (params?.pageSize) query.set("pageSize", String(params.pageSize));
  const response = await fetch(`/api/proxies/unified?${query.toString()}`, {
    cache: "no-store",
    signal,
    credentials: "same-origin",
    headers: authHeaders(password),
  }).catch((err) => {
    if (isAbortError(err)) return null;
    throw err;
  });
  if (!response) {
    return {
      items: [],
      counts: { all: 0, working: 0, regressed: 0, dead: 0 },
      total: 0,
      facets: { all: 0, working: 0, regressed: 0, dead: 0, protocols: {} },
      pagination: { page: 1, pageSize: 50, total: 0 },
      meta: { generatedAt: new Date().toISOString() },
    };
  }
  if (response.status === 401) throw new Error("Wrong control password");
  if (!response.ok) {
    let msg = "Failed to fetch proxies";
    try {
      const data = await response.json();
      if (data.error) msg = data.error;
    } catch {}
    throw new Error(msg);
  }
  return response.json();
}

export async function checkProxyValidity(
  arg1: string,
  arg2?: string | AbortSignal,
  arg3?: AbortSignal
): Promise<{ proxy: UnifiedProxyItem; auditResult?: unknown }> {
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

  const response = await fetch("/api/proxies/check", {
    method: "POST",
    cache: "no-store",
    signal,
    credentials: "same-origin",
    headers: authHeaders(password),
    body: JSON.stringify({ proxyKey }),
  });
  if (response.status === 401) throw new Error("Wrong control password");
  if (!response.ok) {
    let msg = "Failed to check proxy validity";
    try {
      const data = await response.json();
      if (data.error) msg = data.error;
    } catch {}
    throw new Error(msg);
  }
  return response.json();
}

export async function fetchProxyHistory(
  arg1: string,
  arg2?: string | AbortSignal,
  arg3?: AbortSignal
): Promise<{ history: UnifiedProxyHistoryEntry[] }> {
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

  const query = new URLSearchParams({ key: proxyKey });
  const response = await fetch(`/api/proxies/history?${query.toString()}`, {
    cache: "no-store",
    signal,
    credentials: "same-origin",
    headers: authHeaders(password),
  }).catch((err) => {
    if (isAbortError(err)) return null;
    throw err;
  });
  if (!response) return { history: [] };
  if (response.status === 401) throw new Error("Wrong control password");
  if (!response.ok) {
    let msg = "Failed to fetch proxy history";
    try {
      const data = await response.json();
      if (data.error) msg = data.error;
    } catch {}
    throw new Error(msg);
  }
  return response.json();
}

export async function fetchProxyAuditDetail(
  proxyKey: string,
  auditId?: string,
  signal?: AbortSignal
): Promise<{ auditDetail: ProxyAuditDetail | null }> {
  const query = new URLSearchParams({ key: proxyKey });
  if (auditId) query.set("auditId", auditId);

  const response = await fetch(`/api/proxies/detail?${query.toString()}`, {
    cache: "no-store",
    signal,
    credentials: "same-origin",
  }).catch((err) => {
    if (isAbortError(err)) return null;
    throw err;
  });
  if (!response) return { auditDetail: null };
  if (response.status === 401) throw new Error("Wrong control password");
  if (!response.ok) {
    let msg = "Failed to fetch audit detail";
    try {
      const data = await response.json();
      if (data.error) msg = data.error;
    } catch {}
    throw new Error(msg);
  }
  return response.json();
}

export async function fetchAntigravityStatus(arg1?: string | AbortSignal, arg2?: AbortSignal): Promise<AntigravityRotatorSnapshot | null> {
  const signal = arg1 instanceof AbortSignal ? arg1 : (arg2 instanceof AbortSignal ? arg2 : undefined);
  const password = typeof arg1 === "string" ? arg1 : undefined;

  const response = await fetch("/api/antigravity/status", {
    cache: "no-store",
    signal,
    credentials: "same-origin",
    headers: authHeaders(password),
  }).catch((err) => {
    if (isAbortError(err)) return null;
    throw err;
  });
  if (!response || !response.ok) return null;
  return response.json();
}

export async function refreshAntigravityQuota(password?: string): Promise<{ started: boolean; snapshot?: AntigravityRotatorSnapshot }> {
  const response = await fetch("/api/antigravity/refresh", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders(password),
  });
  if (response.status === 401) throw new Error("Wrong control password");
  if (!response.ok) throw new Error("Failed to refresh Antigravity quotas");
  return response.json();
}

export async function setProxyPin(proxyKey: string, isPinned: boolean, password?: string): Promise<{ proxyKey: string; isPinned: boolean }> {
  const response = await fetch("/api/proxies/pin", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders(password),
    body: JSON.stringify({ proxyKey, isPinned }),
  });
  if (response.status === 401) throw new Error("Wrong control password");
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || "Failed to toggle proxy pin");
  }
  return response.json();
}

export async function unlinkProxyFromRouter(proxyKey: string, password?: string): Promise<{ ok: boolean }> {
  const response = await fetch("/api/proxies/unlink-router", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders(password),
    body: JSON.stringify({ proxyKey }),
  });
  if (response.status === 401) throw new Error("Wrong control password");
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || "Failed to unlink proxy from 9Router");
  }
  return response.json();
}

export async function pushProxyToRouter(proxyKey: string, password?: string): Promise<{ ok: boolean; remoteId?: string }> {
  const response = await fetch("/api/proxies/push-router", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders(password),
    body: JSON.stringify({ proxyKey }),
  });
  if (response.status === 401) throw new Error("Wrong control password");
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || "Failed to push proxy to 9Router");
  }
  return response.json();
}

export async function hardDeleteProxy(key: string, force = false, password?: string): Promise<{ ok: boolean; deleted: boolean }> {
  const query = new URLSearchParams({ key, force: String(force) });
  const response = await fetch(`/api/proxies/hard-delete?${query.toString()}`, {
    method: "DELETE",
    credentials: "same-origin",
    headers: authHeaders(password),
  });
  if (response.status === 401) throw new Error("Wrong control password");
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || "Failed to delete proxy");
  }
  return response.json();
}

export async function triggerUnifiedSync(password?: string): Promise<{ started: boolean; error?: string }> {
  const response = await fetch("/api/ninerouter/sync-all", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders(password),
  });
  if (response.status === 401) throw new Error("Wrong control password");
  return response.json();
}

export async function triggerOptimizeAccountsBySpeed(password?: string): Promise<{ ok: boolean; updated?: number }> {
  const response = await fetch("/api/antigravity/optimize-by-speed", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders(password),
  });
  if (response.status === 401) throw new Error("Wrong control password");
  return response.json();
}
