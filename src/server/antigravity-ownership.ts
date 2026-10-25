import { sign, type KeyLike } from "node:crypto";
import type Database from "better-sqlite3";

export interface OwnershipRequest {
  proxyEndpointKey: string;
  routerId: string;
  accountId: string;
  bindingRevision: number;
  operationId: string;
}
export interface ProxyOwnershipGrant extends OwnershipRequest {
  epoch: number;
  expiresAt: number;
  signature: string;
}
export function ownershipPayload(grant: Omit<ProxyOwnershipGrant, "signature">): string {
  return JSON.stringify([
    grant.proxyEndpointKey,
    grant.routerId,
    grant.accountId,
    grant.operationId,
    grant.epoch,
    grant.bindingRevision,
    grant.expiresAt,
  ]);
}
type OwnerRow = {
  endpoint_key: string;
  router_id: string;
  account_id: string;
  operation_id: string;
  epoch: number;
  binding_revision: number;
  expires_at: number;
  state: string;
};
type GrantResult =
  | { status: "granted"; grant: ProxyOwnershipGrant }
  | { status: "conflict"; reason: string };

export interface ProxyOwnershipAuthority {
  reserve(input: OwnershipRequest): GrantResult;
  renew(input: OwnershipRequest & { epoch: number }): GrantResult;
  release(input: OwnershipRequest & { epoch: number; drained: boolean }): boolean;
}

export function createProxyOwnershipAuthority(
  db: Database.Database,
  privateKey: KeyLike,
  options: { now?: () => number } = {},
) {
  const now = options.now || Date.now;
  db.exec(`CREATE TABLE IF NOT EXISTS proxy_ownership (
    endpoint_key TEXT PRIMARY KEY, router_id TEXT NOT NULL, account_id TEXT NOT NULL,
    operation_id TEXT NOT NULL, epoch INTEGER NOT NULL, binding_revision INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS proxy_ownership_operations (
      operation_id TEXT PRIMARY KEY, payload TEXT NOT NULL, result TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS proxy_bindings (
      router_id TEXT NOT NULL,account_id TEXT NOT NULL,endpoint_key TEXT NOT NULL,
      PRIMARY KEY(router_id,account_id));`);
  const get = (key: string) =>
    db.prepare("SELECT * FROM proxy_ownership WHERE endpoint_key = ?").get(key) as
      | OwnerRow
      | undefined;
  function grant(row: OwnerRow): ProxyOwnershipGrant {
    const value = {
      proxyEndpointKey: row.endpoint_key,
      routerId: row.router_id,
      accountId: row.account_id,
      operationId: row.operation_id,
      epoch: row.epoch,
      bindingRevision: row.binding_revision,
      expiresAt: row.expires_at,
    };
    return {
      ...value,
      signature: sign(null, Buffer.from(ownershipPayload(value)), privateKey).toString("base64url"),
    };
  }
  function reserve(input: OwnershipRequest): GrantResult {
    if (
      !input.operationId ||
      !input.routerId ||
      !input.accountId ||
      !input.proxyEndpointKey ||
      !Number.isSafeInteger(input.bindingRevision) ||
      input.bindingRevision < 1
    )
      throw new Error("Invalid ownership request");
    return db
      .transaction(() => {
        const payload = JSON.stringify(input);
        const oldOp = db
          .prepare("SELECT * FROM proxy_ownership_operations WHERE operation_id = ?")
          .get(input.operationId) as { payload: string; result: string } | undefined;
        if (oldOp)
          return oldOp.payload === payload
            ? JSON.parse(oldOp.result)
            : { status: "conflict", reason: "Operation payload changed" };
        const existing = get(input.proxyEndpointKey);
        if (
          existing &&
          existing.state !== "released" &&
          (existing.router_id !== input.routerId || existing.account_id !== input.accountId)
        )
          return { status: "conflict", reason: "Existing owner has not drained" };
        const count = db
          .prepare(
            "SELECT COUNT(*) AS n FROM proxy_bindings WHERE endpoint_key = ? AND NOT(router_id = ? AND account_id = ?)",
          )
          .get(input.proxyEndpointKey, input.routerId, input.accountId) as { n: number };
        if (count.n >= 2) return { status: "conflict", reason: "Proxy binding capacity reached" };
        const row: OwnerRow = {
          endpoint_key: input.proxyEndpointKey,
          router_id: input.routerId,
          account_id: input.accountId,
          operation_id: input.operationId,
          epoch: (existing?.epoch || 0) + 1,
          binding_revision: input.bindingRevision,
          expires_at: now() + 300000,
          state: "reserved",
        };
        db.prepare(`INSERT INTO proxy_ownership VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(endpoint_key) DO UPDATE SET
        router_id=excluded.router_id,account_id=excluded.account_id,operation_id=excluded.operation_id,
        epoch=excluded.epoch,binding_revision=excluded.binding_revision,expires_at=excluded.expires_at,state=excluded.state`).run(
          row.endpoint_key,
          row.router_id,
          row.account_id,
          row.operation_id,
          row.epoch,
          row.binding_revision,
          row.expires_at,
          row.state,
        );
        db.prepare(
          "INSERT INTO proxy_bindings VALUES(?,?,?) ON CONFLICT(router_id,account_id) DO UPDATE SET endpoint_key=excluded.endpoint_key",
        ).run(input.routerId, input.accountId, input.proxyEndpointKey);
        const result = { status: "granted", grant: grant(row) } as const;
        db.prepare("INSERT INTO proxy_ownership_operations VALUES(?,?,?)").run(
          input.operationId,
          payload,
          JSON.stringify(result),
        );
        return result;
      })
      .immediate();
  }
  function release(input: OwnershipRequest & { epoch: number; drained: boolean }): boolean {
    if (!input.drained) return false;
    return db
      .transaction(() => {
        const result = db
          .prepare(
            "UPDATE proxy_ownership SET state='released' WHERE endpoint_key=? AND router_id=? AND account_id=? AND operation_id=? AND epoch=? AND state<>'released'",
          )
          .run(
            input.proxyEndpointKey,
            input.routerId,
            input.accountId,
            input.operationId,
            input.epoch,
          );
        if (result.changes)
          db.prepare(
            "DELETE FROM proxy_bindings WHERE router_id=? AND account_id=? AND endpoint_key=?",
          ).run(input.routerId, input.accountId, input.proxyEndpointKey);
        return result.changes === 1;
      })
      .immediate();
  }
  function renew(input: OwnershipRequest & { epoch: number }): GrantResult {
    return db
      .transaction((): GrantResult => {
        const row = get(input.proxyEndpointKey);
        if (
          !row ||
          row.state === "released" ||
          row.router_id !== input.routerId ||
          row.account_id !== input.accountId ||
          row.operation_id !== input.operationId ||
          row.epoch !== input.epoch ||
          row.binding_revision !== input.bindingRevision
        )
          return { status: "conflict", reason: "Ownership changed" };
        row.expires_at = now() + 300000;
        db.prepare("UPDATE proxy_ownership SET expires_at=? WHERE endpoint_key=? AND epoch=?").run(
          row.expires_at,
          input.proxyEndpointKey,
          input.epoch,
        );
        return { status: "granted", grant: grant(row) };
      })
      .immediate();
  }
  return { reserve, release, renew };
}
