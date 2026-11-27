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

test("partial ENOSPC write removes temp and preserves original file", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-atomic-"));
  const file = path.join(dir, "state.json");
  const temp = `${file}.${process.pid}.tmp`;
  const write = fs.writeFileSync;
  const error = lockError("ENOSPC");
  try {
    write(file, "original");
    t.mock.method(fs, "writeFileSync", ((target: fs.PathOrFileDescriptor) => {
      write(target, "partial");
      throw error;
    }) as typeof fs.writeFileSync);
    assert.throws(
      () => writeJsonAtomicSync(file, { v: 1 }),
      (err) => err === error,
    );
    assert.equal(fs.readFileSync(file, "utf8"), "original");
    assert.equal(fs.existsSync(temp), false);
  } finally {
    t.mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("serialization failure leaves existing temp untouched", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-atomic-"));
  const file = path.join(dir, "state.json");
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, "unrelated");
    assert.throws(() => writeJsonAtomicSync(file, { value: 1n }), TypeError);
    assert.equal(fs.readFileSync(temp, "utf8"), "unrelated");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanup failure does not replace write error", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-atomic-"));
  const error = lockError("ENOSPC");
  try {
    t.mock.method(fs, "writeFileSync", () => {
      throw error;
    });
    t.mock.method(fs, "rmSync", () => {
      throw new Error("cleanup failed");
    });
    assert.throws(
      () => writeJsonAtomicSync(path.join(dir, "state.json"), {}),
      (err) => err === error,
    );
  } finally {
    t.mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
