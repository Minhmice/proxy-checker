import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  DatabasePreflightError,
  inspectDatabase,
  preflightAndBackupDatabase,
} from "../src/db/common/sqlite.js";

test("preflight creates a consistent backup without overwriting destination", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-checker-preflight-"));
  const source = path.join(dir, "source.sqlite3");
  const backup = path.join(dir, "backup.sqlite3");
  const db = new Database(source);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO sentinel (id, value) VALUES (?, ?)").run(1, "kept");
  db.close();

  try {
    preflightAndBackupDatabase(source, backup);
    const sourceInspection = inspectDatabase(source);
    const backupInspection = inspectDatabase(backup);
    assert.deepEqual(backupInspection.tables, sourceInspection.tables);
    assert.deepEqual(backupInspection.rowDigests, sourceInspection.rowDigests);
    assert.throws(
      () => preflightAndBackupDatabase(source, backup),
      (error: unknown) => {
        assert.ok(error instanceof DatabasePreflightError);
        assert.equal(error.code, "DESTINATION_EXISTS");
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight rejects a source database with an active writer", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-checker-preflight-"));
  const source = path.join(dir, "source.sqlite3");
  const backup = path.join(dir, "backup.sqlite3");
  const writer = new Database(source);
  writer.exec("CREATE TABLE sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  writer.exec("BEGIN IMMEDIATE");

  try {
    assert.throws(
      () => preflightAndBackupDatabase(source, backup, { timeoutMs: 25 }),
      (error: unknown) => {
        assert.ok(error instanceof DatabasePreflightError);
        assert.equal(error.code, "WRITER_ACTIVE");
        return true;
      },
    );
    assert.equal(fs.existsSync(backup), false);
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight preserves committed WAL rows and detects same-count data drift", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-checker-preflight-"));
  const source = path.join(dir, "source.sqlite3");
  const backup = path.join(dir, "backup.sqlite3");
  const writer = new Database(source);
  try {
    writer.pragma("journal_mode = WAL");
    writer.pragma("wal_autocheckpoint = 0");
    writer.exec(
      "CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL); CREATE INDEX records_value_idx ON records(value)",
    );
    writer.prepare("INSERT INTO records VALUES (?, ?)").run(1, "wal value");
    preflightAndBackupDatabase(source, backup);
    const saved = inspectDatabase(backup);
    assert.deepEqual(saved.rowDigests, inspectDatabase(source).rowDigests);
    writer.prepare("UPDATE records SET value = ? WHERE id = 1").run("changed");
    assert.notDeepEqual(saved.rowDigests, inspectDatabase(source).rowDigests);
    writer.exec("DROP INDEX records_value_idx");
    assert.notDeepEqual(saved.indexes, inspectDatabase(source).indexes);
  } finally {
    writer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("inspection refuses missing databases without creating files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-checker-preflight-"));
  const missing = path.join(dir, "missing.sqlite3");
  try {
    assert.throws(() => inspectDatabase(missing));
    assert.equal(fs.existsSync(missing), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
