import { getSettingsSecrets } from "./app-config.js";

export interface NineRouterNodeInfo {
  id: string;
  name: string;
  url: string;
  host: string;
}

export const KNOWN_NODES: NineRouterNodeInfo[] = [
  {
    id: "server-lan",
    name: "Master Node (192.168.1.54)",
    url: "http://192.168.1.54:20128",
    host: "192.168.1.54",
  },
];

const nodeCookies = new Map<string, string>();
const inFlightLogins = new Map<string, Promise<string | null>>();

export function clearNodeCookies(): void {
  nodeCookies.clear();
  inFlightLogins.clear();
}

export function getNodeInventory(): NineRouterNodeInfo[] {
  return KNOWN_NODES;
}

export function resolveNodeUrl(nodeId: string): string {
  const node = KNOWN_NODES.find((n) => n.id === nodeId);
  if (!node) {
    throw new Error(`Unknown 9Router node ID: "${nodeId}"`);
  }
  return node.url;
}

export function getNodeCandidateUrls(nodeId: string): string[] {
  const node = KNOWN_NODES.find((n) => n.id === nodeId);
  if (!node) {
    throw new Error(`Unknown 9Router node ID: "${nodeId}"`);
  }
  const routes: string[] = [];
  try {
    const settings = getSettingsSecrets();
    if (settings.nineRouterUrl) {
      const configured = settings.nineRouterUrl
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const raw of configured) {
        const normalized = raw.replace(/\/+$/, "");
        if (!routes.some((r) => r.replace(/\/+$/, "") === normalized)) {
          routes.push(raw);
        }
      }
    }
  } catch {
    // settings unavailable
  }

  for (const fallback of [node.url, "http://100.74.116.125:20128"]) {
    const normalized = fallback.replace(/\/+$/, "");
    if (!routes.some((r) => r.replace(/\/+$/, "") === normalized)) {
      routes.push(fallback);
    }
  }

  return routes;
}

function extractAuthCookie(res: Response): string | null {
  const setCookies: string[] =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : (res.headers.get("set-cookie") || "").split(/,(?=[^;]+=[^;]+)/);

  if (setCookies.length === 0) return null;

  for (const cookie of setCookies) {
    const part = cookie.split(";")[0]?.trim();
    if (part && part.startsWith("auth_token=")) {
      return part;
    }
  }

  const first = setCookies[0]?.split(";")[0]?.trim();
  return first || null;
}

async function loginToNode(nodeUrl: string, password?: string): Promise<string | null> {
  const existing = inFlightLogins.get(nodeUrl);
  if (existing) return existing;

  const loginPromise = (async () => {
    let pass = password;
    if (!pass) {
      try {
        pass = getSettingsSecrets().nineRouterPassword;
      } catch {
        // settings unavailable
      }
    }
    if (!pass) {
      return null;
    }
    try {
      const res = await fetch(`${nodeUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pass }),
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        return null;
      }

      return extractAuthCookie(res);
    } catch {
      return null;
    } finally {
      inFlightLogins.delete(nodeUrl);
    }
  })();

  inFlightLogins.set(nodeUrl, loginPromise);
  return loginPromise;
}

export async function fetchFromNode(
  nodeId: string,
  path: string,
  options?: RequestInit,
  retryAuth = true,
): Promise<Response> {
  const candidateUrls = getNodeCandidateUrls(nodeId);
  const method = (options?.method || "GET").toUpperCase();
  const isIdempotentRead = method === "GET" || method === "HEAD";
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  let lastError: unknown;

  for (let i = 0; i < candidateUrls.length; i++) {
    const baseUrl = candidateUrls[i].replace(/\/+$/, "");
    const targetUrl = `${baseUrl}${normalizedPath}`;

    try {
      let cookie = nodeCookies.get(baseUrl);
      if (!cookie) {
        const newCookie = await loginToNode(baseUrl);
        if (newCookie) {
          cookie = newCookie;
          nodeCookies.set(baseUrl, newCookie);
        }
      }

      const headers = new Headers(options?.headers);
      if (cookie) {
        headers.set("Cookie", cookie);
      }

      const res = await fetch(targetUrl, {
        ...options,
        headers,
        signal: options?.signal || AbortSignal.timeout(10000),
      });

      if (res.status === 401 && retryAuth) {
        nodeCookies.delete(baseUrl);
        const newCookie = await loginToNode(baseUrl);
        if (newCookie) {
          nodeCookies.set(baseUrl, newCookie);
          const retryHeaders = new Headers(options?.headers);
          retryHeaders.set("Cookie", newCookie);
          return await fetch(targetUrl, {
            ...options,
            headers: retryHeaders,
            signal: options?.signal || AbortSignal.timeout(10000),
          });
        }
      }

      return res;
    } catch (err) {
      lastError = err;
      // Never blindly replay mutations after ambiguous delivery
      if (!isIdempotentRead) {
        throw err;
      }
      // Retry alternate route on network error for idempotent reads
      if (i < candidateUrls.length - 1) {
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error(`Failed to fetch from node ${nodeId}`);
}
