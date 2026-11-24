import fs from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";
import { writeJsonAtomicSync } from "./fs-atomic.js";
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
import { logScoped } from "./activity-log.js";
import {
  openAntigravityRotationHistory,
  type AntigravityRotationHistory,
} from "./antigravity-rotation-history.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface AntigravityAccountInput {
  id: string;
  isActive: boolean;
  sessionPercentage: number;
  weeklyPercentage: number;
  resetAt: string | null;
  thresholdPercentage: number;
  lastError?: string | null;
  quotaAvailable?: boolean;
}

export interface AntigravityUsage {
  sessionPercentage: number;
  weeklyPercentage: number;
  resetAt: string | null;
  quotaAvailable: boolean;
  lastError?: string | null;
}

export interface RotationPlan {
  activations: string[];
  deactivations: string[];
  activeIds: string[];
  degraded: boolean;
}

export interface AntigravityRotator {
  runRotation(options?: { force?: boolean }): Promise<AntigravityRotatorSnapshot>;
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
      const remaining = ((geminiSession.total - geminiSession.used) / geminiSession.total) * 100;
      if (Number.isFinite(remaining)) {
        sessionPercentage = Math.max(0, remaining);
        quotaAvailable = true;
      }
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
      Number.isFinite(geminiWeekly.total) &&
      typeof geminiWeekly.used === "number" &&
      Number.isFinite(geminiWeekly.used) &&
      geminiWeekly.total > 0
    ) {
      weeklyPercentage = Math.max(
        0,
        ((geminiWeekly.total - geminiWeekly.used) / geminiWeekly.total) * 100,
      );
    }
  }

  const quotaOnlyError = message && /quota api access forbidden|chat may still work/i.test(message);
  const lastError = quotaOnlyError ? null : message;
  if (message) quotaAvailable = false;

  return {
    sessionPercentage: Math.max(0, Math.min(100, sessionPercentage)),
    weeklyPercentage: Math.max(0, Math.min(100, weeklyPercentage)),
    resetAt,
    quotaAvailable,
    lastError,
  };
}

const quotaAvailable = (account: AntigravityAccountInput) =>
  account.quotaAvailable !== false && Number.isFinite(account.sessionPercentage);

const byResetThenId = (a: AntigravityAccountInput, b: AntigravityAccountInput) => {
  const left = a.resetAt ? Date.parse(a.resetAt) : NaN;
  const right = b.resetAt ? Date.parse(b.resetAt) : NaN;
  const aTime = Number.isFinite(left) ? left : Infinity;
  const bTime = Number.isFinite(right) ? right : Infinity;
  return (aTime === bTime ? 0 : aTime - bTime) || a.id.localeCompare(b.id);
};

function retainedAccount(accounts: AntigravityAccountInput[]) {
  const active = accounts.filter((account) => account.isActive);
  const healthy = active.filter(
    (account) =>
      quotaAvailable(account) &&
      !account.lastError &&
      account.sessionPercentage > account.thresholdPercentage,
  );
  return healthy.sort(byResetThenId)[0] ?? active.sort((a, b) => a.id.localeCompare(b.id))[0];
}

export function computeRotationPlan(
  accounts: AntigravityAccountInput[],
  options: { allEndpointsReadable: boolean },
): RotationPlan {
  const plan: RotationPlan = {
    activations: [],
    deactivations: [],
    activeIds: [],
    degraded: !options.allEndpointsReadable,
  };
  const retained = retainedAccount(accounts);
  if (retained) {
    plan.activeIds.push(retained.id);
    plan.deactivations.push(
      ...accounts
        .filter((account) => account.isActive && account.id !== retained.id)
        .map((account) => account.id),
    );
  }
  const needsReplacement =
    !retained ||
    Boolean(retained.lastError) ||
    (quotaAvailable(retained) && retained.sessionPercentage <= retained.thresholdPercentage);
  if (!options.allEndpointsReadable || !needsReplacement) return plan;
  const successor = accounts
    .filter(
      (account) =>
        !account.isActive &&
        quotaAvailable(account) &&
        account.sessionPercentage > 20 &&
        !account.lastError,
    )
    .sort(byResetThenId)[0];
  if (!successor) return plan;
  if (retained) plan.deactivations.push(retained.id);
  plan.activations.push(successor.id);
  plan.activeIds = [successor.id];
  return plan;
}

export interface AntigravityRotatorDeps {
  listConnections?: typeof listAntigravityConnections;
  getUsage?: typeof getAccountUsage;
  updateConnection?: typeof updateConnection;
  getSettings?: typeof getSettingsSecrets;
  getRouterUrls?: () => string[];
  dataDir?: string;
  history?: AntigravityRotationHistory;
  endpointTimeoutMs?: number;
  sampleThreshold?: () => number;
}

export function createAntigravityRotator(deps?: AntigravityRotatorDeps): AntigravityRotator {
  const listConnections = deps?.listConnections ?? listAntigravityConnections;
  const getUsage = deps?.getUsage ?? getAccountUsage;
  const updateConn = deps?.updateConnection ?? updateConnection;
  const getSettings = deps?.getSettings ?? getSettingsSecrets;
  const getRouterUrls = deps?.getRouterUrls ?? getNineRouterClientUrls;
  const dataDir = deps?.dataDir ?? path.join(root, "data");
  const snapshotFile = path.join(dataDir, "antigravity-rotator.json");
  const history = deps?.history ?? openAntigravityRotationHistory(dataDir);
  const sampleThreshold = deps?.sampleThreshold ?? (() => randomInt(10, 21));
  let running = false;
  let activeRunPromise: Promise<AntigravityRotatorSnapshot> | null = null;
  let rerunQueued = false;
  let queuedForce = false;
  let cachedSnapshot: AntigravityRotatorSnapshot | null = null;

  function loadSnapshot(): AntigravityRotatorSnapshot {
    if (cachedSnapshot) return cachedSnapshot;
    try {
      if (fs.existsSync(snapshotFile)) {
        const saved = JSON.parse(
          fs.readFileSync(snapshotFile, "utf8"),
        ) as AntigravityRotatorSnapshot;
        cachedSnapshot = {
          lastRunAt: saved.lastRunAt,
          running: false,
          totalAccounts: saved.totalAccounts,
          activeCount: saved.activeCount,
          totalSessionQuotaPercentage: saved.totalSessionQuotaPercentage,
          maxPossiblePercentage: saved.maxPossiblePercentage,
          accounts: saved.accounts.map((account) => ({
            id: account.id,
            email: account.email,
            name: account.name,
            isActive: account.isActive,
            sessionPercentage: account.sessionPercentage,
            weeklyPercentage: account.weeklyPercentage,
            resetAt: account.resetAt,
            thresholdPercentage: account.thresholdPercentage ?? null,
            quotaAvailable: account.quotaAvailable ?? false,
            lastError: account.lastError,
            lastCheckedAt: account.lastCheckedAt,
            turnCount: account.turnCount,
            lastActivatedAt: account.lastActivatedAt,
            routerUrl: account.routerUrl,
          })),
          endpoints: saved.endpoints,
          degraded: true,
          error: "Cached state has not been reconciled since startup",
        };
        return cachedSnapshot;
      }
    } catch (error) {
      logScoped(
        "Antigravity",
        "loadSnapshot",
        "warn",
        `Failed to load rotation snapshot: ${String(error)}`,
      );
    }
    cachedSnapshot = {
      lastRunAt: null,
      running: false,
      totalAccounts: 0,
      activeCount: 0,
      totalSessionQuotaPercentage: 0,
      maxPossiblePercentage: 0,
      accounts: [],
      degraded: true,
      error: "Rotation has not run",
    };
    return cachedSnapshot;
  }

  interface AccountMeta {
    originalId: string;
    routerUrl?: string;
    input: AntigravityAccountInput;
    state: AntigravityAccountState;
  }
  const overridesFor = (url?: string) => {
    const overrides = {
      ...(url ? { url } : {}),
      ...(deps?.endpointTimeoutMs ? { timeoutMs: deps.endpointTimeoutMs } : {}),
    };
    return Object.keys(overrides).length ? overrides : undefined;
  };
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const isValidThreshold = (value: number | null | undefined): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= 10 && value <= 20;

  async function collectEndpoint(routerUrl?: string) {
    const overrides = overridesFor(routerUrl);
    const connections = await listConnections(overrides);
    if (connections.some((connection) => typeof connection.isActive !== "boolean")) {
      throw new Error("Endpoint returned an account without a readable active state");
    }
    const accounts = await Promise.all(
      connections.map(async (connection: NineRouterConnectionItem) => {
        let usage: AntigravityUsage;
        let telemetryError: string | null = null;
        try {
          usage = extractAntigravityUsage(await getUsage(connection.id, overrides));
        } catch (error) {
          telemetryError = message(error);
          usage = {
            sessionPercentage: 0,
            weeklyPercentage: 0,
            resetAt: null,
            quotaAvailable: false,
          };
        }
        const accountId = `${routerUrl ?? ""}:::${connection.id}`;
        const accountError = telemetryError ? null : usage.lastError || null;
        const connectionError = connection.lastError || null;
        const input: AntigravityAccountInput = {
          id: accountId,
          isActive: Boolean(connection.isActive),
          sessionPercentage: usage.sessionPercentage,
          weeklyPercentage: usage.weeklyPercentage,
          resetAt: usage.resetAt,
          quotaAvailable: usage.quotaAvailable && !connectionError,
          thresholdPercentage: 0,
          lastError: accountError,
        };
        const state: AntigravityAccountState = {
          id: connection.id,
          email: connection.email || connection.name || connection.id,
          name: connection.name || connection.email || connection.id,
          isActive: input.isActive,
          sessionPercentage: input.sessionPercentage,
          weeklyPercentage: input.weeklyPercentage,
          resetAt: input.resetAt,
          thresholdPercentage: null,
          quotaAvailable: input.quotaAvailable !== false,
          lastError: telemetryError || accountError || connectionError,
          lastCheckedAt: Date.now(),
          routerUrl,
        };
        return { originalId: connection.id, routerUrl, input, state } satisfies AccountMeta;
      }),
    );
    return { routerUrl, accounts };
  }

  async function runCycle(): Promise<AntigravityRotatorSnapshot> {
    const configured = getRouterUrls();
    const targets: Array<string | undefined> = configured.length ? configured : [undefined];
    const results = await Promise.allSettled(targets.map((url) => collectEndpoint(url)));
    const endpoints: AntigravityRotatorEndpointSummary[] = [];
    const allAccounts: AccountMeta[] = [];
    const errors: string[] = [];
    let degraded = false;
    let persistenceFailed = false;
    const recordError = (reason: string) => {
      degraded = true;
      errors.push(reason);
      logScoped("Antigravity", "rotate", "warn", reason);
    };
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      const url = targets[index] ?? "";
      if (result.status === "rejected") {
        const reason = message(result.reason);
        endpoints.push({ url, ok: false, error: reason });
        recordError(`Endpoint ${url || "default"} unavailable: ${reason}`);
      } else {
        allAccounts.push(...result.value.accounts);
        endpoints.push({ url, ok: true });
      }
    }
    const allEndpointsReadable = results.every((result) => result.status === "fulfilled");
    const byId = new Map(allAccounts.map((meta) => [meta.input.id, meta]));
    for (const meta of allAccounts) {
      try {
        let turn = history.get(meta.input.id);
        if (meta.input.isActive) {
          const threshold =
            turn?.tenureState !== "inactive" && isValidThreshold(turn?.thresholdPercentage)
              ? turn.thresholdPercentage
              : sampleThreshold();
          turn = history.adoptActive(meta.input.id, threshold);
          meta.input.thresholdPercentage = turn.thresholdPercentage!;
        } else if (turn?.tenureState === "active") {
          history.confirmDeactivation(meta.input.id);
          turn = history.get(meta.input.id);
        }
        meta.state.thresholdPercentage = turn?.thresholdPercentage ?? null;
        meta.state.turnCount = turn?.turnCount ?? 0;
        meta.state.lastActivatedAt = turn?.lastActivatedAt ?? null;
      } catch (error) {
        persistenceFailed = true;
        recordError(`History failed for ${meta.input.id}: ${message(error)}`);
      }
      if (!meta.state.quotaAvailable && !meta.input.lastError) {
        recordError(`Quota unavailable for ${meta.input.id}`);
      }
    }

    async function confirmState(meta: AccountMeta, expected: boolean) {
      const connections = await listConnections(overridesFor(meta.routerUrl));
      const connection = connections.find((item) => item.id === meta.originalId);
      if (
        !connection ||
        typeof connection.isActive !== "boolean" ||
        connection.isActive !== expected
      ) {
        throw new Error(
          `Account ${meta.input.id} ${expected ? "not confirmed active" : "not confirmed inactive"}`,
        );
      }
      return connection;
    }

    async function deactivate(meta: AccountMeta) {
      try {
        await updateConn(meta.originalId, { isActive: false }, overridesFor(meta.routerUrl));
        await confirmState(meta, false);
        meta.input.isActive = false;
        meta.state.isActive = false;
        history.confirmDeactivation(meta.input.id);
        meta.state.thresholdPercentage = null;
        logScoped("Antigravity", "rotate", "info", `Deactivated ${meta.input.id}`);
        return true;
      } catch (error) {
        recordError(`Failed to deactivate ${meta.input.id}: ${message(error)}`);
        return false;
      }
    }

    let canActivate = !persistenceFailed;
    const inputs = allAccounts.map((meta) => meta.input);
    const retained = retainedAccount(inputs);
    const extras = inputs.filter((account) => account.isActive && account.id !== retained?.id);
    if (retained && extras.length && !persistenceFailed) {
      try {
        await confirmState(byId.get(retained.id)!, true);
        for (const extra of extras) {
          if (!(await deactivate(byId.get(extra.id)!))) canActivate = false;
        }
      } catch (error) {
        canActivate = false;
        recordError(`Failed to confirm retained account ${retained.id}: ${message(error)}`);
      }
    }

    const plan = computeRotationPlan(inputs, { allEndpointsReadable });
    const successor = plan.activations[0] && byId.get(plan.activations[0]);
    if (successor && canActivate) {
      try {
        const previous = history.get(successor.input.id);
        const threshold =
          previous?.tenureState !== "inactive" && isValidThreshold(previous?.thresholdPercentage)
            ? previous.thresholdPercentage
            : sampleThreshold();
        const pending = history.prepareActivation(successor.input.id, threshold);
        successor.state.thresholdPercentage = pending.thresholdPercentage;
        await updateConn(
          successor.originalId,
          { isActive: true },
          overridesFor(successor.routerUrl),
        );
        await confirmState(successor, true);
        successor.input.isActive = true;
        successor.state.isActive = true;
        const turn = history.confirmActivation(successor.input.id, Date.now());
        successor.state.turnCount = turn.turnCount;
        successor.state.lastActivatedAt = turn.lastActivatedAt;
        logScoped("Antigravity", "rotate", "info", `Activated ${successor.input.id}`, {
          thresholdPercentage: turn.thresholdPercentage,
          turnCount: turn.turnCount,
        });
        for (const id of plan.deactivations) {
          const old = byId.get(id);
          if (old?.input.isActive && !(await deactivate(old))) break;
        }
      } catch (error) {
        recordError(`Failed to activate ${successor.input.id}: ${message(error)}`);
      }
    } else if (
      !successor &&
      allEndpointsReadable &&
      (!retained ||
        retained.lastError ||
        (quotaAvailable(retained) && retained.sessionPercentage <= retained.thresholdPercentage))
    ) {
      recordError("No eligible account available");
    }

    const accounts = allAccounts.map((meta) => meta.state);
    for (const endpoint of endpoints) {
      if (!endpoint.ok) continue;
      const states = allAccounts.filter((meta) => (meta.routerUrl ?? "") === endpoint.url);
      endpoint.totalAccounts = states.length;
      endpoint.activeCount = states.filter((meta) => meta.state.isActive).length;
    }
    const activeCount = accounts.filter((account) => account.isActive).length;
    if (activeCount > 1) recordError("Multiple active accounts remain");
    const snapshot: AntigravityRotatorSnapshot = {
      lastRunAt: Date.now(),
      running: false,
      totalAccounts: accounts.length,
      activeCount,
      totalSessionQuotaPercentage: Math.round(
        accounts.reduce((sum, account) => sum + account.sessionPercentage, 0),
      ),
      maxPossiblePercentage: accounts.length * 100,
      accounts,
      endpoints,
      degraded,
      error: errors.length ? errors.join("; ") : null,
    };
    cachedSnapshot = snapshot;
    try {
      writeJsonAtomicSync(snapshotFile, snapshot);
    } catch (error) {
      logScoped(
        "Antigravity",
        "saveSnapshot",
        "warn",
        `Failed to save rotation snapshot: ${message(error)}`,
      );
    }
    return snapshot;
  }

  function runRotation(options: { force?: boolean } = {}): Promise<AntigravityRotatorSnapshot> {
    if (options.force) queuedForce = true;
    if (activeRunPromise) {
      rerunQueued = true;
      return activeRunPromise;
    }
    if (!queuedForce && getSettings().antigravityRotatorEnabled === false) {
      return Promise.resolve(loadSnapshot());
    }
    activeRunPromise = (async () => {
      try {
        do {
          const force = queuedForce;
          queuedForce = false;
          rerunQueued = false;
          if (!force && getSettings().antigravityRotatorEnabled === false) break;
          running = true;
          await runCycle();
        } while (rerunQueued);
        return loadSnapshot();
      } finally {
        running = false;
        activeRunPromise = null;
      }
    })();
    return activeRunPromise;
  }

  return {
    runRotation,
    getSnapshot: () => ({ ...loadSnapshot(), running }),
    get isRunning() {
      return running;
    },
  };
}
