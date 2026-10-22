import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export interface DatabaseInspection {
  tables: Array<{
    name: string;
    sql: string | null;
    columns: unknown[];
    foreignKeys: unknown[];
    rowCount: number;
  }>;
  indexes: Array<{ name: string; tbl_name: string; sql: string | null }>;
  rowDigests: Record<string, string>;
  userVersion: number;
  journalMode: string;
}

export class DatabasePreflightError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DatabasePreflightError';
  }
}

export function inspectDatabase(filePath: string): DatabaseInspection {
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    db.exec('BEGIN');
    const schema = db
      .prepare(
        "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string; sql: string | null }>;
    const rowDigests: Record<string, string> = {};
    const tables = schema.map((table) => {
      const identifier = `"${table.name.replaceAll('"', '""')}"`;
      const rows = db
        .prepare(`SELECT * FROM ${identifier}`)
        .safeIntegers()
        .all();
      const serialized = rows
        .map((row) =>
          JSON.stringify(row, (_key, value) =>
            typeof value === 'bigint' ? { integer: value.toString() } : value,
          ),
        )
        .sort();
      rowDigests[table.name] = crypto
        .createHash('sha256')
        .update(JSON.stringify(serialized))
        .digest('hex');
      return {
        ...table,
        columns: db.prepare(`PRAGMA table_info(${identifier})`).all(),
        foreignKeys: db.prepare(`PRAGMA foreign_key_list(${identifier})`).all(),
        rowCount: rows.length,
      };
    });
    const indexes = db
      .prepare(
        "SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'index' ORDER BY name",
      )
      .all() as DatabaseInspection['indexes'];
    return {
      tables,
      indexes,
      rowDigests,
      userVersion: Number(db.pragma('user_version', { simple: true })),
      journalMode: String(db.pragma('journal_mode', { simple: true })),
    };
  } finally {
    db.close();
  }
}

export function preflightAndBackupDatabase(
  sourcePath: string,
  backupPath: string,
  options: { timeoutMs?: number } = {},
): void {
  if (!fs.existsSync(sourcePath)) {
    throw new DatabasePreflightError(
      'FILE_NOT_FOUND',
      `Database file does not exist: ${sourcePath}`,
    );
  }
  if (fs.existsSync(backupPath)) {
    throw new DatabasePreflightError(
      'DESTINATION_EXISTS',
      `Backup destination already exists: ${backupPath}`,
    );
  }
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  const db = new Database(sourcePath, {
    fileMustExist: true,
    timeout: options.timeoutMs ?? 1000,
  });
  try {
    try {
      db.exec('BEGIN IMMEDIATE; ROLLBACK');
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : undefined;
      if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
        throw new DatabasePreflightError(
          'WRITER_ACTIVE',
          `Database has an active writer: ${sourcePath}`,
        );
      }
      throw error;
    }
    db.prepare('VACUUM INTO ?').run(path.resolve(backupPath));
  } finally {
    db.close();
  }
  const source = inspectDatabase(sourcePath);
  const backup = inspectDatabase(backupPath);
  if (
    JSON.stringify(source.tables) !== JSON.stringify(backup.tables) ||
    JSON.stringify(source.indexes) !== JSON.stringify(backup.indexes) ||
    JSON.stringify(source.rowDigests) !== JSON.stringify(backup.rowDigests)
  ) {
    throw new DatabasePreflightError(
      'BACKUP_MISMATCH',
      `Backup verification failed: ${backupPath}`,
    );
  }
}
