import type { AntigravityConnection } from "@/components/ninerouter/account-bindings-table";
import type { ProxyPoolItem } from "@/components/ninerouter/proxy-pools-table";

export type FilterType = "all" | "active" | "bound" | "unbound";
export type LoadState = "loading" | "ready" | "error";

export interface ProxyBindingState {
  selectedNode: string;
  generation: number;
  connections: AntigravityConnection[];
  pools: ProxyPoolItem[];
  selectedConnectionId: string | null;
  loadState: LoadState;
  loadError: string | null;
  testResults: Record<string, { ok: boolean; elapsedMs?: number; error?: string }>;
  testingMap: Record<string, boolean>;
}

export function createInitialBindingState(defaultNode = "server-lan"): ProxyBindingState {
  return {
    selectedNode: defaultNode,
    generation: 0,
    connections: [],
    pools: [],
    selectedConnectionId: null,
    loadState: "loading",
    loadError: null,
    testResults: {},
    testingMap: {},
  };
}

export function reduceNodeSwitch(state: ProxyBindingState, nextNode: string): ProxyBindingState {
  if (state.selectedNode === nextNode) return state;

  return {
    ...state,
    selectedNode: nextNode,
    generation: state.generation + 1,
    connections: [],
    pools: [],
    selectedConnectionId: null,
    loadState: "loading",
    loadError: null,
    testResults: {},
    testingMap: {},
  };
}

export function reduceNodeLoadSuccess(
  state: ProxyBindingState,
  payload: {
    generation: number;
    nodeId: string;
    connections: AntigravityConnection[];
    pools: ProxyPoolItem[];
  },
): ProxyBindingState {
  // Discard stale responses from prior generations or previous nodes
  if (payload.generation !== state.generation || payload.nodeId !== state.selectedNode) {
    return state;
  }

  return {
    ...state,
    connections: payload.connections,
    pools: payload.pools,
    loadState: "ready",
    loadError: null,
  };
}

export function reduceNodeLoadError(
  state: ProxyBindingState,
  payload: {
    generation: number;
    nodeId: string;
    error: string;
  },
): ProxyBindingState {
  if (payload.generation !== state.generation || payload.nodeId !== state.selectedNode) {
    return state;
  }

  return {
    ...state,
    connections: [],
    pools: [],
    loadState: "error",
    loadError: payload.error,
  };
}

export function filterConnections(
  connections: AntigravityConnection[],
  criteria: { query?: string; filter?: FilterType },
): AntigravityConnection[] {
  const query = (criteria.query || "").trim().toLowerCase();
  const filter = criteria.filter || "all";

  return connections.filter((conn) => {
    const matchesSearch =
      !query ||
      (conn.email && conn.email.toLowerCase().includes(query)) ||
      (conn.name && conn.name.toLowerCase().includes(query)) ||
      conn.id.toLowerCase().includes(query);

    if (!matchesSearch) return false;

    if (filter === "active") {
      return conn.isActive !== false;
    }
    if (filter === "bound") {
      return Boolean(conn.providerSpecificData?.proxyPoolId);
    }
    if (filter === "unbound") {
      return !conn.providerSpecificData?.proxyPoolId;
    }
    return true;
  });
}

export function filterPools(
  pools: ProxyPoolItem[],
  boundPoolIdSet: Set<string>,
  criteria: { query?: string; filter?: FilterType },
): ProxyPoolItem[] {
  const query = (criteria.query || "").trim().toLowerCase();
  const filter = criteria.filter || "all";

  return pools.filter((pool) => {
    const matchesSearch =
      !query ||
      (pool.name && pool.name.toLowerCase().includes(query)) ||
      (pool.proxyUrl && pool.proxyUrl.toLowerCase().includes(query)) ||
      pool.id.toLowerCase().includes(query);

    if (!matchesSearch) return false;

    if (filter === "active") {
      return pool.isActive;
    }
    if (filter === "bound") {
      return boundPoolIdSet.has(pool.id);
    }
    if (filter === "unbound") {
      return !boundPoolIdSet.has(pool.id);
    }
    return true;
  });
}

export function resolveSelectionVisibility(
  filteredConnections: AntigravityConnection[],
  selectedId: string | null,
): { hasSelection: boolean; isVisibleInView: boolean; selectedId: string | null } {
  if (!selectedId) {
    return { hasSelection: false, isVisibleInView: false, selectedId: null };
  }
  const isVisible = filteredConnections.some((c) => c.id === selectedId);
  return {
    hasSelection: true,
    isVisibleInView: isVisible,
    selectedId,
  };
}

export interface PoolAssignmentState {
  isCurrent: boolean;
  canAssign: boolean;
  isInactive?: boolean;
  label: string;
}

export function resolvePoolAssignmentState(
  pool: ProxyPoolItem,
  currentPoolId?: string | null,
): PoolAssignmentState {
  if (pool.id === currentPoolId) {
    return {
      isCurrent: true,
      canAssign: false,
      label: "Currently Assigned",
    };
  }

  if (pool.isActive === false) {
    return {
      isCurrent: false,
      canAssign: true,
      isInactive: true,
      label: "Assign Inactive",
    };
  }

  return {
    isCurrent: false,
    canAssign: true,
    label: "Assign",
  };
}

export interface BindingContextInfo {
  accountLabel: string;
  accountSub: string;
  poolName: string;
  isBound: boolean;
  nodeName: string;
}

export function resolveBindingContext(
  account: AntigravityConnection | null | undefined,
  poolMap: Record<string, { name: string; url: string; index?: number }>,
  nodeName: string,
): BindingContextInfo | null {
  if (!account) return null;

  const accountLabel = account.email || account.name || account.id;
  const shortId = account.id.length > 14 ? `${account.id.slice(0, 14)}...` : account.id;
  const accountSub = `ID: ${shortId}`;

  const poolId = account.providerSpecificData?.proxyPoolId;
  const boundPool = poolId ? poolMap[poolId] : null;

  const isBound = Boolean(boundPool);
  const poolName = boundPool
    ? boundPool.name || `Proxy #${boundPool.index ?? "Pool"}`
    : "Direct (No Proxy)";

  return {
    accountLabel,
    accountSub,
    poolName,
    isBound,
    nodeName,
  };
}

export interface AutoBindPlanResult {
  assignments: Array<{ connectionId: string; poolId: string }>;
  skippedCount: number;
  unmetCapacity: number;
}

export function calculateAutoBindPlan(
  connections: AntigravityConnection[],
  pools: ProxyPoolItem[],
  options: { onlyUnassigned: boolean },
): AutoBindPlanResult {
  const activePools = pools.filter((p) => p.isActive !== false);

  // In-use pool IDs
  const inUsePoolIds = new Set<string>();
  for (const conn of connections) {
    const boundId = conn.providerSpecificData?.proxyPoolId;
    if (boundId) {
      inUsePoolIds.add(boundId);
    }
  }

  // Eligible pools for new assignments
  const availablePools = options.onlyUnassigned
    ? activePools.filter((p) => !inUsePoolIds.has(p.id))
    : [...activePools];

  // Target accounts
  const targetAccounts = options.onlyUnassigned
    ? connections.filter((c) => !c.providerSpecificData?.proxyPoolId)
    : connections;

  const skippedCount = connections.length - targetAccounts.length;
  const assignments: Array<{ connectionId: string; poolId: string }> = [];

  const maxAssign = Math.min(targetAccounts.length, availablePools.length);
  for (let i = 0; i < maxAssign; i++) {
    const acc = targetAccounts[i];
    const pool = availablePools[i];
    if (acc && pool) {
      assignments.push({ connectionId: acc.id, poolId: pool.id });
    }
  }

  const unmetCapacity = Math.max(0, targetAccounts.length - availablePools.length);

  return {
    assignments,
    skippedCount,
    unmetCapacity,
  };
}

export interface PoolLifecycleBadgeInfo {
  label: "Active" | "Inactive" | "Fallback" | "Dead";
  tone: "success" | "muted" | "warning" | "error";
}

export function resolvePoolLifecycleBadge(pool: ProxyPoolItem): PoolLifecycleBadgeInfo {
  if (pool.isActive === false) {
    return { label: "Inactive", tone: "muted" };
  }
  if (pool.type === "dead") {
    return { label: "Dead", tone: "error" };
  }
  if (pool.type === "fallback" || pool.name.toLowerCase().includes("fallback")) {
    return { label: "Fallback", tone: "warning" };
  }
  return { label: "Active", tone: "success" };
}

export interface PoolLatencyDisplayInfo {
  label: string;
  state: "testing" | "ok" | "failed" | "untested" | "recorded";
  error?: string;
}

export function resolvePoolLatencyDisplay(
  pool: ProxyPoolItem,
  isTesting: boolean,
  testResult?: { ok: boolean; elapsedMs?: number; error?: string },
): PoolLatencyDisplayInfo {
  if (isTesting) {
    return { label: "Pinging...", state: "testing" };
  }

  if (testResult) {
    if (testResult.ok && typeof testResult.elapsedMs === "number") {
      return { label: `${testResult.elapsedMs}ms`, state: "ok" };
    }
    const lower = (testResult.error || "").toLowerCase();
    const errText = lower.includes("time")
      ? "Timeout"
      : testResult.error && testResult.error.length <= 12
        ? testResult.error
        : "Failed";
    return { label: errText, state: "failed", error: testResult.error };
  }

  if (typeof pool.latencyMs === "number" && pool.latencyMs > 0) {
    return { label: `${pool.latencyMs}ms`, state: "recorded" };
  }

  return { label: "—", state: "untested" };
}
