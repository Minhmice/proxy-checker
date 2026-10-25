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
  {
    id: "server-vpn",
    name: "Tailscale Node (100.73.175.42)",
    url: "http://100.73.175.42:20128",
    host: "100.73.175.42",
  },
];

const nodeCookies = new Map<string, string>();
const inFlightLogins = new Map<string, Promise<string | null>>();

export function clearNodeCookies(): void {
  nodeCookies.clear();
}

export function getNodeInventory(): NineRouterNodeInfo[] {
  return KNOWN_NODES;
}

export function resolveNodeUrl(nodeId: string): string {
  const node = KNOWN_NODES.find((n) => n.id === nodeId);
  if (node) return node.url;
  const settings = getSettingsSecrets();
  return settings.nineRouterUrl?.split(",")[0]?.trim() || "http://192.168.1.54:20128";
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
    const pass = password || getSettingsSecrets().nineRouterPassword || "minh2908";
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
  const baseUrl = resolveNodeUrl(nodeId);
  const targetUrl = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

  let cookie = nodeCookies.get(nodeId);
  if (!cookie) {
    const newCookie = await loginToNode(baseUrl);
    if (newCookie) {
      cookie = newCookie;
      nodeCookies.set(nodeId, newCookie);
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
    nodeCookies.delete(nodeId);
    const newCookie = await loginToNode(baseUrl);
    if (newCookie) {
      nodeCookies.set(nodeId, newCookie);
      const retryHeaders = new Headers(options?.headers);
      retryHeaders.set("Cookie", newCookie);
      return fetch(targetUrl, {
        ...options,
        headers: retryHeaders,
        signal: options?.signal || AbortSignal.timeout(10000),
      });
    }
  }

  return res;
}
