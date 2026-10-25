import type { FleetRepository } from "./db.js";
import { getNineRouterClientUrls } from "../server/nine-router-client.js";
import {
  TARGET_NINEROUTER_SERVERS,
  type NineRouterServerTarget,
} from "../server/server-interactive-updater.js";

export interface ServerUpdateTargetInfo {
  id: string;
  name: string;
  host: string;
  username: string;
  currentVersion: string | null;
  hasUpdate: boolean;
  sshConfigured: boolean;
  reachable?: boolean;
  error?: string;
}
export interface RouterInstanceVersionInfo {
  url: string;
  currentVersion: string | null;
  hasUpdate: boolean;
  error?: string;
}

export interface FleetUpdateStatus {
  hasUpdate: boolean;
  latestVersion: string | null;
  checkedAt: number;
  sources: {
    npmLatest: string | null;
    routerInstances: RouterInstanceVersionInfo[];
  };
  targets: ServerUpdateTargetInfo[];
  nodes: Array<{
    id: string;
    name: string;
    role: string;
    status: string;
    ip: string;
    currentVersion: string | null;
    hasUpdate: boolean;
    sshConfigured: boolean;
  }>;
}

let cachedNpmVersion: { version: string | null; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Compare two semver strings (e.g. "0.5.109" vs "0.5.104").
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
export function compareSemver(a: string, b: string): number {
  if (!a || !b) return 0;
  const rawA = a.replace(/^[v^~]/, "").trim();
  const rawB = b.replace(/^[v^~]/, "").trim();

  // Split version and prerelease tag: e.g. "0.5.109-beta.1" -> ["0.5.109", "beta.1"]
  const [mainA, preA] = rawA.split("-", 2);
  const [mainB, preB] = rawB.split("-", 2);

  const partsA = (mainA || "").split(".").map((p) => parseInt(p, 10) || 0);
  const partsB = (mainB || "").split(".").map((p) => parseInt(p, 10) || 0);

  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const numA = partsA[i] ?? 0;
    const numB = partsB[i] ?? 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }

  // SemVer 2.0.0 rule: normal version has higher precedence than prerelease
  // 0.5.109 > 0.5.109-beta.1
  if (!preA && preB) return 1;
  if (preA && !preB) return -1;
  if (preA && preB) {
    return preA.localeCompare(preB, undefined, { numeric: true });
  }
  return 0;
}

/**
 * Fetch latest version of 9router from npm registry.
 */
export async function fetchNpmLatestVersion(options?: { force?: boolean }): Promise<string | null> {
  const now = Date.now();
  if (!options?.force && cachedNpmVersion && now - cachedNpmVersion.fetchedAt < CACHE_TTL_MS) {
    return cachedNpmVersion.version;
  }

  try {
    const res = await fetch("https://registry.npmjs.org/9router/latest", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      throw new Error(`npm registry returned status ${res.status}`);
    }
    const data = (await res.json()) as { version?: string };
    const version = typeof data.version === "string" ? data.version.trim() : null;
    if (version) {
      cachedNpmVersion = { version, fetchedAt: now };
    }
    return version;
  } catch (err) {
    if (cachedNpmVersion?.version) {
      return cachedNpmVersion.version;
    }
    return null;
  }
}

/**
 * Query a 9Router instance's /api/version endpoint.
 */
export async function fetchRouterInstanceVersion(url: string): Promise<RouterInstanceVersionInfo> {
  const normalizedUrl = url.replace(/\/+$/, "");
  try {
    const res = await fetch(`${normalizedUrl}/api/version`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      return {
        url: normalizedUrl,
        currentVersion: null,
        hasUpdate: false,
        error: `HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as {
      currentVersion?: string;
      latestVersion?: string;
      hasUpdate?: boolean;
    };
    return {
      url: normalizedUrl,
      currentVersion: data.currentVersion || null,
      hasUpdate: Boolean(data.hasUpdate),
    };
  } catch (err) {
    return {
      url: normalizedUrl,
      currentVersion: null,
      hasUpdate: false,
      error: (err as Error).message,
    };
  }
}

/**
 * Check update status across npm registry, 9Router instances, and the 2 dedicated servers.
 */
export async function checkFleet9RouterUpdate(deps: {
  repo: FleetRepository;
  urls?: string[];
  forceNpmRefresh?: boolean;
}): Promise<FleetUpdateStatus> {
  const defaultUrls = Array.from(
    new Set([
      ...getNineRouterClientUrls(),
      ...TARGET_NINEROUTER_SERVERS.map((s) => `http://${s.host}:20128`),
    ]),
  );
  const targetUrls = deps.urls && deps.urls.length > 0 ? deps.urls : defaultUrls;
  const [npmLatest, routerInstanceResults, fleetNodes] = await Promise.all([
    fetchNpmLatestVersion({ force: deps.forceNpmRefresh }),
    Promise.all(targetUrls.map((url) => fetchRouterInstanceVersion(url))),
    deps.repo.listNodes(),
  ]);

  let latestVersion = npmLatest;
  if (!latestVersion) {
    for (const inst of routerInstanceResults) {
      if (
        inst.currentVersion &&
        (!latestVersion || compareSemver(inst.currentVersion, latestVersion) > 0)
      ) {
        latestVersion = inst.currentVersion;
      }
    }
  }

  // 1. Evaluate the 2 dedicated target servers
  const targets: ServerUpdateTargetInfo[] = TARGET_NINEROUTER_SERVERS.map((server) => {
    // Find matching router instance for this server host
    const matchingRouter = routerInstanceResults.find((r) => r.url.includes(server.host));
    const currentVersion = matchingRouter?.currentVersion || null;
    const reachable = Boolean(
      matchingRouter && !matchingRouter.error && matchingRouter.currentVersion,
    );
    const isError = !reachable || Boolean(matchingRouter?.error);
    let hasUpdate = false;

    // NẾU MÁY LỖI / UNREACHABLE -> KHÔNG BÁO UPDATE
    if (!isError) {
      if (matchingRouter?.hasUpdate) {
        hasUpdate = true;
      } else if (latestVersion && currentVersion) {
        hasUpdate = compareSemver(latestVersion, currentVersion) > 0;
      }
    }

    return {
      id: server.id,
      name: server.name,
      host: server.host,
      username: server.username,
      currentVersion,
      hasUpdate,
      sshConfigured: Boolean(server.password || server.privateKey),
      reachable: !isError,
      error: matchingRouter?.error,
    };
  });
  // 2. Backward compatibility with fleet nodes
  const nodes = fleetNodes.map((node) => {
    const currentVersion = node.agent_version || null;
    let hasUpdate = false;
    if (latestVersion && currentVersion) {
      hasUpdate = compareSemver(latestVersion, currentVersion) > 0;
    }
    const ip = node.wireguard_ip || node.public_ip || "unknown";
    return {
      id: node.id,
      name: node.name,
      role: node.role,
      status: node.status,
      ip,
      currentVersion,
      hasUpdate,
      sshConfigured: Boolean(node.sshCredentialsSet),
    };
  });

  const anyRouterHasUpdate = routerInstanceResults.some((r) => {
    if (r.error || !r.currentVersion) return false;
    if (r.hasUpdate) return true;
    if (latestVersion && r.currentVersion) {
      return compareSemver(latestVersion, r.currentVersion) > 0;
    }
    return false;
  });

  // Chỉ những target hoạt động bình thường (không lỗi) mới tính hasUpdate
  const anyTargetHasUpdate = targets.some((t) => t.reachable && !t.error && t.hasUpdate);
  const hasUpdate = anyRouterHasUpdate || anyTargetHasUpdate;
  return {
    hasUpdate,
    latestVersion,
    checkedAt: Date.now(),
    sources: {
      npmLatest,
      routerInstances: routerInstanceResults,
    },
    targets,
    nodes,
  };
}
