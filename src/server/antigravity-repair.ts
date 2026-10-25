import crypto from "node:crypto";
import * as router from "./nine-router-client.js";
import { classifyQuotaResponse, proxyEndpointKey } from "./antigravity-observation.js";
import type {
  BindingUpdate,
  ConditionalUpdateResult,
  RouterBindingRevision,
} from "./antigravity-contract.js";
import type { ProxyOwnershipAuthority } from "./antigravity-ownership.js";

export interface RepairRequest {
  routerUrl: string;
  routerId: string;
  accountId: string;
  operationId: string;
  cause:
    | "unsafe_transport"
    | "verified_proxy_denial"
    | "manual_quota_diagnostic"
    | "quota_forbidden";
  signal: AbortSignal;
}
export interface RepairResult {
  status:
    | "repaired"
    | "no_candidate"
    | "conflict"
    | "verification_failed"
    | "unsupported"
    | "not_applicable"
    | "aborted";
  reason?: string;
  binding?: RouterBindingRevision;
  verifiedAt?: number;
}
export interface RepairDependencies {
  capabilities: () => Promise<{
    protocolVersion: number;
    conditionalBinding: boolean;
    ownershipConfigured: boolean;
  }>;
  binding: () => Promise<RouterBindingRevision>;
  pools: () => Promise<router.NineRouterPool[]>;
  audit: (pool: router.NineRouterPool) => Promise<{ complete: boolean; observations: unknown[] }>;
  update: (input: BindingUpdate) => Promise<ConditionalUpdateResult>;
  verify: (
    binding: RouterBindingRevision,
    pool: router.NineRouterPool,
  ) => Promise<Record<string, unknown>>;
  authority?: ProxyOwnershipAuthority;
}
const activeRepairs = new Map<string, Promise<RepairResult>>();
export function repairAntigravityRoute(
  input: RepairRequest,
  deps?: RepairDependencies,
): Promise<RepairResult> {
  const key = `${input.routerUrl}:${input.accountId}`;
  const pending = activeRepairs.get(key);
  if (pending) return Promise.resolve({ status: "conflict", reason: "Account repair in progress" });
  const target = { url: input.routerUrl };
  const io: RepairDependencies = deps || {
    capabilities: () => router.getSafetyCapabilities(target),
    binding: () => router.getConnectionBinding(input.accountId, target),
    pools: () => router.listPools(target),
    audit: (p) => router.auditRouterGooglePool(p.id, p.poolRevision || 1, target),
    update: (update) => router.updateConnectionConditional(input.accountId, update, target),
    verify: (binding, pool) =>
      router.verifyConnectionQuota(
        input.accountId,
        {
          expectedRevision: binding.revision,
          expectedPoolId: pool.id,
          expectedPoolRevision: pool.poolRevision || 1,
        },
        target,
        input.signal,
      ),
  };
  const work = (async (): Promise<RepairResult> => {
    if (input.signal.aborted) return { status: "aborted" };
    if (input.cause === "quota_forbidden")
      return { status: "not_applicable", reason: "Quota denial is not proxy failure" };
    const caps = await io.capabilities();
    if (caps.protocolVersion !== 1 || !caps.conditionalBinding)
      return { status: "unsupported", reason: "Router capability unavailable" };
    const before = await io.binding();
    if (input.cause === "manual_quota_diagnostic" && before.isActive)
      return {
        status: "not_applicable",
        binding: before,
        reason: "Manual comparison requires inactive account",
      };
    if (before.isActive && (!caps.ownershipConfigured || !io.authority))
      return { status: "unsupported", binding: before, reason: "Ownership authority required" };
    const pools = await io.pools();
    let chosen: router.NineRouterPool | undefined;
    for (const pool of pools) {
      input.signal.throwIfAborted();
      if (!pool.isActive || pool.id === before.poolId) continue;
      const audit = await io.audit(pool);
      if (audit.complete) {
        chosen = pool;
        break;
      }
    }
    if (!chosen) return { status: "no_candidate", binding: before };
    input.signal.throwIfAborted();
    let grant = null;
    if (before.isActive && io.authority) {
      const reservation = io.authority.reserve({
        proxyEndpointKey: proxyEndpointKey(chosen.proxyUrl),
        routerId: input.routerId,
        accountId: input.accountId,
        bindingRevision: before.revision + 1,
        operationId: input.operationId,
      });
      if (reservation.status !== "granted")
        return { status: "conflict", binding: before, reason: reservation.reason };
      grant = reservation.grant;
    }
    const changed = await io.update({
      operationId: input.operationId,
      expectedRevision: before.revision,
      expectedPoolId: before.poolId,
      desiredPoolId: chosen.id,
      expectedIsActive: before.isActive,
      desiredIsActive: before.isActive,
      expectedPoolRevision: chosen.poolRevision || 1,
      grant,
    });
    if (changed.status !== "applied")
      return {
        status: changed.status === "unsupported" ? "unsupported" : "conflict",
        binding: before,
        reason: changed.reason,
      };
    const installed = changed.binding;
    const observed = await io.binding();
    if (observed.revision !== installed.revision || observed.poolId !== chosen.id)
      return {
        status: "conflict",
        binding: observed,
        reason: "Binding changed before verification",
      };
    input.signal.throwIfAborted();
    const usage = await io.verify(installed, chosen);
    const quota = classifyQuotaResponse(usage, {
      routerUrl: input.routerUrl,
      accountId: input.accountId,
      proxyPoolId: chosen.id,
      bindingRevision: installed.revision,
      poolRevision: chosen.poolRevision || 1,
    });
    const metadata = usage.observation as Record<string, unknown> | undefined;
    const verified =
      quota.status === "known" &&
      quota.fresh &&
      metadata?.bindingRevision === installed.revision &&
      metadata?.poolId === chosen.id &&
      metadata?.poolRevision === (chosen.poolRevision || 1) &&
      typeof metadata?.observedAt === "number" &&
      metadata.observedAt >= Date.now() - 30000;
    if (verified) return { status: "repaired", binding: installed, verifiedAt: Date.now() };
    const current = await io.binding();
    if (current.revision !== installed.revision)
      return { status: "conflict", binding: current, reason: "Newer binding retained" };
    const old = pools.find((p) => p.id === before.poolId && p.isActive);
    if (old && !before.isActive && (await io.audit(old)).complete) {
      const rollback = await io.update({
        operationId: crypto.randomUUID(),
        expectedRevision: installed.revision,
        expectedPoolId: chosen.id,
        desiredPoolId: old.id,
        expectedIsActive: false,
        desiredIsActive: false,
        expectedPoolRevision: old.poolRevision || 1,
        grant: null,
      });
      return {
        status: "verification_failed",
        binding: rollback.status === "applied" ? rollback.binding : current,
        reason: "Fresh quota verification failed",
      };
    }
    return {
      status: "verification_failed",
      binding: current,
      reason: "Route unresolved; unsafe rollback refused",
    };
  })()
    .catch(
      (error: unknown): RepairResult => ({
        status: input.signal.aborted ? "aborted" : "verification_failed",
        reason: error instanceof Error ? error.message : "Repair failed",
      }),
    )
    .finally(() => activeRepairs.delete(key));
  activeRepairs.set(key, work);
  return work;
}
