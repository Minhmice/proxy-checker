import test from "node:test";
import assert from "node:assert/strict";
import { isAbortError } from "../src/lib/request-lifecycle.js";

test("isAbortError recognizes DOM abort cancellations without swallowing other errors", () => {
  assert.equal(isAbortError(new DOMException("signal aborted", "AbortError")), true);
  const errorAbort = new Error("signal is aborted without reason");
  errorAbort.name = "AbortError";
  assert.equal(isAbortError(errorAbort), true);
  assert.equal(isAbortError(new Error("network failed")), false);
  assert.equal(isAbortError("AbortError"), false);
  assert.equal(isAbortError(null), false);
});
