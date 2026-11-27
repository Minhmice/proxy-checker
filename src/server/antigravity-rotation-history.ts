import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { openRotationDb } from "../db/rotation/client.js";
import { accountTurns } from "../db/rotation/schema.js";

export interface AntigravityTurn {
  accountId: string;
  turnCount: number;
  lastActivatedAt: number | null;
  thresholdPercentage: number | null;
  tenureState: "inactive" | "pending" | "active";
}

export interface AntigravityRotationHistory {
  get(accountId: string): AntigravityTurn | undefined;
  prepareActivation(accountId: string, thresholdPercentage: number): AntigravityTurn;
  confirmActivation(accountId: string, activatedAt: number): AntigravityTurn;
  adoptActive(accountId: string, thresholdPercentage: number): AntigravityTurn;
  confirmDeactivation(accountId: string): void;
  close(): void;
}

export function openAntigravityRotationHistory(dataDir: string): AntigravityRotationHistory {
  fs.mkdirSync(dataDir, { recursive: true });
  const client = openRotationDb(path.join(dataDir, "antigravity-rotation.sqlite3"));

  const get = (accountId: string): AntigravityTurn | undefined => {
    const row = client.db
      .select()
      .from(accountTurns)
      .where(eq(accountTurns.accountId, accountId))
      .get();
    if (!row) return undefined;
    return {
      ...row,
      tenureState:
        row.tenureState === "active" || row.tenureState === "pending"
          ? row.tenureState
          : "inactive",
    };
  };
  const validThreshold = (value: number | null | undefined) =>
    typeof value === "number" && Number.isInteger(value) && value >= 5 && value <= 10;
  const saveThreshold = (
    accountId: string,
    thresholdPercentage: number,
    state: "pending" | "active",
  ) => {
    if (!validThreshold(thresholdPercentage))
      throw new Error("Rotation threshold must be an integer from 5 to 10");
    const current = get(accountId);
    const threshold =
      current && current.tenureState !== "inactive" && validThreshold(current.thresholdPercentage)
        ? current.thresholdPercentage
        : thresholdPercentage;
    client.db
      .insert(accountTurns)
      .values({ accountId, thresholdPercentage: threshold, tenureState: state })
      .onConflictDoUpdate({
        target: accountTurns.accountId,
        set: { thresholdPercentage: threshold, tenureState: state },
      })
      .run();
    return get(accountId)!;
  };

  return {
    get,
    prepareActivation(accountId, thresholdPercentage) {
      const current = get(accountId);
      return saveThreshold(
        accountId,
        thresholdPercentage,
        current?.tenureState === "active" ? "active" : "pending",
      );
    },
    confirmActivation(accountId, activatedAt) {
      const current = get(accountId);
      if (!current || current.tenureState === "inactive") {
        throw new Error(`Activation was not prepared: ${accountId}`);
      }
      if (current.tenureState === "pending") {
        client.db
          .update(accountTurns)
          .set({
            tenureState: "active",
            turnCount: current.turnCount + 1,
            lastActivatedAt: activatedAt,
          })
          .where(eq(accountTurns.accountId, accountId))
          .run();
      }
      return get(accountId)!;
    },
    adoptActive(accountId, thresholdPercentage) {
      const current = get(accountId);
      if (current?.tenureState === "pending") {
        saveThreshold(accountId, thresholdPercentage, "pending");
        return this.confirmActivation(accountId, Date.now());
      }
      return saveThreshold(accountId, thresholdPercentage, "active");
    },
    confirmDeactivation(accountId) {
      client.db
        .update(accountTurns)
        .set({ thresholdPercentage: null, tenureState: "inactive" })
        .where(eq(accountTurns.accountId, accountId))
        .run();
    },
    close() {
      client.close();
    },
  };
}
