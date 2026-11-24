import "./load-env.js";
import {
  getSettingsSecrets,
  normalizeSingleNineRouterUrl,
  parseNineRouterUrls,
} from "./app-config.js";

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

async function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
  signal?.throwIfAborted();
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

async function request<T>(
  path: string,
  options: RequestInit & { timeoutMs?: number } = {},
  retry = true,
  overrides?: NineRouterRequestOverrides,
  cookieRef?: { value: string | null },
): Promise<T> {
  const config = readConfig(overrides);
  const timeoutMs = options.timeoutMs ?? overrides?.timeoutMs ?? 10_000;
  const effectiveCookieRef = cookieRef ?? { value: authCookiesByUrl.get(config.url) ?? null };
  const headers = await buildHeaders(config, effectiveCookieRef, {
    timeoutMs,
    signal: options.signal,
  });
  const method = (options.method ?? "GET").toUpperCase();
  // ponytail: one retry for reads only; mutations are never replayed (could double-apply).
  const attempts = method === "GET" ? 2 : 1;
  let response: Response | undefined;
  for (let attempt = 1; ; attempt++) {
    const signal = combineSignals(timeoutMs, options.signal);
    try {
      response = await fetchWithSignal(
        `${config.url}${path}`,
        {
          ...options,
          headers: { ...headers, ...(options.headers as Record<string, string>) },
        },
        signal,
      );
    } catch (error) {
      if (attempt >= attempts || signal.aborted) throw error;
      await delay(500, options.signal);
      continue;
    }
    if (attempt >= attempts || ![502, 503, 504].includes(response.status)) break;
    await response.body?.cancel();
    await delay(500, options.signal);
  }
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
    return request<T>(path, options, false, overrides, effectiveCookieRef);
  }
  if (!response.ok) {
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
  accountCount?: number;
  error?: string;
}

export async function testNineRouterConnection(overrides?: {
  url?: string;
  password?: string;
  apiKey?: string;
}): Promise<{
  ok: boolean;
  error?: string;
  accountCount?: number;
  partial?: boolean;
  endpoints?: EndpointConnectionResult[];
}> {
  const config = readConfig(overrides);
  const targetUrls = config.urls.length > 0 ? config.urls : config.url ? [config.url] : [];
  if (targetUrls.length === 0) {
    return { ok: false as const, error: "No 9Router URL configured" };
  }
  if (targetUrls.length === 1) {
    const singleUrl = targetUrls[0];
    try {
      const accounts = await listConnectionPages({ ...overrides, url: singleUrl }, { value: null });
      const accountCount = accounts.length;
      return {
        ok: true as const,
        accountCount,
        endpoints: [{ url: singleUrl, ok: true, accountCount }],
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
      const accounts = await listConnectionPages({ ...overrides, url }, { value: null });
      return { url, ok: true, accountCount: accounts.length };
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

  const totalAccountCount = successful.reduce((sum, e) => sum + (e.accountCount ?? 0), 0);
  return {
    ok: true as const,
    accountCount: totalAccountCount,
    partial: successful.length < endpoints.length,
    endpoints,
  };
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
  providerSpecificData?: Record<string, unknown>;
}

type ConnectionListOptions = NineRouterRequestOverrides & { page?: number; pageSize?: number };

async function listConnectionPages(
  overrides?: ConnectionListOptions,
  cookieRef?: { value: string | null },
): Promise<NineRouterConnectionItem[]> {
  const pageSize = overrides?.pageSize ?? 50;
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 500 ||
    (overrides?.page !== undefined && (!Number.isSafeInteger(overrides.page) || overrides.page < 1))
  ) {
    throw new Error("Invalid 9Router pagination options");
  }
  const accounts: NineRouterConnectionItem[] = [];
  const seen = new Set<string>();
  for (let page = overrides?.page ?? 1; ; page++) {
    const pageParam = page === 1 && overrides?.page === undefined ? "" : `&page=${page}`;
    const body = await request<{
      connections?: NineRouterConnectionItem[];
      pagination?: { page: number; total: number; totalPages: number };
    }>(
      `/api/providers/client?pageSize=${pageSize}${pageParam}&provider=antigravity`,
      {},
      true,
      overrides,
      cookieRef,
    );
    if (!Array.isArray(body.connections)) throw new Error("Invalid 9Router connections response");
    for (const account of body.connections) {
      if (typeof account.id !== "string" || !account.id || seen.has(account.id)) {
        throw new Error("Invalid or duplicate 9Router account in paginated response");
      }
      seen.add(account.id);
      accounts.push(account);
    }
    if (body.pagination) {
      const { page: currentPage, total, totalPages } = body.pagination;
      if (
        page === 1 &&
        currentPage === 1 &&
        total === 0 &&
        totalPages === 0 &&
        accounts.length === 0
      ) {
        return accounts;
      }
      if (
        currentPage !== page ||
        !Number.isSafeInteger(totalPages) ||
        totalPages < page ||
        !Number.isSafeInteger(total) ||
        total < 0
      )
        throw new Error("Invalid 9Router pagination response");
      if (overrides?.page !== undefined) return accounts;
      if (page === totalPages) {
        if (accounts.length !== total) throw new Error("Incomplete 9Router account pagination");
        return accounts;
      }
      if (body.connections.length === 0) throw new Error("Incomplete 9Router account pagination");
    } else if (overrides?.page !== undefined || body.connections.length < pageSize) {
      return accounts;
    }
  }
}

export async function listAntigravityConnections(
  overrides?: ConnectionListOptions,
): Promise<NineRouterConnectionItem[]> {
  return listConnectionPages(overrides);
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
  patch: { isActive?: boolean; providerSpecificData?: Record<string, unknown>; proxyPoolId?: null },
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
