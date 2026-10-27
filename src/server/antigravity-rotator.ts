import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AntigravityAccountState,
  AntigravityRotatorSnapshot,
  AntigravityRotatorEndpointSummary,
} from "../lib/types.js";
import { getSettingsSecrets } from "./app-config.js";
import {
  listAntigravityConnections,
  getAccountUsage,
  updateConnection,
  getNineRouterClientUrls,
  type NineRouterConnectionItem,
} from "./nine-router-client.js";
import { logActivity, logScoped } from "./activity-log.js";
import {
  openAntigravityRotationHistory,
  type AntigravityRotationHistory,
} from "./antigravity-rotation-history.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface AntigravityAccountInput {
  id: string;
  email?: string;
  name?: string;
  isActive: boolean;
  sessionPercentage: number;
  weeklyPercentage: number;
  resetAt: string | null;
  proxyPoolId: string | null;
  proxyName?: string | null;
  lastError?: string | null;
  quotaAvailable?: boolean;
  turnCount?: number;
  lastActivatedAt?: number | null;
  routerUrl?: string;
}

export interface AntigravityUsage {
  sessionPercentage: number;
  weeklyPercentage: number;
  resetAt: string | null;
  quotaAvailable: boolean;
  lastError?: string | null;
}

export interface UsableProxyInput {
  remoteId: string;
  name?: string;
}

export interface RotationPlan {
  activations: string[];
  deactivations: string[];
  activeIds: string[];
  proxyReassignments: Record<string, string>; // accountId -> newProxyPoolId
}

export interface ResetProxiesResult {
  ok: boolean;
  totalAccounts: number;
  reassignedCount: number;
  forbiddenAccounts: number;
  reassigned: Array<{
    accountId: string;
    email?: string;
    oldProxyId: string | null;
    newProxyId: string;
    routerUrl?: string;
  }>;
}

export interface AntigravityRotator {
  runRotation(options?: {
    force?: boolean;
    reassignForbidden?: boolean;
  }): Promise<AntigravityRotatorSnapshot>;
  resetProxies(options?: { forceAll?: boolean }): Promise<ResetProxiesResult>;
  optimizeSpeed(): Promise<{
    updated: number;
    accounts: Array<{ id: string; proxyPoolId: string }>;
  }>;
  getSnapshot(): AntigravityRotatorSnapshot;
  readonly isRunning: boolean;
}

export function extractAntigravityUsage(rawUsage: Record<string, unknown>): AntigravityUsage {
  if (!rawUsage || typeof rawUsage !== "object") {
    return {
      sessionPercentage: 0,
      weeklyPercentage: 0,
      resetAt: null,
      quotaAvailable: false,
      lastError: "Invalid response",
    };
  }

  const message =
    typeof rawUsage.message === "string"
      ? rawUsage.message
      : typeof rawUsage.error === "string"
        ? rawUsage.error
        : null;
  const quotas = (rawUsage.quotas as Record<string, Record<string, unknown>>) || {};

  const geminiSession = quotas.gemini_session || quotas["gemini-session"] || null;
  const geminiWeekly = quotas.gemini_weekly || quotas["gemini-weekly"] || null;

  let sessionPercentage = 0;
  let quotaAvailable = false;
  let resetAt: string | null = null;
  if (geminiSession) {
    if (
      typeof geminiSession.remainingPercentage === "number" &&
      Number.isFinite(geminiSession.remainingPercentage)
    ) {
      sessionPercentage = geminiSession.remainingPercentage;
      quotaAvailable = true;
    } else if (
      typeof geminiSession.total === "number" &&
      Number.isFinite(geminiSession.total) &&
      typeof geminiSession.used === "number" &&
      Number.isFinite(geminiSession.used) &&
      geminiSession.total > 0
    ) {
      sessionPercentage = Math.max(
        0,
        ((geminiSession.total - geminiSession.used) / geminiSession.total) * 100,
      );
      quotaAvailable = true;
    }
    if (typeof geminiSession.resetAt === "string") {
      resetAt = geminiSession.resetAt;
    }
  }

  let weeklyPercentage = 0;
  if (geminiWeekly) {
    if (
      typeof geminiWeekly.remainingPercentage === "number" &&
      Number.isFinite(geminiWeekly.remainingPercentage)
    ) {
      weeklyPercentage = geminiWeekly.remainingPercentage;
    } else if (
      typeof geminiWeekly.total === "number" &&
      typeof geminiWeekly.used === "number" &&
      geminiWeekly.total > 0
    ) {
      weeklyPercentage = Math.max(
        0,
        ((geminiWeekly.total - geminiWeekly.used) / geminiWeekly.total) * 100,
      );
    }
  }

  const lastError = message;
  if (message) quotaAvailable = false;

  return {
    sessionPercentage: Math.max(0, Math.min(100, sessionPercentage)),
    weeklyPercentage: Math.max(0, Math.min(100, weeklyPercentage)),
    resetAt,
    quotaAvailable,
    lastError,
  };
}
export function isAccountForbidden(account: {
  lastError?: string | null;
  sessionPercentage?: number;
  quotaAvailable?: boolean;
}): boolean {
  if (!account.lastError) return false;
  const msg = account.lastError.toLowerCase();
  return (
    /\b403\b/.test(msg) ||
    msg.includes("forbidden") ||
    msg.includes("self_signed_cert_in_chain") ||
    msg.includes("permission_denied") ||
    msg.includes("service_disabled") ||
    msg.includes("account_suspended") ||
    msg.includes("account_disabled") ||
    msg.includes("model_locked") ||
    msg.includes("modellock")
  );
}

export function computeRotationPlan(
  accounts: AntigravityAccountInput[],
  usableProxies: UsableProxyInput[],
  options: {
    activeLimit?: number;
    sessionThreshold?: number;
    reassignForbidden?: boolean;
  } = {},
): RotationPlan {
  const activeLimit = Math.max(1, options.activeLimit ?? 3);
  const sessionThreshold = Math.max(5, options.sessionThreshold ?? 20);

  const plan: RotationPlan = {
    activations: [],
    deactivations: [],
    activeIds: [],
    proxyReassignments: {},
  };

  if (accounts.length === 0) return plan;

  // Step A: Proxy health validation & multiplexing (max 2 accounts per proxy)
  const usableProxyMap = new Map<string, UsableProxyInput>();
  for (const p of usableProxies) {
    if (p.remoteId) usableProxyMap.set(p.remoteId, p);
  }

  // Count current assignments to usable proxies
  const proxyAssignmentCounts = new Map<string, number>();
  for (const p of usableProxies) {
    proxyAssignmentCounts.set(p.remoteId, 0);
  }

  // Pre-count existing valid proxies (excluding forbidden proxies when reassignForbidden is enabled)
  const effectiveProxyMap = new Map<string, string | null>();
  for (const acc of accounts) {
    const isForbidden = Boolean(options.reassignForbidden && isAccountForbidden(acc));
    if (!isForbidden && acc.proxyPoolId && usableProxyMap.has(acc.proxyPoolId)) {
      effectiveProxyMap.set(acc.id, acc.proxyPoolId);
      proxyAssignmentCounts.set(
        acc.proxyPoolId,
        (proxyAssignmentCounts.get(acc.proxyPoolId) ?? 0) + 1,
      );
    } else {
      effectiveProxyMap.set(acc.id, null);
    }
  }

  // For accounts with dead, missing, or forbidden proxies, reassign from clean usable proxies
  const candidatePool = usableProxies;

  for (const acc of accounts) {
    if (!effectiveProxyMap.get(acc.id) && candidatePool.length > 0) {
      // Find usable proxy with < 2 assignments (prefer 0 first, then 1)
      const sortedCandidates = [...candidatePool]
        .filter((p) => candidatePool.length === 1 || p.remoteId !== acc.proxyPoolId)
        .sort((a, b) => {
          const countA = proxyAssignmentCounts.get(a.remoteId) ?? 0;
          const countB = proxyAssignmentCounts.get(b.remoteId) ?? 0;
          return countA - countB;
        });

      const chosen =
        sortedCandidates.find((p) => (proxyAssignmentCounts.get(p.remoteId) ?? 0) < 2) ??
        sortedCandidates[0];
      if (chosen) {
        effectiveProxyMap.set(acc.id, chosen.remoteId);
        plan.proxyReassignments[acc.id] = chosen.remoteId;
        proxyAssignmentCounts.set(
          chosen.remoteId,
          (proxyAssignmentCounts.get(chosen.remoteId) ?? 0) + 1,
        );
      }
    }
  }

  // Step B: Keep active accounts unless fresh quota proves exhaustion.
  const survivingActive: AntigravityAccountInput[] = [];
  for (const acc of accounts) {
    if (!acc.isActive) continue;
    const isExhausted = acc.quotaAvailable !== false && acc.sessionPercentage <= sessionThreshold;
    if (isExhausted) plan.deactivations.push(acc.id);
    else survivingActive.push(acc);
  }

  // Deduplicate surviving active accounts sharing the same proxy (no two active accounts can share the same proxy)
  survivingActive.sort((a, b) => {
    if (b.sessionPercentage !== a.sessionPercentage) {
      return b.sessionPercentage - a.sessionPercentage;
    }
    const timeA = a.resetAt ? new Date(a.resetAt).getTime() : Number.MAX_SAFE_INTEGER;
    const timeB = b.resetAt ? new Date(b.resetAt).getTime() : Number.MAX_SAFE_INTEGER;
    return timeA - timeB;
  });

  const dedupedActive: AntigravityAccountInput[] = [];
  const occupiedProxies = new Set<string>();

  for (const acc of survivingActive) {
    const proxyId = effectiveProxyMap.get(acc.id);
    if (proxyId && occupiedProxies.has(proxyId)) {
      plan.deactivations.push(acc.id);
    } else {
      dedupedActive.push(acc);
      if (proxyId) occupiedProxies.add(proxyId);
    }
  }

  // If dedupedActive exceeds activeLimit, trim excess based on lowest quota
  if (dedupedActive.length > activeLimit) {
    dedupedActive.sort((a, b) => b.sessionPercentage - a.sessionPercentage);
    const excess = dedupedActive.splice(activeLimit);
    for (const ex of excess) {
      plan.deactivations.push(ex.id);
    }
  }

  // Step C: Prefer the earliest known session reset, not activation history.
  let availableSlots = activeLimit - dedupedActive.length;
  if (availableSlots > 0) {
    const candidates = accounts.filter(
      (acc) =>
        !acc.isActive &&
        !plan.deactivations.includes(acc.id) &&
        acc.quotaAvailable !== false &&
        acc.sessionPercentage > sessionThreshold &&
        !acc.lastError,
    );
    candidates.sort((a, b) => {
      const timeA = a.resetAt ? Date.parse(a.resetAt) : NaN;
      const timeB = b.resetAt ? Date.parse(b.resetAt) : NaN;
      const resetA = Number.isFinite(timeA) ? timeA : Infinity;
      const resetB = Number.isFinite(timeB) ? timeB : Infinity;
      return (resetA === resetB ? 0 : resetA - resetB) || a.id.localeCompare(b.id);
    });
    for (const cand of candidates) {
      if (availableSlots <= 0) break;
      const candProxy = effectiveProxyMap.get(cand.id);
      if (candProxy && occupiedProxies.has(candProxy)) continue;
      plan.activations.push(cand.id);
      if (candProxy) occupiedProxies.add(candProxy);
      availableSlots -= 1;
    }
  }

  plan.activeIds = [...dedupedActive.map((a) => a.id), ...plan.activations];
  return plan;
}

export function optimizeAccountsBySpeed(
  accounts: AntigravityAccountInput[],
  rankedProxies: UsableProxyInput[],
): Array<{ id: string; proxyPoolId: string }> {
  const activeAccounts = accounts.filter((a) => a.isActive);
  const reassignments: Array<{ id: string; proxyPoolId: string }> = [];
  if (rankedProxies.length === 0 || activeAccounts.length === 0) return reassignments;

  for (let i = 0; i < activeAccounts.length; i++) {
    const acc = activeAccounts[i];
    const proxy = rankedProxies[i % rankedProxies.length];
    if (proxy && proxy.remoteId) {
      reassignments.push({ id: acc.id, proxyPoolId: proxy.remoteId });
    }
  }
  return reassignments;
}

export interface AntigravityRotatorDeps {
  listConnections?: typeof listAntigravityConnections;
  getUsage?: typeof getAccountUsage;
  updateConnection?: typeof updateConnection;
  getUsableProxies?: () => Array<{ remoteId: string; name?: string }>;
  getSettings?: typeof getSettingsSecrets;
  getRouterUrls?: () => string[];
  dataDir?: string;
  history?: AntigravityRotationHistory;
  endpointTimeoutMs?: number;
}

export function createAntigravityRotator(deps?: AntigravityRotatorDeps) {
  const listConnections = deps?.listConnections ?? listAntigravityConnections;
  const getUsage = deps?.getUsage ?? getAccountUsage;
  const updateConn = deps?.updateConnection ?? updateConnection;
  const getSettings = deps?.getSettings ?? getSettingsSecrets;
  const getRouterUrls = deps?.getRouterUrls ?? (() => getNineRouterClientUrls());
  const dataDir = deps?.dataDir ?? path.join(root, "data");
  const snapshotFile = path.join(dataDir, "antigravity-rotator.json");
  const history = deps?.history ?? openAntigravityRotationHistory(dataDir);

  let running = false;
  let cachedSnapshot: AntigravityRotatorSnapshot | null = null;
  let activeRunPromise: Promise<AntigravityRotatorSnapshot> | null = null;
  let rerunQueued = false;
  let queuedForce = false;

  function loadSnapshot(): AntigravityRotatorSnapshot {
    if (cachedSnapshot) return cachedSnapshot;
    try {
      if (fs.existsSync(snapshotFile)) {
        cachedSnapshot = JSON.parse(
          fs.readFileSync(snapshotFile, "utf8"),
        ) as AntigravityRotatorSnapshot;
        return cachedSnapshot;
      }
    } catch {}
    cachedSnapshot = {
      lastRunAt: null,
      running: false,
      totalAccounts: 0,
      activeCount: 0,
      totalSessionQuotaPercentage: 0,
      maxPossiblePercentage: 0,
      accounts: [],
    };
    return cachedSnapshot;
  }

  function saveSnapshot(snapshot: AntigravityRotatorSnapshot) {
    cachedSnapshot = snapshot;
    try {
      fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
      const temp = `${snapshotFile}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(snapshot, null, 2));
      fs.renameSync(temp, snapshotFile);
    } catch (err) {
      console.error("[antigravity-rotator] Failed to save snapshot:", (err as Error).message);
    }
  }

  interface EndpointCollectionResult {
    url: string;
    rawConnections: NineRouterConnectionItem[];
    accountInputs: AntigravityAccountInput[];
    accountStates: AntigravityAccountState[];
  }

  async function fetchEndpointAccounts(targetUrl?: string): Promise<EndpointCollectionResult> {
    const urlLabel = targetUrl ? ` [${targetUrl}]` : "";
    const overrides = {
      ...(targetUrl ? { url: targetUrl } : {}),
      ...(deps?.endpointTimeoutMs ? { timeoutMs: deps.endpointTimeoutMs } : {}),
    };
    const effectiveOverrides = Object.keys(overrides).length > 0 ? overrides : undefined;

    logScoped("Antigravity", "fetchAccounts", "info", `Fetching accounts and usage${urlLabel}`, {
      endpoint: targetUrl || "default",
    });
    const rawConnections = await listConnections(effectiveOverrides);
    if (!rawConnections || rawConnections.length === 0) {
      logScoped(
        "Antigravity",
        "fetchAccounts",
        "info",
        `No Antigravity accounts found on 9Router${urlLabel}`,
        { endpoint: targetUrl || "default", count: 0 },
      );
      return {
        url: targetUrl || "",
        rawConnections: [],
        accountInputs: [],
        accountStates: [],
      };
    }

    const accountStates: AntigravityAccountState[] = [];
    const accountInputs: AntigravityAccountInput[] = [];

    for (const conn of rawConnections) {
      const proxyPoolId = conn.providerSpecificData?.proxyPoolId ?? null;
      const turn = history.get(conn.id);
      try {
        const usage = await getUsage(conn.id, effectiveOverrides);
        const parsed = extractAntigravityUsage(usage);
        accountInputs.push({
          id: conn.id,
          email: conn.email || conn.name || conn.id,
          name: conn.name || conn.email || conn.id,
          isActive: Boolean(conn.isActive),
          sessionPercentage: parsed.sessionPercentage,
          weeklyPercentage: parsed.weeklyPercentage,
          resetAt: parsed.resetAt,
          proxyPoolId,
          lastError: parsed.lastError || conn.lastError || null,
          quotaAvailable: parsed.quotaAvailable,
          turnCount: turn?.turnCount ?? 0,
          lastActivatedAt: turn?.lastActivatedAt ?? null,
          routerUrl: targetUrl,
        });

        accountStates.push({
          id: conn.id,
          email: conn.email || conn.name || conn.id,
          name: conn.name || conn.email || conn.id,
          isActive: Boolean(conn.isActive),
          sessionPercentage: parsed.sessionPercentage,
          weeklyPercentage: parsed.weeklyPercentage,
          resetAt: parsed.resetAt,
          proxyPoolId,
          proxyName: null,
          proxyHealthy: true,
          lastError: parsed.lastError || conn.lastError || null,
          lastCheckedAt: Date.now(),
          turnCount: turn?.turnCount ?? 0,
          lastActivatedAt: turn?.lastActivatedAt ?? null,
          routerUrl: targetUrl,
        });

        const resetMinRemaining = parsed.resetAt
          ? Math.max(0, Math.round((new Date(parsed.resetAt).getTime() - Date.now()) / 60000))
          : null;
        logScoped(
          "Antigravity",
          "evaluateQuota",
          "info",
          `Account ${conn.email || conn.name || conn.id} quota evaluated`,
          {
            id: conn.id,
            active: Boolean(conn.isActive),
            sessionQuota: `${parsed.sessionPercentage}%`,
            resetInMinutes: resetMinRemaining ?? "none",
            proxyPoolId: proxyPoolId || "none",
          },
        );
      } catch (err) {
        logScoped(
          "Antigravity",
          "evaluateQuota",
          "warn",
          `Failed to evaluate quota for ${conn.email || conn.name || conn.id}: ${(err as Error).message}`,
          { id: conn.id, error: (err as Error).message },
        );
        accountInputs.push({
          id: conn.id,
          email: conn.email || conn.name || conn.id,
          name: conn.name || conn.email || conn.id,
          isActive: Boolean(conn.isActive),
          sessionPercentage: 0,
          weeklyPercentage: 0,
          resetAt: null,
          proxyPoolId,
          lastError: (err as Error).message,
          quotaAvailable: false,
          turnCount: turn?.turnCount ?? 0,
          lastActivatedAt: turn?.lastActivatedAt ?? null,
          routerUrl: targetUrl,
        });
        accountStates.push({
          id: conn.id,
          email: conn.email || conn.name || conn.id,
          name: conn.name || conn.email || conn.id,
          isActive: Boolean(conn.isActive),
          sessionPercentage: 0,
          weeklyPercentage: 0,
          resetAt: null,
          proxyPoolId,
          proxyHealthy: false,
          lastError: (err as Error).message,
          lastCheckedAt: Date.now(),
          turnCount: turn?.turnCount ?? 0,
          lastActivatedAt: turn?.lastActivatedAt ?? null,
          routerUrl: targetUrl,
        });
      }
    }

    logScoped(
      "Antigravity",
      "fetchAccounts",
      "info",
      `Fetched ${rawConnections.length} accounts${urlLabel}`,
      { endpoint: targetUrl || "default", total: rawConnections.length },
    );
    return {
      url: targetUrl || "",
      rawConnections,
      accountInputs,
      accountStates,
    };
  }

  async function runRotation(
    options: { force?: boolean; reassignForbidden?: boolean } = {},
  ): Promise<AntigravityRotatorSnapshot> {
    if (options.force) queuedForce = true;
    if (activeRunPromise) {
      rerunQueued = true;
      return activeRunPromise;
    }

    activeRunPromise = (async () => {
      try {
        while (true) {
          const force = queuedForce;
          queuedForce = false;
          rerunQueued = false;

          const settings = getSettings();
          if (!force && settings.antigravityRotatorEnabled === false) {
            return loadSnapshot();
          }

          running = true;
          try {
            const configuredUrls = getRouterUrls();
            const targetUrls =
              configuredUrls.length > 0 ? configuredUrls : [undefined as unknown as string];

            // 1. Fetch accounts and usage from all targetUrls in parallel
            const endpointResults = await Promise.allSettled(
              targetUrls.map((url) => fetchEndpointAccounts(url)),
            );

            const healthyEndpoints: EndpointCollectionResult[] = [];
            const endpointsSummary: AntigravityRotatorEndpointSummary[] = [];

            for (let i = 0; i < targetUrls.length; i++) {
              const url = targetUrls[i] || "";
              const res = endpointResults[i];
              if (res.status === "fulfilled") {
                healthyEndpoints.push(res.value);
              } else {
                const errMessage = (res.reason as Error).message || "Connection failed";
                logScoped(
                  "Antigravity",
                  "fetchAccounts",
                  "warn",
                  `Router connection failed: ${errMessage}`,
                  { endpoint: url || "default", error: errMessage },
                );
                endpointsSummary.push({
                  url,
                  ok: false,
                  error: errMessage,
                });
              }
            }

            // 2. Gather all accounts globally into unified inputs with router tracking
            interface GlobalAccountMeta {
              account: AntigravityAccountInput;
              rawConnection?: NineRouterConnectionItem;
              state: AntigravityAccountState;
              routerUrl?: string;
              originalId: string;
            }
            const accountMetaByKey = new Map<string, GlobalAccountMeta>();
            const globalInputs: AntigravityAccountInput[] = [];

            for (const ep of healthyEndpoints) {
              const connMap = new Map(ep.rawConnections.map((c) => [c.id, c]));
              for (let i = 0; i < ep.accountInputs.length; i++) {
                const input = ep.accountInputs[i];
                const state = ep.accountStates[i];
                const globalKey = ep.url ? `${ep.url}:::${input.id}` : input.id;
                accountMetaByKey.set(globalKey, {
                  account: input,
                  rawConnection: connMap.get(input.id),
                  state,
                  routerUrl: ep.url || undefined,
                  originalId: input.id,
                });
                globalInputs.push({
                  ...input,
                  id: globalKey,
                });
              }
            }

            // 3. Run computeRotationPlan ONCE globally across all accounts
            const usableProxies = deps?.getUsableProxies ? deps.getUsableProxies() : [];
            const usableMap = new Map(usableProxies.map((p) => [p.remoteId, p]));
            const plan = computeRotationPlan(globalInputs, usableProxies, {
              activeLimit: settings.antigravityActiveLimit,
              sessionThreshold: settings.antigravitySessionThreshold,
              reassignForbidden: options.reassignForbidden ?? force === true,
            });

            logScoped(
              "Antigravity",
              "runRotation",
              "info",
              `Computed rotation plan: ${plan.activations.length} to activate, ${plan.deactivations.length} to deactivate, ${Object.keys(plan.proxyReassignments).length} proxy reassignments`,
              {
                activeLimit: settings.antigravityActiveLimit,
                sessionThreshold: settings.antigravitySessionThreshold,
                activations: plan.activations,
                deactivations: plan.deactivations,
              },
            );
            // 4. Apply plan: proxy reassignments in parallel
            const successfulProxyReassignments = new Map<string, string>();
            const failedProxyReassignments = new Set<string>();
            const reassignmentTasks = Object.entries(plan.proxyReassignments).map(
              async ([globalKey, newProxyId]) => {
                const meta = accountMetaByKey.get(globalKey);
                if (!meta) return;
                const currentPsData =
                  (meta.rawConnection?.providerSpecificData as Record<string, unknown>) || {};
                const urlLabel = meta.routerUrl ? ` [${meta.routerUrl}]` : "";
                const overrides = {
                  ...(meta.routerUrl ? { url: meta.routerUrl } : {}),
                  ...(deps?.endpointTimeoutMs ? { timeoutMs: deps.endpointTimeoutMs } : {}),
                };
                const effectiveOverrides =
                  Object.keys(overrides).length > 0 ? overrides : undefined;
                try {
                  await updateConn(
                    meta.originalId,
                    {
                      providerSpecificData: {
                        ...currentPsData,
                        proxyPoolId: newProxyId,
                      },
                    },
                    effectiveOverrides,
                  );
                  successfulProxyReassignments.set(globalKey, newProxyId);
                  logScoped(
                    "Antigravity",
                    "reassignProxy",
                    "info",
                    `Reassigned proxy for ${meta.account.email || meta.originalId}: ${meta.account.proxyPoolId || "none"} -> ${newProxyId}${urlLabel}`,
                    {
                      accountId: meta.originalId,
                      oldProxy: meta.account.proxyPoolId || null,
                      newProxy: newProxyId,
                    },
                  );
                } catch (err) {
                  failedProxyReassignments.add(globalKey);
                  meta.state.lastError = (err as Error).message;
                  meta.state.proxyHealthy = false;
                  logScoped(
                    "Antigravity",
                    "reassignProxy",
                    "warn",
                    `Failed to update proxy for ${meta.account.email || meta.originalId}: ${(err as Error).message}${urlLabel}`,
                    { accountId: meta.originalId, error: (err as Error).message },
                  );
                }
              },
            );
            await Promise.allSettled(reassignmentTasks);

            // 5. Apply plan: deactivations in parallel
            const failedDeactivations = new Set<string>();
            const deactivationTasks = plan.deactivations.map(async (globalKey) => {
              const meta = accountMetaByKey.get(globalKey);
              if (!meta) return;
              const urlLabel = meta.routerUrl ? ` [${meta.routerUrl}]` : "";
              const overrides = {
                ...(meta.routerUrl ? { url: meta.routerUrl } : {}),
                ...(deps?.endpointTimeoutMs ? { timeoutMs: deps.endpointTimeoutMs } : {}),
              };
              const effectiveOverrides = Object.keys(overrides).length > 0 ? overrides : undefined;
              try {
                await updateConn(meta.originalId, { isActive: false }, effectiveOverrides);
                const reason =
                  meta.account.sessionPercentage <= (settings.antigravitySessionThreshold ?? 20)
                    ? `quota <= ${settings.antigravitySessionThreshold ?? 20}%`
                    : "demoted or proxy conflict";
                logScoped(
                  "Antigravity",
                  "rotate",
                  "info",
                  `Turned OFF ${meta.account.email || meta.originalId} (${reason})${urlLabel}`,
                  {
                    accountId: meta.originalId,
                    sessionQuota: `${meta.account.sessionPercentage}%`,
                    reason,
                  },
                );
              } catch (err) {
                failedDeactivations.add(globalKey);
                logScoped(
                  "Antigravity",
                  "rotate",
                  "warn",
                  `Failed to deactivate ${meta.account.email || meta.originalId}: ${(err as Error).message}${urlLabel}`,
                  { accountId: meta.originalId, error: (err as Error).message },
                );
              }
            });
            await Promise.allSettled(deactivationTasks);

            // 6. Apply plan: activations in parallel (only if all deactivations succeeded)
            const successfulActivations = new Set<string>();
            if (failedDeactivations.size === 0) {
              const activationTasks = plan.activations.map(async (globalKey) => {
                if (failedProxyReassignments.has(globalKey)) return;
                const meta = accountMetaByKey.get(globalKey);
                if (!meta) return;
                const urlLabel = meta.routerUrl ? ` [${meta.routerUrl}]` : "";
                const overrides = {
                  ...(meta.routerUrl ? { url: meta.routerUrl } : {}),
                  ...(deps?.endpointTimeoutMs ? { timeoutMs: deps.endpointTimeoutMs } : {}),
                };
                const effectiveOverrides =
                  Object.keys(overrides).length > 0 ? overrides : undefined;
                try {
                  await updateConn(meta.originalId, { isActive: true }, effectiveOverrides);
                  const turn = history.recordActivation(meta.originalId, Date.now());
                  successfulActivations.add(globalKey);
                  const resetMins = meta.account.resetAt
                    ? Math.max(
                        0,
                        Math.round((new Date(meta.account.resetAt).getTime() - Date.now()) / 60000),
                      )
                    : null;
                  logScoped(
                    "Antigravity",
                    "rotate",
                    "info",
                    `Turned ON ${meta.account.email || meta.originalId} (turn ${turn.turnCount}, quota ${meta.account.sessionPercentage}%, reset in ${resetMins ?? "?"}m)${urlLabel}`,
                    {
                      accountId: meta.originalId,
                      turnCount: turn.turnCount,
                      sessionQuota: `${meta.account.sessionPercentage}%`,
                      resetInMinutes: resetMins,
                    },
                  );
                } catch (err) {
                  meta.state.lastError = (err as Error).message;
                  logScoped(
                    "Antigravity",
                    "rotate",
                    "warn",
                    `Failed to activate ${meta.account.email || meta.originalId}: ${(err as Error).message}${urlLabel}`,
                    { accountId: meta.originalId, error: (err as Error).message },
                  );
                }
              });
              await Promise.allSettled(activationTasks);
            }

            // 7. Update states
            const activeSet = new Set(
              plan.activeIds.filter((globalKey) => {
                if (failedDeactivations.has(globalKey)) return true;
                const meta = accountMetaByKey.get(globalKey);
                return Boolean(meta?.account.isActive) || successfulActivations.has(globalKey);
              }),
            );
            for (const key of failedDeactivations) activeSet.add(key);

            for (const [globalKey, meta] of accountMetaByKey.entries()) {
              const state = meta.state;
              state.isActive = activeSet.has(globalKey);
              if (successfulActivations.has(globalKey)) {
                const turn = history.get(meta.originalId);
                state.turnCount = turn?.turnCount;
                state.lastActivatedAt = turn?.lastActivatedAt;
              }
              const confirmedProxyId = successfulProxyReassignments.get(globalKey);
              if (confirmedProxyId) state.proxyPoolId = confirmedProxyId;
              if (state.proxyPoolId && usableMap.has(state.proxyPoolId)) {
                state.proxyHealthy = true;
                state.proxyName =
                  usableMap.get(state.proxyPoolId)?.name || state.proxyPoolId.slice(0, 8);
              } else {
                state.proxyHealthy = false;
              }
            }

            // 8. Build endpoints summary & aggregate snapshot
            const allAccounts: AntigravityAccountState[] = [];
            let totalSession = 0;
            let totalPossible = 0;

            for (const ep of healthyEndpoints) {
              allAccounts.push(...ep.accountStates);
              const epActiveCount = ep.accountStates.filter((s) => s.isActive).length;
              const epSession = ep.accountStates.reduce((sum, s) => sum + s.sessionPercentage, 0);
              endpointsSummary.push({
                url: ep.url,
                ok: true,
                totalAccounts: ep.accountStates.length,
                activeCount: epActiveCount,
              });
              totalSession += epSession;
              totalPossible += ep.accountStates.length * 100;
            }

            const totalActive = allAccounts.filter((s) => s.isActive).length;

            const snapshot: AntigravityRotatorSnapshot = {
              lastRunAt: Date.now(),
              running: false,
              totalAccounts: allAccounts.length,
              activeCount: totalActive,
              totalSessionQuotaPercentage: Math.round(totalSession),
              maxPossiblePercentage: totalPossible,
              accounts: allAccounts,
              endpoints: endpointsSummary,
            };

            saveSnapshot(snapshot);
            logScoped(
              "Antigravity",
              "runRotation",
              "info",
              `Cycle complete (${totalActive}/${allAccounts.length} active, total ${snapshot.totalSessionQuotaPercentage}% / ${snapshot.maxPossiblePercentage}%) across ${endpointsSummary.length} router(s)`,
              {
                activeCount: totalActive,
                totalAccounts: allAccounts.length,
                sessionQuota: `${snapshot.totalSessionQuotaPercentage}%`,
                maxPossible: `${snapshot.maxPossiblePercentage}%`,
                routers: endpointsSummary.length,
              },
            );
            if (!rerunQueued) return snapshot;
          } finally {
            running = false;
          }
        }
      } finally {
        activeRunPromise = null;
      }
    })();

    return activeRunPromise;
  }
  async function optimizeSpeed(): Promise<{
    updated: number;
    accounts: Array<{ id: string; proxyPoolId: string }>;
  }> {
    const configuredUrls = getRouterUrls();
    const targetUrls =
      configuredUrls.length > 0 ? configuredUrls : [undefined as unknown as string];
    const usable = deps?.getUsableProxies ? deps.getUsableProxies() : [];
    if (usable.length === 0) return { updated: 0, accounts: [] };

    const endpointResults = await Promise.allSettled(
      targetUrls.map(async (targetUrl) => {
        const overrides = {
          ...(targetUrl ? { url: targetUrl } : {}),
          ...(deps?.endpointTimeoutMs ? { timeoutMs: deps.endpointTimeoutMs } : {}),
        };
        const effectiveOverrides = Object.keys(overrides).length > 0 ? overrides : undefined;
        const rawConnections = await listConnections(effectiveOverrides);
        return { targetUrl, rawConnections: rawConnections || [] };
      }),
    );

    interface GlobalActiveItem {
      globalKey: string;
      originalId: string;
      routerUrl?: string;
      rawConnection: NineRouterConnectionItem;
      input: AntigravityAccountInput;
    }
    const allActiveItems: GlobalActiveItem[] = [];

    for (const res of endpointResults) {
      if (res.status !== "fulfilled") continue;
      const { targetUrl, rawConnections } = res.value;
      for (const c of rawConnections) {
        if (!c.isActive) continue;
        const globalKey = targetUrl ? `${targetUrl}:::${c.id}` : c.id;
        const input: AntigravityAccountInput = {
          id: globalKey,
          email: c.email || c.name || c.id,
          name: c.name || c.email || c.id,
          isActive: true,
          sessionPercentage: 100,
          weeklyPercentage: 100,
          resetAt: null,
          proxyPoolId: (c.providerSpecificData?.proxyPoolId as string | undefined) ?? null,
        };
        allActiveItems.push({
          globalKey,
          originalId: c.id,
          routerUrl: targetUrl,
          rawConnection: c,
          input,
        });
      }
    }

    if (allActiveItems.length === 0) return { updated: 0, accounts: [] };

    const reassignments = optimizeAccountsBySpeed(
      allActiveItems.map((item) => item.input),
      usable,
    );

    let totalUpdated = 0;
    const allReassignments: Array<{ id: string; proxyPoolId: string }> = [];
    const itemMap = new Map(allActiveItems.map((item) => [item.globalKey, item]));

    const updateTasks = reassignments.map(async (reassign) => {
      const item = itemMap.get(reassign.id);
      if (!item) return;
      const currentPsData = (
        item.rawConnection.providerSpecificData &&
        typeof item.rawConnection.providerSpecificData === "object"
          ? item.rawConnection.providerSpecificData
          : {}
      ) as Record<string, unknown>;
      const overrides = {
        ...(item.routerUrl ? { url: item.routerUrl } : {}),
        ...(deps?.endpointTimeoutMs ? { timeoutMs: deps.endpointTimeoutMs } : {}),
      };
      const effectiveOverrides = Object.keys(overrides).length > 0 ? overrides : undefined;
      try {
        await updateConn(
          item.originalId,
          {
            providerSpecificData: {
              ...currentPsData,
              proxyPoolId: reassign.proxyPoolId,
            },
          },
          effectiveOverrides,
        );
        totalUpdated++;
        allReassignments.push({ id: item.originalId, proxyPoolId: reassign.proxyPoolId });
      } catch (err) {
        logScoped(
          "Antigravity",
          "optimizeSpeed",
          "warn",
          `Failed to optimize proxy for account ${item.originalId} on ${item.routerUrl || "default"}: ${(err as Error).message}`,
          { accountId: item.originalId, error: (err as Error).message },
        );
      }
    });

    await Promise.allSettled(updateTasks);
    logScoped(
      "Antigravity",
      "optimizeSpeed",
      "info",
      `Antigravity speed optimization complete: updated ${totalUpdated} account(s)`,
      { updated: totalUpdated },
    );
    return { updated: totalUpdated, accounts: allReassignments };
  }
  async function resetProxies(options: { forceAll?: boolean } = {}): Promise<ResetProxiesResult> {
    const configuredUrls = getRouterUrls();
    const targetUrls =
      configuredUrls.length > 0 ? configuredUrls : [undefined as unknown as string];
    const usable = deps?.getUsableProxies ? deps.getUsableProxies() : [];
    if (usable.length === 0) {
      return {
        ok: false,
        totalAccounts: 0,
        reassignedCount: 0,
        forbiddenAccounts: 0,
        reassigned: [],
      };
    }

    const endpointResults = await Promise.allSettled(
      targetUrls.map((url) => fetchEndpointAccounts(url)),
    );

    const reassigned: ResetProxiesResult["reassigned"] = [];
    let totalAccounts = 0;
    let forbiddenCount = 0;

    for (let i = 0; i < targetUrls.length; i++) {
      const epRes = endpointResults[i];
      if (epRes.status !== "fulfilled") continue;
      const { rawConnections, accountInputs, url } = epRes.value;
      totalAccounts += accountInputs.length;

      for (const acc of accountInputs) {
        if (isAccountForbidden(acc)) {
          forbiddenCount++;
        }
      }

      const plan = computeRotationPlan(accountInputs, usable, {
        reassignForbidden: true,
      });

      const connMap = new Map(rawConnections.map((c) => [c.id, c]));
      const urlLabel = url ? ` [${url}]` : "";
      const overrides = {
        ...(url ? { url } : {}),
        ...(deps?.endpointTimeoutMs ? { timeoutMs: deps.endpointTimeoutMs } : {}),
      };
      const effectiveOverrides = Object.keys(overrides).length > 0 ? overrides : undefined;

      for (const [accId, newProxyId] of Object.entries(plan.proxyReassignments)) {
        const conn = connMap.get(accId);
        if (!conn) continue;
        const oldProxyId = (conn.providerSpecificData?.proxyPoolId as string | undefined) ?? null;
        if (oldProxyId === newProxyId && !options.forceAll) continue;

        const currentPsData =
          (conn.providerSpecificData as Record<string, unknown> | undefined) || {};

        try {
          await updateConn(
            accId,
            {
              providerSpecificData: {
                ...currentPsData,
                proxyPoolId: newProxyId,
              },
            },
            effectiveOverrides,
          );
          reassigned.push({
            accountId: accId,
            email: conn.email || conn.name || accId,
            oldProxyId,
            newProxyId,
            routerUrl: url,
          });
          logScoped(
            "Antigravity",
            "resetProxies",
            "info",
            `Reset Proxies${urlLabel}: Re-assigned proxy for ${conn.email || accId} -> ${newProxyId}`,
            { accountId: accId, oldProxyId, newProxyId, endpoint: url || "default" },
          );
        } catch (err) {
          logScoped(
            "Antigravity",
            "resetProxies",
            "warn",
            `Reset Proxies${urlLabel}: Failed to reassign proxy for ${conn.email || accId}: ${(err as Error).message}`,
            { accountId: accId, error: (err as Error).message, endpoint: url || "default" },
          );
        }
      }
    }

    await runRotation({ force: true, reassignForbidden: true }).catch(() => null);

    return {
      ok: true,
      totalAccounts,
      reassignedCount: reassigned.length,
      forbiddenAccounts: forbiddenCount,
      reassigned,
    };
  }

  function getSnapshot(): AntigravityRotatorSnapshot {
    const snap = loadSnapshot();
    snap.running = running;
    return snap;
  }
  return {
    runRotation,
    resetProxies,
    optimizeSpeed,
    getSnapshot,
    get isRunning() {
      return running;
    },
  };
}
