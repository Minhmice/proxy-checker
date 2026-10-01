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
} from "./types";

const STORAGE_KEY = "minhmiceproxy-password";
const STORAGE_DATE_KEY = "minhmiceproxy-password-date";
const COOKIE_NAME = "minhmiceproxy-auth";
function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

export function authHeaders(password: string): HeadersInit {
  return {
    Authorization: `Basic ${btoa(`admin:${password}`)}`,
    "Content-Type": "application/json",
  };
}

export function getStoredPassword(): string | null {
  if (typeof window === "undefined") return null;
  if (sessionStorage.getItem(STORAGE_DATE_KEY) !== todayKey()) {
    sessionStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_DATE_KEY);
    document.cookie = `${COOKIE_NAME}=; path=/; max-age=0`;
    return null;
  }
  const pass = sessionStorage.getItem(STORAGE_KEY);
  if (pass) {
    document.cookie = `${COOKIE_NAME}=${encodeURIComponent(pass)}; path=/; max-age=86400; SameSite=Lax`;
  }
  return pass;
}

export function storePassword(password: string) {
  sessionStorage.setItem(STORAGE_KEY, password);
  sessionStorage.setItem(STORAGE_DATE_KEY, todayKey());
  if (typeof document !== "undefined") {
    document.cookie = `${COOKIE_NAME}=${encodeURIComponent(password)}; path=/; max-age=86400; SameSite=Lax`;
  }
}

export async function clearStoredPassword() {
  sessionStorage.removeItem(STORAGE_KEY);
  sessionStorage.removeItem(STORAGE_DATE_KEY);
  if (typeof document !== "undefined") {
    document.cookie = `${COOKIE_NAME}=; path=/; max-age=0`;
  }
}

export async function fetchStatus(password: string, signal?: AbortSignal): Promise<PoolStatus> {
  const response = await fetch("/api/ninerouter/status", { cache: "no-store", signal, headers: authHeaders(password) });
  if (response.status === 401) throw new Error("Wrong control password");
  if (!response.ok) throw new Error("Control service is unavailable");
  return response.json();
}

export async function fetchPools(password: string, tier?: string, signal?: AbortSignal): Promise<PoolRecord[]> {
  const query = tier ? `?tier=${tier}` : "";
  const response = await fetch(`/api/ninerouter/pools${query}`, {
    cache: "no-store",
    headers: authHeaders(password),
    signal,
  });
  if (response.status === 401) throw new Error("Wrong control password");
  if (!response.ok) throw new Error("Control service is unavailable");
  const body = await response.json();
  return body.pools ?? [];
}

export async function fetchMetrics(password: string, hours = 24, signal?: AbortSignal): Promise<MetricsSnapshot[]> {
  const response = await fetch(`/api/ninerouter/metrics?hours=${hours}`, {
    cache: "no-store",
    headers: authHeaders(password),
    signal,
  });
  if (response.status === 401) throw new Error("Wrong control password");
  if (!response.ok) throw new Error("Metrics unavailable");
  const body = await response.json();
  return body.snapshots ?? [];
}

export async function syncPools(password: string) {
  const response = await fetch("/api/ninerouter/sync", {
    method: "POST",
    headers: authHeaders(password),
  });
  if (response.status === 401) throw new Error("Wrong control password");
  if (!response.ok) throw new Error("Failed to start sync");
  return response.json();
}

export async function togglePool(password: string, id: string, isActive: boolean) {
  const response = await fetch("/api/ninerouter/activate", {
    method: "POST",
    headers: authHeaders(password),
    body: JSON.stringify({ id, isActive }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Toggle failed");
  return body.pool as PoolRecord;
}

export async function fetchDiagnosticFiles(password: string) {
  const response = await fetch("/api/diagnostics/files", { cache: "no-store", headers: authHeaders(password) });
  if (!response.ok) throw new Error(response.status === 401 ? "Wrong control password" : "Diagnostic files unavailable");
  return response.json() as Promise<{ files: Array<{ name: string; count: number }>; job: DiagnosticJob }>;
}

export async function fetchDiagnosticJob(password: string, signal?: AbortSignal) {
  const response = await fetch("/api/diagnostics/job", { cache: "no-store", signal, headers: authHeaders(password) });
  if (!response.ok) throw new Error(response.status === 401 ? "Wrong control password" : "Diagnostic job unavailable");
  return (await response.json()).job as DiagnosticJob;
}

export async function uploadDiagnosticFile(password: string, name: string, content: string) {
  const response = await fetch("/api/diagnostics/upload", { method: "POST", headers: authHeaders(password), body: JSON.stringify({ name, content }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not upload input list");
  return body as { name: string; count: number };
}


export async function renamePool(password: string, localId: string, name: string) {
  const response = await fetch(`/api/ninerouter/pools/${encodeURIComponent(localId)}`, { method: "PATCH", headers: authHeaders(password), body: JSON.stringify({ name: name.trim() }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not rename proxy");
  return body.pool as PoolRecord;
}

export async function removePool(password: string, localId: string) {
  const response = await fetch(`/api/ninerouter/pools/${encodeURIComponent(localId)}`, { method: "DELETE", headers: authHeaders(password) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not remove proxy");
  return body.pool as PoolRecord;
}


export async function runDiagnostics(password: string, options: { file: string; samplePercent?: number; sampleCount?: number }) {
  const response = await fetch("/api/diagnostics/run", { method: "POST", headers: authHeaders(password), body: JSON.stringify(options) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not start diagnostics");
  return body as { started: boolean };
}
export async function stopDiagnostics(password: string) {
  const response = await fetch("/api/diagnostics/cancel", {
    method: "POST",
    headers: authHeaders(password),
  });
  if (response.status === 401) throw new Error("Wrong control password");
  if (!response.ok) throw new Error("Could not stop diagnostics");
  return response.json() as Promise<{ stopped: boolean; job: DiagnosticJob }>;
}

export async function promoteDiagnostics(password: string, ids: string[]) {
  const response = await fetch("/api/diagnostics/promote", { method: "POST", headers: authHeaders(password), body: JSON.stringify({ ids }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not promote diagnostics");
  return body as { promoted: number; skipped: number; results: string[]; skippedIds: string[] };
}

export function formatTime(value: number | null): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

export async function fetchSettings(password: string, signal?: AbortSignal) {
  const response = await fetch("/api/settings", { cache: "no-store", signal, headers: authHeaders(password) });
  if (response.status === 401) throw new Error("Wrong control password");
  if (!response.ok) throw new Error("Settings unavailable");
  return response.json() as Promise<import("./types").SettingsResponse>;
}

export async function updateSettings(password: string, patch: SettingsUpdatePayload) {
  const response = await fetch("/api/settings", {
    method: "PUT",
    headers: authHeaders(password),
    body: JSON.stringify(patch),
  });
  const body = await response.json();
  if (response.status === 401) throw new Error("Wrong control password");
  if (!response.ok) throw new Error(body.error || "Could not save settings");
  return body as SettingsResponse;
}

export async function testNineRouterConnection(
  password: string,
  patch?: { nineRouterUrl?: string; nineRouterPassword?: string; nineRouterApiKey?: string }
) {
  const response = await fetch("/api/settings/test-ninerouter", {
    method: "POST",
    headers: authHeaders(password),
    body: JSON.stringify(patch ?? {}),
  });
  const body = await response.json();
  if (response.status === 401) throw new Error("Wrong control password");
  return body as NineRouterTestResult;
}

export async function downloadProxyExport(
  password: string,
  format: "txt" | "csv",
  includeCredentials = false
): Promise<{ blob: Blob; filename: string }> {
  const query = new URLSearchParams({
    format,
    includeCredentials: String(includeCredentials),
  });
  const response = await fetch(`/api/settings/proxy-export?${query.toString()}`, {
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
  password: string,
  params?: {
    status?: string;
    search?: string;
    protocol?: string;
    page?: number;
    pageSize?: number;
  },
  signal?: AbortSignal
): Promise<UnifiedProxyResponse> {
  const query = new URLSearchParams();
  if (params?.status) query.set("status", params.status);
  if (params?.search) query.set("search", params.search);
  if (params?.protocol) query.set("protocol", params.protocol);
  if (params?.page) query.set("page", String(params.page));
  if (params?.pageSize) query.set("pageSize", String(params.pageSize));

  const response = await fetch(`/api/proxies/unified?${query.toString()}`, {
    cache: "no-store",
    signal,
    headers: authHeaders(password),
  });
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
  password: string,
  proxyKey: string,
  signal?: AbortSignal
): Promise<{ proxy: UnifiedProxyItem; auditResult?: unknown }> {
  const response = await fetch("/api/proxies/check", {
    method: "POST",
    cache: "no-store",
    signal,
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
  password: string,
  proxyKey: string,
  signal?: AbortSignal
): Promise<{ history: UnifiedProxyHistoryEntry[] }> {
  const query = new URLSearchParams({ key: proxyKey });
  const response = await fetch(`/api/proxies/history?${query.toString()}`, {
    cache: "no-store",
    signal,
    headers: authHeaders(password),
  });
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
