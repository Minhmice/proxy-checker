export type Value = null | boolean | number | string | Value[] | { [key: string]: Value };
export type Resource = "pool" | "account" | "settings" | "role" | "history";
export type Outcome = "applied" | "rejected" | "conflicted" | "unsupported" | "unknown";
export type RunStatus = "verified" | "partial" | "conflicted" | "blocked" | "busy";
export type Accuracy = "exact" | "approximate" | "incomplete";

export interface Entity {
  key: string;
  resource: Resource;
  localId: string;
  fields: Record<string, Value>;
  revision: string | null;
}

export interface ScopeSnapshot {
  complete: boolean;
  entities: Entity[];
  cursor: string | null;
  observedAt: number;
  error: string | null;
}

export interface Snapshot {
  routerId: string;
  scopes: Record<Resource, ScopeSnapshot>;
}

export interface Baseline {
  resource: Resource;
  key: string;
  field: string;
  value: Value;
  deleted: boolean;
  revision: number;
}

export interface Operation {
  id: string;
  routerId: string;
  resource: Resource;
  key: string;
  field: string | null;
  kind: "create" | "update" | "delete";
  expected: Value;
  expectedRevision: string | null;
  desired: Value;
  dependsOn: string[];
}

export interface Conflict {
  id: string;
  resource: Resource;
  key: string;
  field: string | null;
  revision: number;
  reason: "divergent" | "delete-edit" | "identity" | "ownership" | "credential";
  base: Value;
  a: Value;
  b: Value;
}

export interface MergePlan {
  operations: Operation[];
  conflicts: Conflict[];
  incompleteScopes: Resource[];
}

export interface Capability {
  resource: Resource | "usage";
  read: boolean;
  export: boolean;
  write: boolean;
  conditional: boolean;
  evidence: string;
}

export interface UsageScope {
  accountKey: string;
  provider: string;
  model: string;
  metric: string;
  unit: string;
  currency: string | null;
  periodStart: string;
  periodEnd: string;
}

export interface UsageEvent {
  id: string;
  namespace: string;
  sourceRouterId: string;
  scope: UsageScope;
  amount: string;
  accuracy: Accuracy;
  provenance: "native" | "replicated";
  generation: string;
  cursor: string;
  observedAt: number;
}

export interface UsageWrite {
  operationId: string;
  routerId: string;
  scope: UsageScope;
  ledgerRevision: number;
  strategy: "absolute" | "delta";
  amount: string;
  expectedBoundary: string;
}

export interface Receipt {
  operationId: string;
  outcome: Outcome;
  boundary: string | null;
  evidence: string | null;
}

export interface RunRequest {
  mode: "audit" | "incremental" | "full";
  trigger: "manual" | "scheduled" | "change";
  now: number;
}

export interface RunReport {
  id: string;
  status: RunStatus;
  operations: Array<{ id: string; outcome: Outcome }>;
  conflicts: Conflict[];
  unmetCapabilities: string[];
  verifiedAt: number | null;
}

export interface SyncPolicy {
  enabled: boolean;
  usageWriteBackAuthorized: boolean;
  nextIncrementalAt: number;
  nextFullAt: number;
}

export interface SyncRepository {
  appendUsage(event: UsageEvent): boolean;
  listUsage(scope: UsageScope): UsageEvent[];
  saveBaseline(baseline: Baseline): void;
  listBaselines(): Baseline[];
  enqueue(operation: Operation): void;
  pendingOperations(): Operation[];
  saveConflict(conflict: Conflict): void;
  listConflicts(): Conflict[];
  resolveConflict(id: string, expectedRevision: number, value: Value): boolean;
  prepareWrite(write: UsageWrite): void;
  recordReceipt(receipt: Receipt): void;
  acquireLease(owner: string, now: number, ttl: number): number | null;
  renewLease(owner: string, epoch: number, now: number, ttl: number): boolean;
  releaseLease(owner: string, epoch: number): void;
  getPolicy(): SyncPolicy;
  savePolicy(policy: SyncPolicy): void;
  finishRun(report: RunReport): void;
  lastVerifiedRun(): RunReport | null;
  close(): void;
}

export interface RouterAdapter {
  readonly routerId: string;
  readonly url: string;
  capabilities(): Promise<Capability[]>;
  readState(): Promise<Snapshot>;
  apply(operation: Operation): Promise<Receipt>;
  readUsage(): Promise<UsageEvent[]>;
  writeUsage(write: UsageWrite): Promise<Receipt>;
  readReceipt(operationId: string): Promise<Receipt | null>;
}

export interface DualRouterCoordinator {
  run(request: RunRequest): Promise<RunReport>;
  resolve(input: { id: string; revision: number; value: Value; actor: string }): Promise<RunReport>;
  status(): Promise<RunReport | null>;
}

export interface DualRouterScheduler {
  tick(now: number): Promise<RunReport | null>;
}
