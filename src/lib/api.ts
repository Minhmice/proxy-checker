import type {
  SettingsResponse,
  SettingsUpdatePayload,
  NineRouterTestResult,
  AntigravityRotatorSnapshot,
  AggregatedTokenUsage,
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
  if (signal?.aborted) return false;
  try {
    const response = await fetch("/api/auth/session", {
      cache: "no-store",
      credentials: "same-origin",
      signal,
    });
    if (signal?.aborted || !response.ok) return false;
    const body = await response.json();
    if (signal?.aborted) return false;
    return Boolean(body?.authenticated);
  } catch (err: unknown) {
    if (signal?.aborted || isAbortError(err)) return false;
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

export function formatTime(value: number | null): string {
  if (!value) return "Never";
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export async function fetchSettings(
  arg1?: string | AbortSignal,
  arg2?: AbortSignal,
): Promise<SettingsResponse> {
  const signal =
    arg1 instanceof AbortSignal ? arg1 : arg2 instanceof AbortSignal ? arg2 : undefined;
  const password = typeof arg1 === "string" ? arg1 : undefined;

  const defaultSettings: SettingsResponse = {
    settings: {
      controlPasswordSet: false,
      nineRouterPasswordSet: false,
      nineRouterApiKeySet: false,
      nineRouterUrl: "",
      antigravityRotatorEnabled: true,
      antigravityRotateMinutes: 10,
    },
    meta: { restartRequired: [], source: "settings" as const },
  };

  try {
    const response = await fetch("/api/settings", {
      cache: "no-store",
      signal,
      credentials: "same-origin",
      headers: authHeaders(password),
    });
    if (signal?.aborted) return defaultSettings;
    if (response.status === 401) throw new Error("Wrong control password");
    if (!response.ok) throw new Error("Settings unavailable");
    const data = await response.json();
    if (signal?.aborted) return defaultSettings;
    return data as SettingsResponse;
  } catch (err: unknown) {
    if (signal?.aborted || isAbortError(err)) {
      return defaultSettings;
    }
    throw err;
  }
}

export async function updateSettings(
  arg1: string | SettingsUpdatePayload,
  arg2?: SettingsUpdatePayload,
) {
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
  arg1?:
    | string
    | { nineRouterUrl?: string; nineRouterPassword?: string; nineRouterApiKey?: string },
  arg2?: { nineRouterUrl?: string; nineRouterPassword?: string; nineRouterApiKey?: string },
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

export async function fetchAntigravityStatus(
  arg1?: string | AbortSignal,
  arg2?: AbortSignal,
): Promise<AntigravityRotatorSnapshot | null> {
  const signal =
    arg1 instanceof AbortSignal ? arg1 : arg2 instanceof AbortSignal ? arg2 : undefined;
  const password = typeof arg1 === "string" ? arg1 : undefined;

  try {
    const response = await fetch("/api/antigravity/status", {
      cache: "no-store",
      signal,
      credentials: "same-origin",
      headers: authHeaders(password),
    });
    if (signal?.aborted || !response.ok) return null;
    const data = await response.json();
    if (signal?.aborted) return null;
    return data as AntigravityRotatorSnapshot;
  } catch (err: unknown) {
    if (signal?.aborted || isAbortError(err)) return null;
    throw err;
  }
}

export async function refreshAntigravityQuota(
  password?: string,
): Promise<{ started: boolean; snapshot?: AntigravityRotatorSnapshot }> {
  const response = await fetch("/api/antigravity/refresh", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders(password),
  });
  if (response.status === 401) throw new Error("Wrong control password");
  if (!response.ok) throw new Error("Failed to refresh Antigravity quotas");
  return response.json();
}

export async function rotateAntigravityAccounts(
  password?: string,
): Promise<{ ok: boolean; snapshot?: AntigravityRotatorSnapshot; error?: string }> {
  const response = await fetch("/api/antigravity/rotate", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders(password),
  });
  if (response.status === 401) throw new Error("Wrong control password");
  return response.json();
}

export async function updateNodeConnection(
  nodeId: string,
  connectionId: string,
  isActive: boolean,
  password?: string,
): Promise<{ ok: boolean; error?: string }> {
  const response = await fetch(
    `/api/ninerouter/nodes/${encodeURIComponent(nodeId)}/connections/${encodeURIComponent(connectionId)}`,
    {
      method: "PUT",
      credentials: "same-origin",
      headers: authHeaders(password),
      body: JSON.stringify({ isActive }),
    },
  );
  if (response.status === 401) throw new Error("Wrong control password");
  return response.json();
}

export interface BackupStatusResponse {
  ok: boolean;
  status?: {
    lastBackupTime: number | null;
    lastCommitSha: string | null;
    lastCommitMessage: string | null;
    backupFileCount: number;
    hasUncommittedChanges: boolean;
    lastSyncError?: string;
  };
  error?: string;
}

export async function fetchBackupStatus(password?: string): Promise<BackupStatusResponse> {
  const response = await fetch("/api/backup/status", {
    credentials: "same-origin",
    headers: authHeaders(password),
  });
  if (response.status === 401) throw new Error("Wrong control password");
  return response.json();
}

export async function triggerBackupSync(
  push = true,
  password?: string,
): Promise<{
  ok: boolean;
  git?: {
    changed: boolean;
    committed: boolean;
    commitSha?: string;
    pushed: boolean;
    pushError?: string;
  };
  error?: string;
}> {
  const response = await fetch("/api/backup/sync", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders(password),
    body: JSON.stringify({ push }),
  });
  if (response.status === 401) throw new Error("Wrong control password");
  return response.json();
}

export async function restoreBackup(
  password?: string,
): Promise<{ ok: boolean; restoredFiles?: string[]; errors?: string[]; error?: string }> {
  const response = await fetch("/api/backup/restore", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders(password),
  });
  if (response.status === 401) throw new Error("Wrong control password");
  return response.json();
}

export async function fetchTokenUsage(
  arg1?: string,
  arg2?: string,
  arg3?: string | AbortSignal,
  arg4?: AbortSignal,
): Promise<AggregatedTokenUsage> {
  let password: string | undefined;
  let period = "today";
  let nodeId: string | undefined;
  let signal: AbortSignal | undefined;

  if (arg1 && ["today", "24h", "7d", "30d", "all"].includes(arg1)) {
    period = arg1;
    nodeId = typeof arg2 === "string" ? arg2 : undefined;
    signal = arg3 instanceof AbortSignal ? arg3 : undefined;
  } else {
    password = arg1;
    if (arg2) period = arg2;
    if (typeof arg3 === "string") nodeId = arg3;
    else if (arg3 instanceof AbortSignal) signal = arg3;
    if (arg4 instanceof AbortSignal) signal = arg4;
  }

  const params = new URLSearchParams({ period });
  if (nodeId && nodeId !== "all") params.set("nodeId", nodeId);

  // 1. Try unified aggregate endpoint
  try {
    const response = await fetch(`/api/ninerouter/stats?${params.toString()}`, {
      cache: "no-store",
      signal,
      credentials: "same-origin",
      headers: authHeaders(password),
    });

    if (response.ok) {
      return await response.json();
    }
  } catch (err) {
    if (signal?.aborted || isAbortError(err)) throw err;
  }

  // 2. Fallback: Query Pi Master node (server-lan) if aggregate route is unreachable or 404
  const targetNode = nodeId && nodeId !== "all" ? nodeId : "server-lan";
  const fallbackUrl = `/api/ninerouter/nodes/${encodeURIComponent(targetNode)}/stats?period=${encodeURIComponent(period)}`;
  const fallbackRes = await fetch(fallbackUrl, {
    cache: "no-store",
    signal,
    credentials: "same-origin",
    headers: authHeaders(password),
  });

  if (!fallbackRes.ok) {
    throw new Error(`Failed to fetch token usage: ${fallbackRes.status}`);
  }

  const raw = await fallbackRes.json();
  const prompt = Number(raw.totalPromptTokens) || 0;
  const comp = Number(raw.totalCompletionTokens) || 0;
  const cached = Number(raw.totalCachedTokens) || 0;
  const reqs = Number(raw.totalRequests) || 0;
  const cost = Number(raw.totalCost) || 0;

  return {
    period,
    totalRequests: reqs,
    totalPromptTokens: prompt,
    totalCompletionTokens: comp,
    totalCachedTokens: cached,
    totalTokens: prompt + comp + cached,
    totalCost: cost,
    byModel: raw.byModel || {},
    nodes: [
      {
        id: targetNode,
        name: "Raspberry Pi (server-lan)",
        url: "http://192.168.1.54:20128",
        online: true,
        totalTokens: prompt + comp + cached,
        requests: reqs,
      },
    ],
  };
}
