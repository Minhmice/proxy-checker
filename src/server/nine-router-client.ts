import "./load-env.js";
import { getSettingsSecrets } from "./app-config.js";

let authCookie: string | null = null;

function readConfig(overrides?: { url?: string; password?: string; apiKey?: string }) {
  const stored = getSettingsSecrets();
  return {
    url: (overrides?.url ?? stored.nineRouterUrl).replace(/\/$/, ""),
    password: overrides?.password ?? stored.nineRouterPassword,
    apiKey: overrides?.apiKey ?? stored.nineRouterApiKey,
  };
}

export function clearNineRouterSession() {
  authCookie = null;
}

function extractAuthCookie(response: Response): string | null {
  const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  for (const line of setCookies) {
    const match = line.match(/^auth_token=([^;]+)/);
    if (match) return `auth_token=${match[1]}`;
  }
  const single = response.headers.get("set-cookie");
  if (!single) return null;
  const match = single.match(/auth_token=([^;]+)/);
  return match ? `auth_token=${match[1]}` : null;
}

async function loginWithConfig(config: ReturnType<typeof readConfig>, cookieRef: { value: string | null }) {
  if (!config.password) throw new Error("9Router dashboard password is not configured");
  const response = await fetch(`${config.url}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ password: config.password }),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { error: text || response.statusText };
  }
  if (!response.ok) {
    const message = (body.error as string) || `9Router login failed (${response.status})`;
    throw new Error(message);
  }
  cookieRef.value = extractAuthCookie(response);
  if (!cookieRef.value) throw new Error("9Router login succeeded but no auth cookie was returned");
}

async function buildHeaders(config: ReturnType<typeof readConfig>, cookieRef: { value: string | null }): Promise<Record<string, string>> {
  if (config.password) {
    if (!cookieRef.value) await loginWithConfig(config, cookieRef);
    return { Cookie: cookieRef.value!, "Content-Type": "application/json", Accept: "application/json" };
  }
  if (config.apiKey) {
    return { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", Accept: "application/json" };
  }
  throw new Error("9Router password or API key is required");
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  retry = true,
  overrides?: { url?: string; password?: string; apiKey?: string },
  cookieRef: { value: string | null } = { value: authCookie },
  clientOptions?: { acceptStructuredError?: boolean }
): Promise<T> {
  const config = readConfig(overrides);
  const response = await fetch(`${config.url}${path}`, {
    ...options,
    headers: { ...(await buildHeaders(config, cookieRef)), ...(options.headers as Record<string, string>) },
  });
  const text = await response.text();
  let body: Record<string, unknown>;
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { error: text || response.statusText };
  }
  if (response.status === 401 && config.password && retry) {
    cookieRef.value = null;
    await loginWithConfig(config, cookieRef);
    return request<T>(path, options, false, overrides, cookieRef);
  }
  if (!response.ok) {
    if (clientOptions?.acceptStructuredError && typeof body.ok === "boolean") {
      return body as T;
    }
    const message = (body.error as string) || (body.message as string) || `9Router API ${response.status}`;
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  if (!overrides) authCookie = cookieRef.value;
  return body as T;
}

export function nineRouterConfigured(): boolean {
  const config = readConfig();
  return Boolean(config.password || config.apiKey);
}

export function nineRouterAuthMode(): "password" | "api_key" | "none" {
  const config = readConfig();
  if (config.password) return "password";
  if (config.apiKey) return "api_key";
  return "none";
}

export async function testNineRouterConnection(overrides?: { url?: string; password?: string; apiKey?: string }) {
  try {
    const body = await request<{ proxyPools?: unknown[] }>(
      "/api/proxy-pools?includeUsage=true",
      {},
      true,
      overrides,
      { value: null }
    );
    return { ok: true as const, poolCount: body.proxyPools?.length ?? 0 };
  } catch (error) {
    return { ok: false as const, error: (error as Error).message };
  }
}

export interface NineRouterPool {
  id: string;
  name: string;
  proxyUrl: string;
  type?: string;
  isActive?: boolean;
  testStatus?: string | null;
  lastError?: string | null;
  lastTestedAt?: string | null;
}

export async function listPools(): Promise<NineRouterPool[]> {
  const body = await request<{ proxyPools?: NineRouterPool[] }>(
    "/api/proxy-pools?includeUsage=true"
  );
  return body.proxyPools ?? [];
}
export interface NineRouterTestResult {
  ok: boolean;
  status?: number;
  statusText?: string | null;
  error?: string | null;
  elapsedMs?: number;
  testedAt?: string;
}

export async function testPool(id: string): Promise<NineRouterTestResult> {
  const body = await request<NineRouterTestResult>(
    `/api/proxy-pools/${encodeURIComponent(id)}/test`,
    {
      method: "POST",
    },
    true,
    undefined,
    undefined,
    { acceptStructuredError: true }
  );
  return body;
}

export async function setPoolActive(id: string, isActive: boolean) {
  const body = await request<{ proxyPool: unknown }>(`/api/proxy-pools/${id}`, {
    method: "PUT",
    body: JSON.stringify({ isActive: isActive === true }),
  });
  return body.proxyPool;
}

export async function bulkSetActive(updates: Array<{ id: string; isActive: boolean }>, delayMs = 80) {
  const results: Array<{ id: string; isActive: boolean; ok: boolean; error?: string }> = [];
  for (const { id, isActive } of updates) {
    try {
      await setPoolActive(id, isActive);
      results.push({ id, isActive, ok: true });
    } catch (error) {
      results.push({ id, isActive, ok: false, error: (error as Error).message });
    }
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return results;
}

export async function updatePool(id: string, patch: { name?: string; isActive?: boolean }) {
  const body = await request<{ proxyPool?: unknown }>(`/api/proxy-pools/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
  return body.proxyPool ?? body;
}

export async function deletePool(id: string) {
  await request<unknown>(`/api/proxy-pools/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function createPool(input: { name: string; proxyUrl: string; type: string; isActive: false }): Promise<{ id: string; name: string; proxyUrl: string; type?: string }> {
  const body = await request<{ proxyPool: { id: string; name: string; proxyUrl: string; type?: string } }>(
    "/api/proxy-pools",
    {
      method: "POST",
      body: JSON.stringify(input),
    }
  );
  return body.proxyPool;
}
