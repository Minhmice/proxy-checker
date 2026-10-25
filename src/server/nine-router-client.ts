import "./load-env.js";
import {
  getSettingsSecrets,
  normalizeSingleNineRouterUrl,
  parseNineRouterUrls,
} from "./app-config.js";

import type {
  BindingUpdate,
  ConditionalUpdateResult,
  RouterBindingRevision,
} from "./antigravity-contract.js";
import type { TransportObservation } from "./antigravity-observation.js";
const authCookiesByUrl = new Map<string, string>();
const inFlightLoginsByUrl = new Map<string, Promise<string | null>>();

export interface NineRouterRequestOverrides {
  url?: string;
  password?: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface NineRouterResolvedConfig {
  url: string;
  urls: string[];
  password?: string;
  apiKey?: string;
}

function readConfig(overrides?: NineRouterRequestOverrides): NineRouterResolvedConfig {
  const stored = getSettingsSecrets();
  const rawUrl = overrides?.url ?? stored.nineRouterUrl;
  const urls = parseNineRouterUrls(rawUrl);
  const url = urls[0] ?? (rawUrl ? normalizeSingleNineRouterUrl(rawUrl) : "");
  const hasAuthOverride = Boolean(overrides?.password || overrides?.apiKey);
  return {
    url,
    urls,
    password: hasAuthOverride
      ? overrides?.password
      : (overrides?.password ?? stored.nineRouterPassword),
    apiKey: hasAuthOverride ? overrides?.apiKey : (overrides?.apiKey ?? stored.nineRouterApiKey),
  };
}

export function getNineRouterClientUrls(overrides?: { url?: string }): string[] {
  if (overrides?.url) {
    return parseNineRouterUrls(overrides.url);
  }
  const stored = getSettingsSecrets();
  return parseNineRouterUrls(stored.nineRouterUrl);
}

export function clearNineRouterSession(url?: string) {
  if (url) {
    try {
      const normalized = normalizeSingleNineRouterUrl(url);
      authCookiesByUrl.delete(url);
      authCookiesByUrl.delete(normalized);
      inFlightLoginsByUrl.delete(url);
      inFlightLoginsByUrl.delete(normalized);
    } catch {
      authCookiesByUrl.delete(url);
      inFlightLoginsByUrl.delete(url);
    }
  } else {
    authCookiesByUrl.clear();
    inFlightLoginsByUrl.clear();
  }
}

function combineSignals(timeoutMs = 10_000, callerSignal?: AbortSignal | null): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!callerSignal) return timeoutSignal;
  return AbortSignal.any([timeoutSignal, callerSignal]);
}

async function fetchWithSignal(
  input: string | URL | Request,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  if (!signal) {
    return fetch(input, init);
  }
  if (signal.aborted) {
    throw signal.reason;
  }
  let onAbort: (() => void) | undefined;
  const { promise: abortPromise, reject: rejectAbort } = Promise.withResolvers<never>();
  onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([fetch(input, { ...init, signal }), abortPromise]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function extractAuthCookie(response: Response): string | null {
  const setCookies =
    typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  for (const line of setCookies) {
    const match = line.match(/^auth_token=([^;]+)/);
    if (match) return `auth_token=${match[1]}`;
  }
  const single = response.headers.get("set-cookie");
  if (!single) return null;
  const match = single.match(/auth_token=([^;]+)/);
  return match ? `auth_token=${match[1]}` : null;
}

async function loginWithConfig(
  config: NineRouterResolvedConfig,
  cookieRef: { value: string | null },
  options?: { timeoutMs?: number; signal?: AbortSignal | null },
) {
  if (!config.password) throw new Error("9Router dashboard password is not configured");
  const key = config.url || "default";
  const existing = inFlightLoginsByUrl.get(key);
  if (existing) {
    const cookie = await existing;
    cookieRef.value = cookie;
    return;
  }

  const loginPromise = (async () => {
    const signal = combineSignals(options?.timeoutMs ?? 10_000, options?.signal);
    const response = await fetchWithSignal(
      `${config.url}/api/auth/login`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ password: config.password }),
      },
      signal,
    );
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
    const cookie = extractAuthCookie(response);
    if (!cookie) throw new Error("9Router login succeeded but no auth cookie was returned");
    if (config.url) {
      authCookiesByUrl.set(config.url, cookie);
    }
    return cookie;
  })();

  inFlightLoginsByUrl.set(key, loginPromise);
  try {
    const cookie = await loginPromise;
    cookieRef.value = cookie;
  } finally {
    inFlightLoginsByUrl.delete(key);
  }
}

async function buildHeaders(
  config: NineRouterResolvedConfig,
  cookieRef: { value: string | null },
  options?: { timeoutMs?: number; signal?: AbortSignal | null },
): Promise<Record<string, string>> {
  if (config.password) {
    if (!cookieRef.value) {
      const cached = config.url ? authCookiesByUrl.get(config.url) : null;
      if (cached) {
        cookieRef.value = cached;
      } else {
        await loginWithConfig(config, cookieRef, options);
      }
    }
    return {
      Cookie: cookieRef.value!,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }
  if (config.apiKey) {
    return {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }
  throw new Error("9Router password or API key is required");
}

function isReportedTransportFailure(body: Record<string, unknown>): boolean {
  return body.failureKind === "transport";
}

async function request<T>(
  path: string,
  options: RequestInit & { timeoutMs?: number } = {},
  retry = true,
  overrides?: NineRouterRequestOverrides,
  cookieRef?: { value: string | null },
  clientOptions?: { acceptStructuredError?: boolean },
): Promise<T> {
  const config = readConfig(overrides);
  const timeoutMs = options.timeoutMs ?? overrides?.timeoutMs ?? 10_000;
  const effectiveCookieRef = cookieRef ?? { value: authCookiesByUrl.get(config.url) ?? null };
  const headers = await buildHeaders(config, effectiveCookieRef, {
    timeoutMs,
    signal: options.signal,
  });
  const signal = combineSignals(timeoutMs, options.signal);
  const response = await fetchWithSignal(
    `${config.url}${path}`,
    {
      ...options,
      headers: { ...headers, ...(options.headers as Record<string, string>) },
    },
    signal,
  );
  const text = await response.text();
  let body: Record<string, unknown>;
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { error: text || response.statusText };
  }
  if (response.status === 401 && config.password && retry) {
    effectiveCookieRef.value = null;
    authCookiesByUrl.delete(config.url);
    await loginWithConfig(config, effectiveCookieRef, {
      timeoutMs,
      signal: options.signal,
    });
    return request<T>(path, options, false, overrides, effectiveCookieRef, clientOptions);
  }
  if (!response.ok) {
    if (clientOptions?.acceptStructuredError && typeof body.ok === "boolean") {
      return (isReportedTransportFailure(body) ? { ...body, failureKind: "transport" } : body) as T;
    }
    const message =
      (body.error as string) || (body.message as string) || `9Router API ${response.status}`;
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  if (effectiveCookieRef.value && config.url) {
    authCookiesByUrl.set(config.url, effectiveCookieRef.value);
  }
  return body as T;
}

export function nineRouterConfigured(overrides?: NineRouterRequestOverrides): boolean {
  const config = readConfig(overrides);
  return Boolean(config.password || config.apiKey);
}

export function nineRouterAuthMode(
  overrides?: NineRouterRequestOverrides,
): "password" | "api_key" | "none" {
  const config = readConfig(overrides);
  if (config.password) return "password";
  if (config.apiKey) return "api_key";
  return "none";
}

export interface EndpointConnectionResult {
  url: string;
  ok: boolean;
  poolCount?: number;
  error?: string;
}

export async function testNineRouterConnection(overrides?: {
  url?: string;
  password?: string;
  apiKey?: string;
}) {
  const config = readConfig(overrides);
  const targetUrls = config.urls.length > 0 ? config.urls : config.url ? [config.url] : [];
  if (targetUrls.length === 0) {
    return { ok: false as const, error: "No 9Router URL configured" };
  }
  if (targetUrls.length === 1) {
    const singleUrl = targetUrls[0];
    try {
      const body = await request<{ proxyPools?: unknown[] }>(
        "/api/proxy-pools?includeUsage=true",
        {},
        true,
        { ...overrides, url: singleUrl },
        { value: null },
      );
      const poolCount = body.proxyPools?.length ?? 0;
      return {
        ok: true as const,
        poolCount,
        endpoints: [{ url: singleUrl, ok: true, poolCount }],
      };
    } catch (error) {
      const message = (error as Error).message;
      return {
        ok: false as const,
        error: message,
        endpoints: [{ url: singleUrl, ok: false, error: message }],
      };
    }
  }

  // Multiple URLs: test all in parallel
  const results = await Promise.allSettled(
    targetUrls.map(async (url) => {
      const body = await request<{ proxyPools?: unknown[] }>(
        "/api/proxy-pools?includeUsage=true",
        {},
        true,
        { ...overrides, url },
        { value: null },
      );
      return { url, ok: true, poolCount: body.proxyPools?.length ?? 0 };
    }),
  );

  const endpoints: EndpointConnectionResult[] = results.map((res, idx) => {
    const url = targetUrls[idx];
    if (res.status === "fulfilled") {
      return res.value;
    }
    return { url, ok: false, error: (res.reason as Error).message };
  });

  const successful = endpoints.filter((e) => e.ok);
  if (successful.length === 0) {
    return {
      ok: false as const,
      error: endpoints.map((e) => `${e.url}: ${e.error}`).join("; "),
      endpoints,
    };
  }

  const totalPoolCount = successful.reduce((sum, e) => sum + (e.poolCount ?? 0), 0);
  return {
    ok: true as const,
    poolCount: totalPoolCount,
    partial: successful.length < endpoints.length,
    endpoints,
  };
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
  poolRevision?: number;
}

export async function listPools(overrides?: NineRouterRequestOverrides): Promise<NineRouterPool[]> {
  const body = await request<{ proxyPools?: NineRouterPool[] }>(
    "/api/proxy-pools?includeUsage=true",
    {},
    true,
    overrides,
  );
  return body.proxyPools ?? [];
}
export interface NineRouterTestResult {
  ok: boolean;
  failureKind?: "transport";
  status?: number;
  statusText?: string | null;
  error?: string | null;
  elapsedMs?: number;
  testedAt?: string;
}

export async function testPool(
  id: string,
  overrides?: NineRouterRequestOverrides,
): Promise<NineRouterTestResult> {
  const body = await request<NineRouterTestResult>(
    `/api/proxy-pools/${encodeURIComponent(id)}/test`,
    {
      method: "POST",
    },
    true,
    overrides,
    undefined,
    { acceptStructuredError: true },
  );
  return !body.ok && isReportedTransportFailure(body as unknown as Record<string, unknown>)
    ? { ...body, failureKind: "transport" }
    : body;
}

export async function setPoolActive(
  id: string,
  isActive: boolean,
  overrides?: NineRouterRequestOverrides,
) {
  const body = await request<{ proxyPool: unknown }>(
    `/api/proxy-pools/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      body: JSON.stringify({ isActive: isActive === true }),
    },
    true,
    overrides,
  );
  return body.proxyPool;
}

export async function bulkSetActive(
  updates: Array<{ id: string; isActive: boolean }>,
  delayMs = 80,
  overrides?: NineRouterRequestOverrides,
) {
  const results: Array<{ id: string; isActive: boolean; ok: boolean; error?: string }> = [];
  for (const { id, isActive } of updates) {
    try {
      await setPoolActive(id, isActive, overrides);
      results.push({ id, isActive, ok: true });
    } catch (error) {
      results.push({ id, isActive, ok: false, error: (error as Error).message });
    }
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return results;
}

export async function updatePool(
  id: string,
  patch: { name?: string; isActive?: boolean },
  overrides?: NineRouterRequestOverrides,
) {
  const body = await request<{ proxyPool?: unknown }>(
    `/api/proxy-pools/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      body: JSON.stringify(patch),
    },
    true,
    overrides,
  );
  return body.proxyPool ?? body;
}

export async function renamePool(id: string, name: string, overrides?: NineRouterRequestOverrides) {
  return updatePool(id, { name }, overrides);
}

export async function deletePool(id: string, overrides?: NineRouterRequestOverrides) {
  await request<unknown>(
    `/api/proxy-pools/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
    },
    true,
    overrides,
  );
}

export async function createPool(
  input: {
    name: string;
    proxyUrl: string;
    type: string;
    isActive: false;
  },
  overrides?: NineRouterRequestOverrides,
): Promise<{ id: string; name: string; proxyUrl: string; type?: string }> {
  const body = await request<{
    proxyPool: { id: string; name: string; proxyUrl: string; type?: string };
  }>(
    "/api/proxy-pools",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    true,
    overrides,
  );
  return body.proxyPool;
}

export interface NineRouterConnectionItem {
  id: string;
  provider: string;
  name?: string;
  email?: string;
  isActive?: boolean;
  testStatus?: string;
  lastError?: string | null;
  errorCode?: number | null;
  expiresAt?: string;
  lastUsedAt?: string;
  providerSpecificData?: {
    proxyPoolId?: string;
    [key: string]: unknown;
  };
}

export async function listAntigravityConnections(
  overrides?: NineRouterRequestOverrides & {
    page?: number;
    pageSize?: number;
  },
): Promise<NineRouterConnectionItem[]> {
  const pageSize = overrides?.pageSize ?? 50;
  const pageParam = overrides?.page !== undefined ? `&page=${overrides.page}` : "";
  const body = await request<{ connections?: NineRouterConnectionItem[] }>(
    `/api/providers/client?pageSize=${pageSize}${pageParam}&provider=antigravity`,
    {},
    true,
    overrides,
  );
  return body.connections ?? [];
}

export async function getAccountUsage(
  id: string,
  overrides?: NineRouterRequestOverrides,
): Promise<Record<string, unknown>> {
  return await request<Record<string, unknown>>(
    `/api/usage/${encodeURIComponent(id)}`,
    {},
    true,
    overrides,
  );
}

export async function updateConnection(
  id: string,
  patch: { isActive?: boolean; providerSpecificData?: Record<string, unknown> },
  overrides?: NineRouterRequestOverrides,
): Promise<{ connection?: unknown }> {
  return await request<{ connection?: unknown }>(
    `/api/providers/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      body: JSON.stringify(patch),
    },
    true,
    overrides,
  );
}

export async function getSafetyCapabilities(overrides?: NineRouterRequestOverrides) {
  return request<{
    protocolVersion: number;
    strictTls: boolean;
    conditionalBinding: boolean;
    nodeLocalAudit: boolean;
    ownershipConfigured: boolean;
  }>("/api/antigravity/safety-capabilities", {}, true, overrides);
}
export async function getConnectionBinding(id: string, overrides?: NineRouterRequestOverrides) {
  return request<RouterBindingRevision>(
    `/api/providers/${encodeURIComponent(id)}/binding`,
    {},
    true,
    overrides,
  );
}
export async function updateConnectionConditional(
  id: string,
  input: BindingUpdate,
  overrides?: NineRouterRequestOverrides,
): Promise<ConditionalUpdateResult> {
  try {
    return await request<ConditionalUpdateResult>(
      `/api/providers/${encodeURIComponent(id)}/binding`,
      { method: "PUT", body: JSON.stringify(input) },
      true,
      overrides,
    );
  } catch (error) {
    const status = (error as Error & { status?: number }).status;
    if (status === 404 || status === 503)
      return { status: "unsupported", reason: "Router conditional binding unavailable" };
    if (status === 409) return { status: "conflict", reason: "Binding or ownership changed" };
    throw error;
  }
}
export async function verifyConnectionQuota(
  id: string,
  input: { expectedRevision: number; expectedPoolId: string; expectedPoolRevision: number },
  overrides?: NineRouterRequestOverrides,
  signal?: AbortSignal,
) {
  return request<Record<string, unknown>>(
    `/api/providers/${encodeURIComponent(id)}/quota-verification`,
    { method: "POST", body: JSON.stringify(input), signal },
    true,
    overrides,
  );
}
export async function auditRouterGooglePool(
  poolId: string,
  expectedPoolRevision: number,
  overrides: NineRouterRequestOverrides,
) {
  const result = await request<{
    poolId: string;
    poolRevision: number;
    observations: Omit<TransportObservation, "routerUrl">[];
    complete: boolean;
  }>(
    `/api/proxy-pools/${encodeURIComponent(poolId)}/google-audit`,
    { method: "POST", body: JSON.stringify({ expectedPoolRevision }) },
    true,
    overrides,
  );
  return {
    ...result,
    observations: result.observations.map((o) => ({ ...o, routerUrl: overrides.url || "" })),
  };
}

export async function drainConnectionRoute(
  id: string,
  input: { operationId: string; expectedRevision: number; epoch: number },
  overrides: NineRouterRequestOverrides,
) {
  return request<{ drained: boolean; epoch: number; revision: number }>(
    `/api/providers/${encodeURIComponent(id)}/route-drain`,
    { method: "POST", body: JSON.stringify(input) },
    true,
    overrides,
  );
}
