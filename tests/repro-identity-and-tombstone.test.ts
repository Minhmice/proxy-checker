import test from "node:test";
import assert from "node:assert/strict";
import { poolKey } from "../src/server/dual-router/identity.js";
import { planMerge } from "../src/server/dual-router/merge.js";
import type {
  Baseline,
  Entity,
  Resource,
  ScopeSnapshot,
  Snapshot,
} from "../src/server/dual-router/types.js";

function makeScope(
  entities: Entity[] = [],
  complete = true,
  error: string | null = null,
): ScopeSnapshot {
  return {
    complete,
    entities,
    cursor: null,
    observedAt: 1000,
    error,
  };
}

function makeSnapshot(
  routerId: string,
  scopesPartial: Partial<Record<Resource, ScopeSnapshot>> = {},
): Snapshot {
  return {
    routerId,
    scopes: {
      pool: scopesPartial.pool ?? makeScope([], true),
      account: scopesPartial.account ?? makeScope([], true),
      settings: scopesPartial.settings ?? makeScope([], true),
      role: scopesPartial.role ?? makeScope([], true),
      history: scopesPartial.history ?? makeScope([], true),
    },
  };
}

// ---------------------------------------------------------------------------
// Ca 1: Proxy URL co password chua ky tu @
// Gia thuyet: poolKey tra ve double-@ (user:p@ssword@host:8080) lam new URL() loi
// ---------------------------------------------------------------------------
test("Ca 1: Proxy URL co password chua @ (%40 hoac raw @)", () => {
  const urlEncoded = "http://user:p%40ssword@proxy.host:8080";
  const keyEncoded = poolKey(urlEncoded);

  // Kiem tra gia thuyet double-@: user:p@ssword@proxy.host:8080
  const hasDoubleAt = keyEncoded.includes("@") && keyEncoded.split("@").length > 2;

  // Thu nghiem parser new URL(key)
  let parseFailed = false;
  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(keyEncoded);
  } catch {
    parseFailed = true;
  }

  // Ket qua thuc te:
  // WHATWG URL parser giu nguyen %40 trong parsed.password, khong decode thanh raw @
  // do do khong bi double-@ va new URL() parse thanh cong.
  assert.equal(hasDoubleAt, false, "Khong bi loi double-@ vi WHATWG URL giu nguyen %40");
  assert.equal(parseFailed, false, "new URL(key) parse binh thuong, khong bi crash");
  assert.equal(parsedUrl?.username, "user");
  assert.equal(parsedUrl?.password, "p%40ssword");
  assert.equal(parsedUrl?.hostname, "proxy.host");
  assert.equal(parsedUrl?.port, "8080");

  // Thu them voi input raw '@' trong password
  const urlRawAt = "http://user:p@ssword@proxy.host:8080";
  const keyRawAt = poolKey(urlRawAt);
  const parsedRawKey = new URL(keyRawAt);
  assert.equal(
    parsedRawKey.password,
    "p%40ssword",
    "WHATWG URL tu dong percent-encode raw @ thanh %40",
  );
});

// ---------------------------------------------------------------------------
// Ca 2: Proxy URL co query parameter dao thu tu
// Gia thuyet: poolKey(url1) !== poolKey(url2) dan den khong nhan dien cung 1 proxy
// ---------------------------------------------------------------------------
test("Ca 2: Proxy URL co query parameter dao thu tu", () => {
  const url1 = "http://host:8080?timeout=5&retry=2";
  const url2 = "http://host:8080?retry=2&timeout=5";

  const key1 = poolKey(url1);
  const key2 = poolKey(url2);

  // Kiem tra xem 2 URL cung tham so co sinh ra cung poolKey khong
  const keysEqual = key1 === key2;

  // poolKey hien tai lay thang `parsed.search` ma khong sort searchParams:
  // key1: http://host:8080?timeout=5&retry=2
  // key2: http://host:8080?retry=2&timeout=5
  // -> BUG THUC SU: 2 proxy vat ly giong het nhau bi coi la 2 entity rieng biet
  assert.equal(
    keysEqual,
    true,
    "poolKey da chuan hoa thu tu query params thanh cong, key1 === key2",
  );
  assert.equal(key1, "http://host:8080?retry=2&timeout=5");
  assert.equal(key2, "http://host:8080?retry=2&timeout=5");
});

// ---------------------------------------------------------------------------
// Ca 3: Entity da bi xoa trong qua khu (deleted = true trong baseline),
// sau do user co tinh tao lai tren Router B.
// Gia thuyet: planMerge() bi vinh vien khoa trong xung dot delete-edit
// ---------------------------------------------------------------------------
test("Ca 3: Entity da bi xoa (tombstone trong baseline), sau do user tao lai tren Router B", () => {
  const tombstoneBaseline: Baseline[] = [
    {
      resource: "pool",
      key: "pool-recreated",
      field: "url",
      value: "http://proxy.old:8080",
      deleted: true,
      revision: 1,
    },
  ];

  // Router A khong co entity (da xoa truoc do va khong tao lai)
  const snapA = makeSnapshot("router-A", {
    pool: makeScope([], true),
  });

  // Router B: User co tinh tao lai entity voi key "pool-recreated"
  const snapB = makeSnapshot("router-B", {
    pool: makeScope(
      [
        {
          key: "pool-recreated",
          resource: "pool",
          localId: "local-rec-1",
          fields: { url: "http://proxy.new:8080" },
          revision: "rev-rec-1",
        },
      ],
      true,
    ),
  });

  // Chay planMerge lan 1
  const plan1 = planMerge({
    a: snapA,
    b: snapB,
    baselines: tombstoneBaseline,
  });

  // BUG XAC NHAN:
  // 1. planMerge coi day la "Tombstone resurrect conflict on B" -> conflict delete-edit
  assert.equal(plan1.conflicts.length, 1, "Phat sinh xung dot do tombstone trong baseline");
  assert.equal(plan1.conflicts[0].reason, "delete-edit");
  assert.equal(plan1.conflicts[0].key, "pool-recreated");

  // 2. Khong co operation nao duoc sinh ra de propagate tao entity sang Router A
  assert.equal(plan1.operations.length, 0, "Khong tao operation sang Router A");

  // 3. O chu ky sync tiep theo, khi co flag allowRecreate (hoac operator resolve conflict),
  // planMerge cho phep recreate va sinh operation tao entity tren Router A, khong bi khoa vinh vien!
  const plan2 = planMerge({
    a: snapA,
    b: snapB,
    baselines: tombstoneBaseline,
    allowRecreate: ["pool-recreated"],
  });

  assert.equal(plan2.conflicts.length, 0, "Khong con conflict khi da resolve voi allowRecreate");
  assert.equal(plan2.operations.length, 1, "Sinh operation create tren Router A");
  assert.equal(plan2.operations[0].routerId, "router-A");
  assert.equal(plan2.operations[0].kind, "create");
  assert.deepEqual(plan2.operations[0].desired, { url: "http://proxy.new:8080" });
});
