import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { generateKeyPairSync, verify } from "node:crypto";
import {
  createProxyOwnershipAuthority,
  ownershipPayload,
} from "../src/server/antigravity-ownership.js";

const keys = generateKeyPairSync("ed25519");
const reserve = {
  proxyEndpointKey: "http://proxy.test:8080",
  routerId: "a",
  accountId: "one",
  bindingRevision: 2,
  operationId: "op-a",
};
test("shared proxy ownership never transfers merely because grant expires", () => {
  const db = new Database(":memory:");
  let now = 1000;
  const authority = createProxyOwnershipAuthority(db, keys.privateKey, { now: () => now });
  try {
    const first = authority.reserve(reserve);
    assert.equal(first.status, "granted");
    if (first.status !== "granted") throw Error("grant missing");
    assert.equal(
      verify(
        null,
        Buffer.from(ownershipPayload(first.grant)),
        keys.publicKey,
        Buffer.from(first.grant.signature, "base64url"),
      ),
      true,
    );
    now = 400000;
    assert.equal(
      authority.reserve({ ...reserve, routerId: "b", accountId: "two", operationId: "op-b" })
        .status,
      "conflict",
    );
    assert.equal(
      authority.release({ ...reserve, epoch: first.grant.epoch, drained: false }),
      false,
    );
    assert.equal(authority.release({ ...reserve, epoch: first.grant.epoch, drained: true }), true);
    const second = authority.reserve({
      ...reserve,
      routerId: "b",
      accountId: "two",
      operationId: "op-b",
    });
    assert.equal(second.status, "granted");
    if (second.status === "granted") assert.ok(second.grant.epoch > first.grant.epoch);
    assert.equal(authority.release({ ...reserve, epoch: first.grant.epoch, drained: true }), false);
  } finally {
    db.close();
  }
});
test("operation ID cannot be reused for a different owner", () => {
  const db = new Database(":memory:");
  const authority = createProxyOwnershipAuthority(db, keys.privateKey);
  try {
    assert.equal(authority.reserve(reserve).status, "granted");
    assert.equal(authority.reserve({ ...reserve, accountId: "other" }).status, "conflict");
  } finally {
    db.close();
  }
});
