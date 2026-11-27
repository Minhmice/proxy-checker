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
import { ROTATION_POLICY, type RotationProvider } from "../lib/types.js";
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
  setAccountActive(
    accountId: string,
    routerUrl: string | undefined,
    isActive: boolean,
  ): Promise<AntigravityRotatorSnapshot>;
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
      Number.isFinite(geminiSession.remainingPercentage) &&
      geminiSession.remainingPercentage >= 0 &&
      geminiSession.remainingPercentage <= 100
    ) {
      sessionPercentage = geminiSession.remainingPercentage;
      quotaAvailable = true;
    } else if (
      typeof geminiSession.total === "number" &&
      Number.isFinite(geminiSession.total) &&
      typeof geminiSession.used === "number" &&
      Number.isFinite(geminiSession.used) &&
      geminiSession.total > 0 &&
      geminiSession.used >= 0
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

export function extractCodexUsage(rawUsage: Record<string, unknown>): AntigravityUsage {
  const quotas = rawUsage?.quotas as Record<string, unknown> | undefined;
  const session = quotas?.session as Record<string, unknown> | undefined;
  const total = session?.total;
  const remaining = session?.remaining;
  const used = session?.used;
  let percentage = 0;
  let available = false;
  if (typeof total === "number" && Number.isFinite(total) && total > 0) {
    if (typeof remaining === "number" && Number.isFinite(remaining)) {
      percentage = (remaining / total) * 100;
      available = Number.isFinite(percentage);
    } else if (typeof used === "number" && Number.isFinite(used)) {
      percentage = ((total - used) / total) * 100;
      available = Number.isFinite(percentage);
    }
  }
  const message =
    typeof rawUsage?.message === "string"
      ? rawUsage.message
      : typeof rawUsage?.error === "string"
        ? rawUsage.error
        : null;
  return {
    sessionPercentage: available ? Math.max(0, Math.min(100, percentage)) : 0,
    weeklyPercentage: 0,
    resetAt: typeof session?.resetAt === "string" ? session.resetAt : null,
    quotaAvailable: available && !message,
    lastError:
      message && /quota api access forbidden|chat may still work/i.test(message) ? null : message,
  };
}

/** Claude Code reports `session (5h)` and `weekly (7d)`; the session window drives rotation like Codex. */
export function extractClaudeUsage(rawUsage: Record<string, unknown>): AntigravityUsage {
  const quotas = rawUsage?.quotas as Record<string, Record<string, unknown>> | undefined;
  const weekly = quotas?.["weekly (7d)"]?.remainingPercentage;
  return {
    ...extractCodexUsage({ ...rawUsage, quotas: { session: quotas?.["session (5h)"] } }),
    weeklyPercentage:
      typeof weekly === "number" && Number.isFinite(weekly)
        ? Math.max(0, Math.min(100, weekly))
        : 0,
  };
}

const USAGE_EXTRACTORS: Record<
  RotationProvider,
  (rawUsage: Record<string, unknown>) => AntigravityUsage
> = {
  antigravity: extractAntigravityUsage,
  codex: extractCodexUsage,
  claude: extractClaudeUsage,
};

/** A 429 on a connection whose quota still reads fine is quota exhaustion, not an account fault. */
const USAGE_LIMIT_429: Partial<Record<RotationProvider, RegExp>> = {
  codex: /^\[429\]: The usage limit has been reached$/i,
  claude: /^\[429\]:.*rate_limit_error/is,
};

const quotaAvailable = (account: AntigravityAccountInput) =>
  account.quotaAvailable !== false && Number.isFinite(account.sessionPercentage);

const byResetThenId = (a: AntigravityAccountInput, b: AntigravityAccountInput) => {
  const left = a.resetAt ? Date.parse(a.resetAt) : NaN;
  const right = b.resetAt ? Date.parse(b.resetAt) : NaN;
  const aTime = Number.isFinite(left) ? left : Infinity;
  const bTime = Number.isFinite(right) ? right : Infinity;
  return (aTime === bTime ? 0 : aTime - bTime) || a.id.localeCompare(b.id);
};

const needsReplacement = (account: AntigravityAccountInput) =>
  Boolean(account.lastError) ||
  (quotaAvailable(account) && account.sessionPercentage <= account.thresholdPercentage);

function retainedAccounts(accounts: AntigravityAccountInput[]) {
  return accounts
    .filter((account) => account.isActive)
    .sort(
      (a, b) => Number(needsReplacement(a)) - Number(needsReplacement(b)) || byResetThenId(a, b),
    )
    .slice(0, 2);
}

export function computeRotationPlan(
  accounts: AntigravityAccountInput[],
  options: { allEndpointsReadable: boolean },
): RotationPlan {
  if (!options.allEndpointsReadable) {
    return {
      activations: [],
      deactivations: [],
      activeIds: accounts.filter((account) => account.isActive).map((account) => account.id),
      degraded: true,
    };
  }
  const retained = retainedAccounts(accounts);
  const plan: RotationPlan = {
    activations: [],
    deactivations: accounts
      .filter((account) => account.isActive && !retained.includes(account))
      .map((account) => account.id),
    activeIds: retained.map((account) => account.id),
    degraded: false,
  };
  const candidates = accounts
    .filter(
      (account) =>
        !account.isActive &&
        quotaAvailable(account) &&
        account.sessionPercentage > ROTATION_POLICY.standbyQuotaExclusive &&
        !account.lastError,
    )
    .sort((a, b) => b.sessionPercentage - a.sessionPercentage || byResetThenId(a, b));
  for (const old of retained.filter(needsReplacement)) {
    const successor = candidates.shift();
    if (!successor) break;
    plan.deactivations.push(old.id);
    plan.activeIds = plan.activeIds.filter((id) => id !== old.id);
    plan.activeIds.push(successor.id);
    plan.activations.push(successor.id);
  }
  while (plan.activeIds.length < 2 && candidates.length) {
    const successor = candidates.shift()!;
    plan.activeIds.push(successor.id);
    plan.activations.push(successor.id);
  }
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
  providers?: RotationProvider[];
}

export function createAntigravityRotator(deps?: AntigravityRotatorDeps): AntigravityRotator {
  const listConnections = deps?.listConnections ?? listAntigravityConnections;
  const providers: RotationProvider[] = deps?.providers ?? ["antigravity", "codex", "claude"];
  const getUsage = deps?.getUsage ?? getAccountUsage;
  const updateConn = deps?.updateConnection ?? updateConnection;
  const getSettings = deps?.getSettings ?? getSettingsSecrets;
  const getRouterUrls = deps?.getRouterUrls ?? getNineRouterClientUrls;
  const dataDir = deps?.dataDir ?? path.join(root, "data");
  const snapshotFile = path.join(dataDir, "antigravity-rotator.json");
  const history = deps?.history ?? openAntigravityRotationHistory(dataDir);
  const sampleThreshold =
    deps?.sampleThreshold ??
    (() => randomInt(ROTATION_POLICY.thresholdMin, ROTATION_POLICY.thresholdMax + 1));
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
          lastRotationAt: saved.lastRotationAt ?? null,
          running: false,
          totalAccounts: saved.totalAccounts,
          activeCount: saved.activeCount,
          totalSessionQuotaPercentage: saved.totalSessionQuotaPercentage,
          maxPossiblePercentage: saved.maxPossiblePercentage,
          accounts: saved.accounts.map((account) => ({
            id: account.id,
            provider: account.provider ?? "antigravity",
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
          groups: saved.groups,
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
      lastRotationAt: null,
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
    provider: RotationProvider;
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
    typeof value === "number" && Number.isInteger(value) && value >= 5 && value <= 10;

  async function collectEndpoint(provider: RotationProvider, routerUrl?: string) {
    const overrides = overridesFor(routerUrl);
    const connections = await listConnections({ ...overrides, provider });
    if (connections.some((connection) => typeof connection.isActive !== "boolean")) {
      throw new Error("Endpoint returned an account without a readable active state");
    }
    const accounts = await Promise.all(
      connections.map(async (connection: NineRouterConnectionItem) => {
        let usage: AntigravityUsage;
        let telemetryError: string | null = null;
        try {
          const rawUsage = await getUsage(connection.id, overrides);
          usage = USAGE_EXTRACTORS[provider](rawUsage);
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
        const connectionError =
          usage.quotaAvailable && USAGE_LIMIT_429[provider]?.test(connection.lastError ?? "")
            ? null
            : connection.lastError || null;
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
          provider,
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
        return {
          originalId: connection.id,
          provider,
          routerUrl,
          input,
          state,
        } satisfies AccountMeta;
      }),
    );
    return { provider, routerUrl, accounts };
  }

  async function runCycle(): Promise<AntigravityRotatorSnapshot> {
    const configured = getRouterUrls();
    const targets: Array<string | undefined> = configured.length ? configured : [undefined];
    const requests = providers.flatMap((provider) => targets.map((url) => ({ provider, url })));
    const results = await Promise.allSettled(
      requests.map(({ provider, url }) => collectEndpoint(provider, url)),
    );
    const endpoints: AntigravityRotatorEndpointSummary[] = targets.map((url) => ({
      url: url ?? "",
      ok: true,
    }));
    const readable = new Map(providers.map((provider) => [provider, true]));
    const allAccounts: AccountMeta[] = [];
    const errors: string[] = [];
    let degraded = false;
    const persistenceFailures = new Set<RotationProvider>();
    let lastRotationAt = loadSnapshot().lastRotationAt ?? null;
    const recordError = (reason: string) => {
      degraded = true;
      errors.push(reason);
      logScoped("Antigravity", "rotate", "warn", reason);
    };
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      const { provider, url } = requests[index];
      const endpoint = endpoints[index % targets.length];
      if (result.status === "rejected") {
        const reason = message(result.reason);
        readable.set(provider, false);
        endpoint.ok = false;
        endpoint.error = [endpoint.error, `${provider}: ${reason}`].filter(Boolean).join("; ");
        recordError(`Endpoint ${url || "default"} ${provider} unavailable: ${reason}`);
      } else {
        allAccounts.push(...result.value.accounts);
      }
    }
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
        persistenceFailures.add(meta.provider);
        recordError(`History failed for ${meta.input.id}: ${message(error)}`);
      }
      if (!meta.state.quotaAvailable && !meta.input.lastError) {
        recordError(`Quota unavailable for ${meta.input.id}`);
      }
    }

    async function confirmState(meta: AccountMeta, expected: boolean) {
      const connections = await listConnections({
        ...overridesFor(meta.routerUrl),
        provider: meta.provider,
      });
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

    for (const provider of providers) {
      const allEndpointsReadable = readable.get(provider) === true;
      let canActivate = !persistenceFailures.has(provider);
      const inputs = allAccounts
        .filter((meta) => meta.provider === provider)
        .map((meta) => meta.input);
      const retained = retainedAccounts(inputs);
      const extras = inputs.filter((account) => account.isActive && !retained.includes(account));
      if (extras.length && canActivate && allEndpointsReadable) {
        try {
          for (const account of retained) await confirmState(byId.get(account.id)!, true);
          for (const extra of extras) {
            if (!(await deactivate(byId.get(extra.id)!))) canActivate = false;
          }
        } catch (error) {
          canActivate = false;
          recordError(`Failed to confirm retained ${provider} accounts: ${message(error)}`);
        }
      }

      const plan = computeRotationPlan(inputs, { allEndpointsReadable });
      const replacements = plan.deactivations.filter((id) => byId.get(id)?.input.isActive);
      for (const successorId of plan.activations) {
        if (!canActivate) break;
        const successor = byId.get(successorId)!;
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
          const oldId = replacements.shift();
          if (oldId) {
            if (!(await deactivate(byId.get(oldId)!))) break;
            lastRotationAt = Math.max(Date.now(), (lastRotationAt ?? 0) + 1);
          }
        } catch (error) {
          recordError(`Failed to activate ${successor.input.id}: ${message(error)}`);
          break;
        }
      }
      if (
        allEndpointsReadable &&
        (inputs.filter((account) => account.isActive).length < 2 ||
          inputs.some((account) => account.isActive && needsReplacement(account)))
      ) {
        recordError(`No eligible account available for all active slots (${provider})`);
      }
      if (inputs.filter((account) => account.isActive).length > 2) {
        recordError(`More than two active ${provider} accounts remain`);
      }
    }

    const accounts = allAccounts.map((meta) => meta.state);
    for (const endpoint of endpoints) {
      const states = allAccounts.filter((meta) => (meta.routerUrl ?? "") === endpoint.url);
      endpoint.totalAccounts = states.length;
      endpoint.activeCount = states.filter((meta) => meta.state.isActive).length;
    }
    const activeCount = accounts.filter((account) => account.isActive).length;
    const groups = providers.map((provider) => {
      const states = accounts.filter((account) => account.provider === provider);
      return {
        provider,
        totalAccounts: states.length,
        activeCount: states.filter((account) => account.isActive).length,
      };
    });
    const snapshot: AntigravityRotatorSnapshot = {
      lastRunAt: Date.now(),
      lastRotationAt,
      running: false,
      totalAccounts: accounts.length,
      activeCount,
      totalSessionQuotaPercentage: Math.round(
        accounts.reduce((sum, account) => sum + account.sessionPercentage, 0),
      ),
      maxPossiblePercentage: accounts.length * 100,
      accounts,
      groups,
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

  let manualWrite: Promise<AntigravityRotatorSnapshot> | null = null;

  async function setAccountActive(
    accountId: string,
    routerUrl: string | undefined,
    isActive: boolean,
  ) {
    if (activeRunPromise || manualWrite)
      throw new Error("Account maintenance is in progress. Try again shortly.");
    const current = loadSnapshot();
    const account = current.accounts.find(
      (item) => item.id === accountId && item.routerUrl === routerUrl,
    );
    const urls = getRouterUrls();
    if (!account || (routerUrl === undefined ? urls.length > 0 : !urls.includes(routerUrl))) {
      throw new Error("Account is no longer available on this router. Refresh quota first.");
    }
    const provider = account.provider ?? "antigravity";
    const overrides = overridesFor(account.routerUrl);
    manualWrite = (async () => {
      await updateConn(accountId, { isActive }, overrides);
      const confirmed = await listConnections({ ...overrides, provider });
      if (confirmed.find((item) => item.id === accountId)?.isActive !== isActive) {
        throw new Error("Router did not confirm the account state. Refresh quota before retrying.");
      }
      const key = `${routerUrl ?? ""}:::${accountId}`;
      if (!isActive) history.confirmDeactivation(key);
      const turn = isActive
        ? history.adoptActive(key, account.thresholdPercentage ?? sampleThreshold())
        : history.get(key);
      const accounts = current.accounts.map((item) =>
        item === account
          ? {
              ...item,
              isActive,
              thresholdPercentage: isActive ? (turn?.thresholdPercentage ?? null) : null,
              turnCount: turn?.turnCount,
              lastActivatedAt: turn?.lastActivatedAt,
            }
          : item,
      );
      const active = accounts.filter((item) => item.isActive);
      const snapshot = {
        ...current,
        accounts,
        activeCount: active.length,
        groups: current.groups?.map((group) => ({
          ...group,
          activeCount: active.filter((item) => (item.provider ?? "antigravity") === group.provider)
            .length,
        })),
        endpoints: current.endpoints?.map((endpoint) => ({
          ...endpoint,
          activeCount: active.filter((item) => (item.routerUrl ?? "") === endpoint.url).length,
        })),
      };
      cachedSnapshot = snapshot;
      writeJsonAtomicSync(snapshotFile, snapshot);
      return snapshot;
    })();
    try {
      return await manualWrite;
    } finally {
      manualWrite = null;
    }
  }

  function runRotation(options: { force?: boolean } = {}): Promise<AntigravityRotatorSnapshot> {
    if (manualWrite)
      return manualWrite.then(
        () => runRotation(options),
        () => runRotation(options),
      );
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
    setAccountActive,
    getSnapshot: () => ({ ...loadSnapshot(), running }),
    get isRunning() {
      return running;
    },
  };
}
