import { desc } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const baselines = sqliteTable(
  "baselines",
  {
    resource: text("resource").notNull(),
    key: text("key").notNull(),
    field: text("field").notNull(),
    value: text("value").notNull(),
    deleted: integer("deleted").notNull().default(0),
    revision: integer("revision").notNull().default(1),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.resource, t.key, t.field] })],
);

export const operations = sqliteTable(
  "operations",
  {
    id: text("id").primaryKey(),
    routerId: text("router_id").notNull(),
    resource: text("resource").notNull(),
    key: text("key").notNull(),
    field: text("field"),
    kind: text("kind").notNull(),
    expected: text("expected"),
    expectedRevision: text("expected_revision"),
    desired: text("desired"),
    dependsOn: text("depends_on").notNull().default("[]"),
    status: text("status").notNull().default("pending"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_operations_status").on(t.status, t.createdAt)],
);

export const conflicts = sqliteTable(
  "conflicts",
  {
    id: text("id").primaryKey(),
    resource: text("resource").notNull(),
    key: text("key").notNull(),
    field: text("field"),
    revision: integer("revision").notNull(),
    reason: text("reason").notNull(),
    base: text("base"),
    a: text("a"),
    b: text("b"),
    resolved: integer("resolved").notNull().default(0),
    resolvedValue: text("resolved_value"),
    resolvedAt: integer("resolved_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_conflicts_resource_key").on(t.resource, t.key)],
);

export const usageEvents = sqliteTable(
  "usage_events",
  {
    id: text("id").notNull(),
    namespace: text("namespace").notNull(),
    sourceRouterId: text("source_router_id").notNull(),
    accountKey: text("account_key").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    metric: text("metric").notNull(),
    unit: text("unit").notNull(),
    currency: text("currency"),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    amount: text("amount").notNull(),
    accuracy: text("accuracy").notNull(),
    provenance: text("provenance").notNull(),
    generation: text("generation").notNull(),
    cursor: text("cursor").notNull(),
    observedAt: integer("observed_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sourceRouterId, t.namespace, t.id] }),
    index("idx_usage_events_scope").on(
      t.accountKey,
      t.provider,
      t.model,
      t.metric,
      t.unit,
      t.periodStart,
      t.periodEnd,
    ),
  ],
);

export const usageWrites = sqliteTable(
  "usage_writes",
  {
    operationId: text("operation_id").primaryKey(),
    routerId: text("router_id").notNull(),
    accountKey: text("account_key").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    metric: text("metric").notNull(),
    unit: text("unit").notNull(),
    currency: text("currency"),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    ledgerRevision: integer("ledger_revision").notNull(),
    strategy: text("strategy").notNull(),
    amount: text("amount").notNull(),
    expectedBoundary: text("expected_boundary").notNull(),
    status: text("status").notNull().default("prepared"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_usage_writes_status").on(t.status)],
);

export const receipts = sqliteTable("receipts", {
  operationId: text("operation_id").primaryKey(),
  outcome: text("outcome").notNull(),
  boundary: text("boundary"),
  evidence: text("evidence"),
  createdAt: integer("created_at").notNull(),
});

export const leases = sqliteTable("leases", {
  name: text("name").primaryKey(),
  owner: text("owner").notNull(),
  epoch: integer("epoch").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const runReports = sqliteTable(
  "run_reports",
  {
    id: text("id").primaryKey(),
    status: text("status").notNull(),
    reportJson: text("report_json").notNull(),
    verifiedAt: integer("verified_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_run_reports_verified").on(t.status, desc(t.verifiedAt))],
);

export const syncPolicy = sqliteTable("sync_policy", {
  id: text("id").primaryKey(),
  enabled: integer("enabled").notNull().default(1),
  usageWriteBackAuthorized: integer("usage_write_back_authorized").notNull().default(0),
  nextIncrementalAt: integer("next_incremental_at").notNull().default(0),
  nextFullAt: integer("next_full_at").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

export const proxyOwnership = sqliteTable("proxy_ownership", {
  endpointKey: text("endpoint_key").primaryKey(),
  routerId: text("router_id").notNull(),
  accountId: text("account_id").notNull(),
  operationId: text("operation_id").notNull(),
  epoch: integer("epoch").notNull(),
  bindingRevision: integer("binding_revision").notNull(),
  expiresAt: integer("expires_at").notNull(),
  state: text("state").notNull(),
});
export const proxyOwnershipOperations = sqliteTable("proxy_ownership_operations", {
  operationId: text("operation_id").primaryKey(),
  payload: text("payload").notNull(),
  result: text("result").notNull(),
});
export const proxyBindings = sqliteTable(
  "proxy_bindings",
  {
    routerId: text("router_id").notNull(),
    accountId: text("account_id").notNull(),
    endpointKey: text("endpoint_key").notNull(),
  },
  (table) => [primaryKey({ columns: [table.routerId, table.accountId] })],
);
