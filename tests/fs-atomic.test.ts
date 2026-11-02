import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { replaceFileAtomicSync, writeJsonAtomicSync } from "../src/server/fs-atomic.js";

function lockError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

test("transient EPERM is retried until rename succeeds", () => {
  let calls = 0;
  replaceFileAtomicSync("a", "b", () => {
    calls++;
    if (calls < 3) throw lockError("EPERM");
  });
  assert.equal(calls, 3);
});

test("persistent lock throws after bounded retries, never copies", () => {
  let calls = 0;
  assert.throws(
    () =>
      replaceFileAtomicSync("a", "b", () => {
        calls++;
        throw lockError("EBUSY");
      }),
    /EBUSY/,
  );
  assert.equal(calls, 5);
});

test("non-lock errors are not retried", () => {
  let calls = 0;
  assert.throws(() =>
    replaceFileAtomicSync("a", "b", () => {
      calls++;
      throw lockError("ENOENT");
    }),
  );
  assert.equal(calls, 1);
});

test("writeJsonAtomicSync replaces content and leaves no temp file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-atomic-"));
  try {
    const file = path.join(dir, "state.json");
    writeJsonAtomicSync(file, { v: 1 });
    writeJsonAtomicSync(file, { v: 2 });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { v: 2 });
    assert.deepEqual(fs.readdirSync(dir), ["state.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
