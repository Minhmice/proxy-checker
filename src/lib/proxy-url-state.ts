export interface ProxyWorkspaceQuery {
  q: string;
  health: "all" | "working" | "regressed" | "dead";
  protocol: "all" | "http" | "https" | "socks4" | "socks5";
  source: string;
  sort: "health" | "lastChecked" | "latency" | "endpoint";
  direction: "asc" | "desc";
  page: number;
  pageSize: number;
}

export const DEFAULT_PROXY_QUERY: ProxyWorkspaceQuery = {
  q: "",
  health: "all",
  protocol: "all",
  source: "",
  sort: "health",
  direction: "asc",
  page: 1,
  pageSize: 50,
};

export function parseProxyQuery(queryString: string | URLSearchParams): ProxyWorkspaceQuery {
  const params = typeof queryString === "string" ? new URLSearchParams(queryString) : queryString;

  const rawHealth = params.get("health") || params.get("status") || "all";
  const health = ["all", "working", "regressed", "dead"].includes(rawHealth)
    ? (rawHealth as ProxyWorkspaceQuery["health"])
    : "all";

  const rawProto = params.get("protocol") || "all";
  const protocol = ["all", "http", "https", "socks4", "socks5"].includes(rawProto)
    ? (rawProto as ProxyWorkspaceQuery["protocol"])
    : "all";

  const rawSort = params.get("sort") || "health";
  const sort = ["health", "lastChecked", "latency", "endpoint"].includes(rawSort)
    ? (rawSort as ProxyWorkspaceQuery["sort"])
    : "health";

  const rawDir = params.get("direction") || "asc";
  const direction = rawDir === "desc" ? "desc" : "asc";

  const page = Math.max(1, Number(params.get("page") || "1") || 1);
  const pageSize = Math.max(1, Math.min(100, Number(params.get("pageSize") || "50") || 50));

  return {
    q: (params.get("q") || params.get("search") || "").trim(),
    health,
    protocol,
    source: (params.get("source") || "").trim(),
    sort,
    direction,
    page,
    pageSize,
  };
}

export function serializeProxyQuery(query: Partial<ProxyWorkspaceQuery>): string {
  const params = new URLSearchParams();

  if (query.q && query.q.trim()) {
    params.set("q", query.q.trim());
  }

  if (query.health && query.health !== "all") {
    params.set("health", query.health);
  }

  if (query.protocol && query.protocol !== "all") {
    params.set("protocol", query.protocol);
  }

  if (query.source && query.source.trim()) {
    params.set("source", query.source.trim());
  }

  if (query.sort && query.sort !== "health") {
    params.set("sort", query.sort);
  }

  if (query.direction && query.direction !== "asc") {
    params.set("direction", query.direction);
  }

  if (query.page && query.page > 1) {
    params.set("page", String(query.page));
  }

  if (query.pageSize && query.pageSize !== 50) {
    params.set("pageSize", String(query.pageSize));
  }

  return params.toString();
}
