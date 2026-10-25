import { desc } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const proxies = sqliteTable(
  "proxies",
  {
    proxyKey: text("proxy_key").primaryKey(),
    endpoint: text("endpoint").notNull(),
    protocol: text("protocol").notNull(),
    host: text("host"),
    port: integer("port"),
    status: text("status").notNull().default("dead"),
    latencyMs: integer("latency_ms"),
    exitIp: text("exit_ip"),
    successes: integer("successes").notNull().default(0),
    failures: integer("failures").notNull().default(0),
    lastError: text("last_error"),
    checkedAt: integer("checked_at").notNull().default(0),
    source: text("source").notNull().default("legacy"),
    lifecycleState: text("lifecycle_state").notNull().default("unknown"),
    username: text("username"),
    password: text("password"),
    createdAt: integer("created_at"),
    updatedAt: integer("updated_at"),
    lastVerdict: text("last_verdict"),
    lastCheckedAt: integer("last_checked_at"),
    lastLatencyMs: integer("last_latency_ms"),
    lastExitIp: text("last_exit_ip"),
    lastFailureCode: text("last_failure_code"),
    everPassed: integer("ever_passed").notNull().default(0),
    isPinned: integer("is_pinned").notNull().default(0),
    tags: text("tags").notNull().default(""),
    remoteId: text("remote_id"),
    routerState: text("router_state").notNull().default("unmanaged"),
    removedAt: integer("removed_at"),
  },
  (table) => [
    index("proxies_lifecycle_idx").on(table.lifecycleState),
    index("proxies_source_idx").on(table.source),
    index("proxies_protocol_lifecycle_idx").on(table.protocol, table.lifecycleState),
    index("proxies_source_lifecycle_idx").on(table.source, table.lifecycleState),
    index("proxies_last_checked_idx").on(desc(table.lastCheckedAt)),
  ],
);

export const proxyTestHistory = sqliteTable(
  "proxy_test_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    proxyKey: text("proxy_key")
      .notNull()
      .references(() => proxies.proxyKey, { onDelete: "cascade" }),
    testedAt: integer("tested_at").notNull(),
    ok: integer("ok").notNull(),
    latencyMs: integer("latency_ms"),
    errorMessage: text("error_message"),
  },
  (table) => [index("idx_proxy_test_history_key").on(table.proxyKey, desc(table.testedAt))],
);

export const fleetManagedEndpoints = sqliteTable(
  "fleet_managed_endpoints",
  {
    nodeId: text("node_id").notNull(),
    endpointId: text("endpoint_id").notNull(),
    proxyKey: text("proxy_key")
      .notNull()
      .references(() => proxies.proxyKey, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    pendingCleanup: integer("pending_cleanup").notNull().default(0),
    ownedExclusive: integer("owned_exclusive").notNull().default(1),
  },
  (table) => [
    primaryKey({ columns: [table.nodeId, table.endpointId, table.proxyKey] }),
    index("idx_fleet_managed_proxy_key").on(table.proxyKey),
    index("idx_fleet_managed_node_id").on(table.nodeId),
  ],
);

export const googleTransportObservations = sqliteTable(
  "google_transport_observations",
  {
    routerUrl: text("router_url").notNull(),
    proxyPoolId: text("proxy_pool_id").notNull(),
    endpoint: text("endpoint").notNull(),
    poolRevision: integer("pool_revision").notNull(),
    status: text("status").notNull(),
    httpStatus: integer("http_status"),
    errorCode: text("error_code"),
    checkedAt: integer("checked_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.routerUrl, table.proxyPoolId, table.endpoint, table.poolRevision],
    }),
    index("idx_google_transport_expiry").on(table.expiresAt),
  ],
);
