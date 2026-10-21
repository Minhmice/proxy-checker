import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AntigravityAccountState, AntigravityRotatorSnapshot } from "../lib/types.js";
import { getSettingsSecrets } from "./app-config.js";
import {
  listAntigravityConnections,
  getAccountUsage,
  updateConnection,
} from "./nine-router-client.js";
import { logActivity } from "./activity-log.js";
import { openAntigravityRotationHistory, type AntigravityRotationHistory } from "./antigravity-rotation-history.js";

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
export interface AntigravityRotator {
  runRotation(options?: { force?: boolean }): Promise<AntigravityRotatorSnapshot>;
  optimizeSpeed(): Promise<{ updated: number; accounts: Array<{ id: string; proxyPoolId: string }> }>;
  getSnapshot(): AntigravityRotatorSnapshot;
  readonly isRunning: boolean;
}

export function extractAntigravityUsage(rawUsage: Record<string, unknown>): AntigravityUsage {
  if (!rawUsage || typeof rawUsage !== "object") {
    return { sessionPercentage: 0, weeklyPercentage: 0, resetAt: null, quotaAvailable: false, lastError: "Invalid response" };
  }

  const message = typeof rawUsage.message === "string" ? rawUsage.message : null;
  const quotas = (rawUsage.quotas as Record<string, Record<string, unknown>>) || {};

  const geminiSession = quotas.gemini_session || quotas["gemini-session"] || null;
  const geminiWeekly = quotas.gemini_weekly || quotas["gemini-weekly"] || null;

  let sessionPercentage = 0;
  let quotaAvailable = false;
  let resetAt: string | null = null;
  if (geminiSession) {
    if (typeof geminiSession.remainingPercentage === "number" && Number.isFinite(geminiSession.remainingPercentage)) {
      sessionPercentage = geminiSession.remainingPercentage;
      quotaAvailable = true;
    } else if (typeof geminiSession.total === "number" && Number.isFinite(geminiSession.total) && typeof geminiSession.used === "number" && Number.isFinite(geminiSession.used) && geminiSession.total > 0) {
      sessionPercentage = Math.max(0, ((geminiSession.total - geminiSession.used) / geminiSession.total) * 100);
      quotaAvailable = true;
    }
    if (typeof geminiSession.resetAt === "string") {
      resetAt = geminiSession.resetAt;
    }
  }

  let weeklyPercentage = 0;
  if (geminiWeekly) {
    if (typeof geminiWeekly.remainingPercentage === "number" && Number.isFinite(geminiWeekly.remainingPercentage)) {
      weeklyPercentage = geminiWeekly.remainingPercentage;
    } else if (typeof geminiWeekly.total === "number" && typeof geminiWeekly.used === "number" && geminiWeekly.total > 0) {
      weeklyPercentage = Math.max(0, ((geminiWeekly.total - geminiWeekly.used) / geminiWeekly.total) * 100);
    }
  }

  let lastError: string | null = null;
  if (message && message.includes("429")) {
    lastError = message;
    sessionPercentage = 0;
  }

  return {
    sessionPercentage: Math.max(0, Math.min(100, sessionPercentage)),
    weeklyPercentage: Math.max(0, Math.min(100, weeklyPercentage)),
    resetAt,
    quotaAvailable,
    lastError
  };
}

export function computeRotationPlan(
  accounts: AntigravityAccountInput[],
  usableProxies: UsableProxyInput[],
  options: { activeLimit?: number; sessionThreshold?: number } = {}
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

  // Pre-count existing valid proxies
  const effectiveProxyMap = new Map<string, string | null>();
  for (const acc of accounts) {
    if (acc.proxyPoolId && usableProxyMap.has(acc.proxyPoolId)) {
      effectiveProxyMap.set(acc.id, acc.proxyPoolId);
      proxyAssignmentCounts.set(acc.proxyPoolId, (proxyAssignmentCounts.get(acc.proxyPoolId) ?? 0) + 1);
    } else {
      effectiveProxyMap.set(acc.id, null);
    }
  }

  // For accounts with dead or missing proxies, reassign from usable proxies
  for (const acc of accounts) {
    if (!effectiveProxyMap.get(acc.id) && usableProxies.length > 0) {
      // Find usable proxy with < 2 assignments (prefer 0 first, then 1)
      const sortedCandidates = [...usableProxies].sort((a, b) => {
        const countA = proxyAssignmentCounts.get(a.remoteId) ?? 0;
        const countB = proxyAssignmentCounts.get(b.remoteId) ?? 0;
        return countA - countB;
      });

      const chosen = sortedCandidates.find((p) => (proxyAssignmentCounts.get(p.remoteId) ?? 0) < 2) ?? sortedCandidates[0];
      if (chosen) {
        effectiveProxyMap.set(acc.id, chosen.remoteId);
        plan.proxyReassignments[acc.id] = chosen.remoteId;
        proxyAssignmentCounts.set(chosen.remoteId, (proxyAssignmentCounts.get(chosen.remoteId) ?? 0) + 1);
      }
    }
  }

  // Step B: Keep active accounts unless fresh quota proves exhaustion.
  const survivingActive: AntigravityAccountInput[] = [];
  for (const acc of accounts) {
    if (!acc.isActive) continue;
    const isExhausted = acc.quotaAvailable !== false && (
      acc.sessionPercentage <= sessionThreshold || Boolean(acc.lastError)
    );
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
    const candidates = accounts.filter((acc) =>
      !acc.isActive && !plan.deactivations.includes(acc.id) && acc.quotaAvailable !== false &&
      acc.sessionPercentage > sessionThreshold && !acc.lastError
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
  rankedProxies: UsableProxyInput[]
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

export function createAntigravityRotator(deps?: {
  listConnections?: typeof listAntigravityConnections;
  getUsage?: typeof getAccountUsage;
  updateConnection?: typeof updateConnection;
  getUsableProxies?: () => Array<{ remoteId: string; name?: string }>;
  getSettings?: typeof getSettingsSecrets;
  dataDir?: string;
  history?: AntigravityRotationHistory;
}) {
  const listConnections = deps?.listConnections ?? listAntigravityConnections;
  const getUsage = deps?.getUsage ?? getAccountUsage;
  const updateConn = deps?.updateConnection ?? updateConnection;
  const getSettings = deps?.getSettings ?? getSettingsSecrets;
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
        cachedSnapshot = JSON.parse(fs.readFileSync(snapshotFile, "utf8")) as AntigravityRotatorSnapshot;
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

  async function runRotation(options: { force?: boolean } = {}): Promise<AntigravityRotatorSnapshot> {
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
            logActivity("info", "Antigravity Rotator: checking account quotas...");
            const rawConnections = await listConnections();
            if (!rawConnections || rawConnections.length === 0) {
              logActivity("info", "Antigravity Rotator: no Antigravity accounts found on 9Router");
              const emptySnapshot: AntigravityRotatorSnapshot = {
                lastRunAt: Date.now(),
                running: false,
                totalAccounts: 0,
                activeCount: 0,
                totalSessionQuotaPercentage: 0,
                maxPossiblePercentage: 0,
                accounts: [],
              };
              saveSnapshot(emptySnapshot);
              if (!rerunQueued) return emptySnapshot;
              continue;
            }

            // 2. Fetch usage for each connection
            const accountStates: AntigravityAccountState[] = [];
            const accountInputs: AntigravityAccountInput[] = [];

            for (const conn of rawConnections) {
              const proxyPoolId = conn.providerSpecificData?.proxyPoolId ?? null;
              const turn = history.get(conn.id);
              try {
                const usage = await getUsage(conn.id);
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
                });
              } catch (err) {
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
                });
              }
            }

            // 3. Obtain usable proxies
            const usableProxies = deps?.getUsableProxies ? deps.getUsableProxies() : [];
            const usableMap = new Map(usableProxies.map((p) => [p.remoteId, p]));

            // 4. Compute rotation plan
            const plan = computeRotationPlan(accountInputs, usableProxies, {
              activeLimit: settings.antigravityActiveLimit,
              sessionThreshold: settings.antigravitySessionThreshold,
            });

            // 5. Apply transitions to 9Router
            const connMap = new Map(rawConnections.map((c) => [c.id, c]));

            const successfulProxyReassignments = new Map<string, string>();
            const failedProxyReassignments = new Set<string>();
            for (const [accId, newProxyId] of Object.entries(plan.proxyReassignments)) {
              const conn = connMap.get(accId);
              if (!conn) continue;
              const currentPsData = (conn.providerSpecificData as Record<string, unknown>) || {};
              try {
                await updateConn(accId, {
                  providerSpecificData: {
                    ...currentPsData,
                    proxyPoolId: newProxyId,
                  },
                });
                successfulProxyReassignments.set(accId, newProxyId);
                logActivity("info", `Antigravity Rotator: re-assigned proxy for ${conn.email || accId}`);
              } catch (err) {
                failedProxyReassignments.add(accId);
                const state = accountStates.find((item) => item.id === accId);
                if (state) {
                  state.lastError = (err as Error).message;
                  state.proxyHealthy = false;
                }
                logActivity("warn", `Antigravity Rotator: failed to update proxy for ${conn.email}: ${(err as Error).message}`);
              }
            }

            const failedDeactivations = new Set<string>();
            for (const accId of plan.deactivations) {
              const conn = connMap.get(accId);
              try {
                await updateConn(accId, { isActive: false });
                logActivity("info", `Antigravity Rotator: turned OFF ${conn?.email || accId} (quota below threshold)`);
              } catch (err) {
                failedDeactivations.add(accId);
                logActivity("warn", `Antigravity Rotator: failed to deactivate ${conn?.email || accId}: ${(err as Error).message}`);
              }
            }

            const successfulActivations = new Set<string>();
            if (failedDeactivations.size === 0) {
              for (const accId of plan.activations) {
                if (failedProxyReassignments.has(accId)) continue;
                const conn = connMap.get(accId);
                try {
                  await updateConn(accId, { isActive: true });
                  const turn = history.recordActivation(accId, Date.now());
                  successfulActivations.add(accId);
                  logActivity("info", `Antigravity Rotator: turned ON ${conn?.email || accId} (turn ${turn.turnCount})`);
                } catch (err) {
                  const state = accountStates.find((item) => item.id === accId);
                  if (state) state.lastError = (err as Error).message;
                  logActivity("warn", `Antigravity Rotator: failed to activate ${conn?.email || accId}: ${(err as Error).message}`);
                }
              }
            }

            const activeSet = new Set(plan.activeIds.filter((id) => {
              if (failedDeactivations.has(id)) return true;
              return Boolean(accountInputs.find((account) => account.id === id)?.isActive) || successfulActivations.has(id);
            }));
            for (const id of failedDeactivations) activeSet.add(id);
            let totalSession = 0;
            for (const state of accountStates) {
              state.isActive = activeSet.has(state.id);
              if (successfulActivations.has(state.id)) {
                const turn = history.get(state.id);
                state.turnCount = turn?.turnCount;
                state.lastActivatedAt = turn?.lastActivatedAt;
              }
              const confirmedProxyId = successfulProxyReassignments.get(state.id);
              if (confirmedProxyId) state.proxyPoolId = confirmedProxyId;
              if (state.proxyPoolId && usableMap.has(state.proxyPoolId)) {
                state.proxyHealthy = true;
                state.proxyName = usableMap.get(state.proxyPoolId)?.name || state.proxyPoolId.slice(0, 8);
              } else {
                state.proxyHealthy = false;
              }
              totalSession += state.sessionPercentage;
            }

            const snapshot: AntigravityRotatorSnapshot = {
              lastRunAt: Date.now(),
              running: false,
              totalAccounts: accountStates.length,
              activeCount: activeSet.size,
              totalSessionQuotaPercentage: Math.round(totalSession),
              maxPossiblePercentage: accountStates.length * 100,
              accounts: accountStates,
            };

            saveSnapshot(snapshot);
            logActivity(
              "info",
              `Antigravity Rotator: cycle complete (${plan.activeIds.length}/${accountStates.length} active, total ${snapshot.totalSessionQuotaPercentage}% / ${snapshot.maxPossiblePercentage}%)`
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

  function getSnapshot(): AntigravityRotatorSnapshot {
    const snap = loadSnapshot();
    snap.running = running;
    return snap;
  }
  async function optimizeSpeed(): Promise<{ updated: number; accounts: Array<{ id: string; proxyPoolId: string }> }> {
    const rawConnections = await listConnections();
    if (!rawConnections || rawConnections.length === 0) return { updated: 0, accounts: [] };

    const usable = deps?.getUsableProxies ? deps.getUsableProxies() : [];
    if (usable.length === 0) return { updated: 0, accounts: [] };

    const inputs: AntigravityAccountInput[] = rawConnections.map((c) => ({
      id: c.id,
      email: c.email || c.name || c.id,
      name: c.name || c.email || c.id,
      isActive: Boolean(c.isActive),
      sessionPercentage: 100,
      weeklyPercentage: 100,
      resetAt: null,
      proxyPoolId: (c.providerSpecificData?.proxyPoolId as string | undefined) ?? null,
    }));

    const reassignments = optimizeAccountsBySpeed(inputs, usable);
    const connMap = new Map(rawConnections.map((c) => [c.id, c]));
    let updatedCount = 0;
    for (const item of reassignments) {
      const conn = connMap.get(item.id);
      const currentPsData = (conn?.providerSpecificData && typeof conn.providerSpecificData === "object" ? conn.providerSpecificData : {}) as Record<string, unknown>;
      try {
        await updateConn(item.id, {
          providerSpecificData: {
            ...currentPsData,
            proxyPoolId: item.proxyPoolId,
          },
        });
        updatedCount++;
      } catch (err) {
        logActivity("warn", `Failed to optimize proxy for account ${item.id}: ${(err as Error).message}`);
      }
    }
    logActivity("info", `Antigravity speed optimization: updated ${updatedCount} account(s)`);
    return { updated: updatedCount, accounts: reassignments };
  }

  return {
    runRotation,
    optimizeSpeed,
    getSnapshot,
    get isRunning() {
      return running;
    },
  };
}
