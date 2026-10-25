import type {
  Accuracy,
  Receipt,
  RouterAdapter,
  SyncRepository,
  UsageEvent,
  UsageScope,
  UsageWrite,
} from "./types.js";
import { logScoped } from "../activity-log.js";

export interface UsageService {
  ingest(): Promise<{ inserted: number; blockedScopes: string[] }>;
  writeBack(writes: UsageWrite[]): Promise<Receipt[]>;
  resolveUnknown(operationId: string): Promise<Receipt>;
}

export function chooseWriteStrategy(input: {
  absoluteSafe: boolean;
  deltaIdempotent: boolean;
}): "absolute" | "delta" | null {
  if (input.absoluteSafe) {
    return "absolute";
  }
  if (input.deltaIdempotent) {
    return "delta";
  }
  return null;
}

interface ScaledDecimal {
  mantissa: bigint;
  scale: number;
}

function parseDecimal(val: string): ScaledDecimal {
  const trimmed = val.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid decimal amount string: "${val}"`);
  }
  if (trimmed.startsWith("-")) {
    throw new Error(`Negative usage amount not permitted: "${val}"`);
  }

  const dotIndex = trimmed.indexOf(".");
  if (dotIndex === -1) {
    return {
      mantissa: BigInt(trimmed),
      scale: 0,
    };
  }

  const intPart = trimmed.slice(0, dotIndex);
  const fracPart = trimmed.slice(dotIndex + 1);
  const scale = fracPart.length;
  const mantissa = BigInt(intPart + fracPart);

  return { mantissa, scale };
}

function formatScaled(mantissa: bigint, scale: number): string {
  if (scale === 0) {
    return mantissa.toString();
  }
  const factor = 10n ** BigInt(scale);
  const intPart = mantissa / factor;
  let fracPart = (mantissa % factor).toString();

  if (fracPart === "0") {
    return intPart.toString();
  }

  while (fracPart.length < scale) {
    fracPart = "0" + fracPart;
  }
  // Trim trailing zeros from fractional part
  fracPart = fracPart.replace(/0+$/, "");
  if (fracPart.length === 0) {
    return intPart.toString();
  }
  return `${intPart.toString()}.${fracPart}`;
}

export function aggregateUsage(events: UsageEvent[]): { amount: string; accuracy: Accuracy } {
  if (events.length === 0) {
    return { amount: "0", accuracy: "exact" };
  }

  const baseScope = events[0].scope;
  const isGauge =
    baseScope.unit === "percentage" ||
    baseScope.unit === "percent" ||
    baseScope.metric.endsWith("_gauge") ||
    baseScope.metric === "quota_remaining";

  let overallAccuracy: Accuracy = "exact";
  const parsedDecimals: ScaledDecimal[] = [];
  let latestEvent: UsageEvent | null = null;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const s = event.scope;

    if (
      s.accountKey !== baseScope.accountKey ||
      s.provider !== baseScope.provider ||
      s.model !== baseScope.model ||
      s.metric !== baseScope.metric ||
      s.unit !== baseScope.unit ||
      (s.currency ?? null) !== (baseScope.currency ?? null) ||
      s.periodStart !== baseScope.periodStart ||
      s.periodEnd !== baseScope.periodEnd
    ) {
      throw new Error(
        `Incompatible usage scopes cannot be aggregated: ${JSON.stringify(s)} vs ${JSON.stringify(baseScope)}`,
      );
    }

    if (event.accuracy === "incomplete") {
      overallAccuracy = "incomplete";
    } else if (event.accuracy === "approximate" && overallAccuracy !== "incomplete") {
      overallAccuracy = "approximate";
    }

    if (event.provenance === "replicated") {
      // Replicated provenance contributes 0 to native aggregate sum
      continue;
    }

    const parsed = parseDecimal(event.amount);
    parsedDecimals.push(parsed);

    if (!latestEvent || event.observedAt >= latestEvent.observedAt) {
      latestEvent = event;
    }
  }

  if (isGauge) {
    if (!latestEvent) {
      return { amount: "0", accuracy: overallAccuracy };
    }
    const parsed = parseDecimal(latestEvent.amount);
    return {
      amount: formatScaled(parsed.mantissa, parsed.scale),
      accuracy: overallAccuracy,
    };
  }

  if (parsedDecimals.length === 0) {
    return { amount: "0", accuracy: overallAccuracy };
  }

  let maxScale = 0;
  for (const item of parsedDecimals) {
    if (item.scale > maxScale) {
      maxScale = item.scale;
    }
  }

  let sum = 0n;
  for (const item of parsedDecimals) {
    const scaleDiff = maxScale - item.scale;
    const factor = 10n ** BigInt(scaleDiff);
    sum += item.mantissa * factor;
  }

  return {
    amount: formatScaled(sum, maxScale),
    accuracy: overallAccuracy,
  };
}

function scopeKey(scope: UsageScope): string {
  return `${scope.provider}:${scope.accountKey}:${scope.model}:${scope.metric}:${scope.unit}:${scope.currency ?? ""}:${scope.periodStart}:${scope.periodEnd}`;
}

export function createUsageService(input: {
  repository: SyncRepository;
  adapters: RouterAdapter[];
}): UsageService {
  const { repository, adapters } = input;

  return {
    async ingest(): Promise<{ inserted: number; blockedScopes: string[] }> {
      logScoped(
        "DualRouter",
        "ingestUsage",
        "info",
        `Ingesting usage events from ${adapters.length} adapter(s)`,
      );
      let inserted = 0;
      const blockedScopes = new Set<string>();

      for (const adapter of adapters) {
        let events: UsageEvent[] = [];
        try {
          events = await adapter.readUsage();
        } catch {
          continue;
        }

        for (const event of events) {
          if (event.provenance === "replicated") {
            continue;
          }

          try {
            const added = repository.appendUsage(event);
            if (added) {
              inserted++;
            }
          } catch {
            blockedScopes.add(scopeKey(event.scope));
          }
        }
      }

      logScoped("DualRouter", "ingestUsage", "success", `Ingested ${inserted} new usage event(s)`, {
        inserted,
        blockedScopes: blockedScopes.size,
      });
      return {
        inserted,
        blockedScopes: Array.from(blockedScopes),
      };
    },

    async writeBack(writes: UsageWrite[]): Promise<Receipt[]> {
      logScoped(
        "DualRouter",
        "writeBackUsage",
        "info",
        `Writing back ${writes.length} usage write(s)`,
      );
      const receipts: Receipt[] = [];

      for (const write of writes) {
        repository.prepareWrite(write);

        const adapter = adapters.find((a) => a.routerId === write.routerId);
        if (!adapter) {
          const receipt: Receipt = {
            operationId: write.operationId,
            outcome: "unsupported",
            boundary: null,
            evidence: `Router adapter not found for routerId: ${write.routerId}`,
          };
          repository.recordReceipt(receipt);
          receipts.push(receipt);
          continue;
        }

        let receipt: Receipt;
        try {
          receipt = await adapter.writeUsage(write);
        } catch (err) {
          receipt = {
            operationId: write.operationId,
            outcome: "unknown",
            boundary: null,
            evidence: err instanceof Error ? err.message : String(err),
          };
        }

        repository.recordReceipt(receipt);
        receipts.push(receipt);
      }

      logScoped(
        "DualRouter",
        "writeBackUsage",
        "success",
        `Finished writeback | receipts=${receipts.length}`,
      );
      return receipts;
    },

    async resolveUnknown(operationId: string): Promise<Receipt> {
      for (const adapter of adapters) {
        try {
          const receipt = await adapter.readReceipt(operationId);
          if (receipt) {
            repository.recordReceipt(receipt);
            return receipt;
          }
        } catch {
          // Continue querying remaining adapters
        }
      }

      return {
        operationId,
        outcome: "unknown",
        boundary: null,
        evidence: "Operation receipt not found in any adapter",
      };
    },
  };
}
