import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export type DatabaseDomain = 'proxies' | 'fleet' | 'rotation';

export function migrateDomain(
  raw: Database.Database,
  domain: DatabaseDomain,
): void {
  const folder = fileURLToPath(
    new URL(`../migrations/${domain}/`, import.meta.url),
  );
  const journal = JSON.parse(
    fs.readFileSync(path.join(folder, 'meta', '_journal.json'), 'utf8'),
  ) as {
    entries: Array<{ tag: string; when: number }>;
  };
  const baseline = fs.readFileSync(
    path.join(folder, `${journal.entries[0].tag}.sql`),
    'utf8',
  );
  const hash = crypto.createHash('sha256').update(baseline).digest('hex');
  const expected = new Database(':memory:');
  try {
    expected.exec(baseline);
    const tables = expected
      .prepare(
        "SELECT name, sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string; sql: string }>;
    raw
      .transaction(() => {
        const knownTables = new Set(tables.map((table) => table.name));
        const existingTables = raw
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .all() as Array<{ name: string }>;
        const legacyAuditTables: Record<string, true> = {
          proxy_audits: true,
          proxy_audit_risks: true,
          audit_jobs: true,
          proxy_diagnostics: true,
        };
        if (domain === 'proxies') {
          raw.exec(`
            DROP TABLE IF EXISTS proxy_audit_risks;
            DROP TABLE IF EXISTS proxy_audits;
            DROP TABLE IF EXISTS audit_jobs;
            DROP TABLE IF EXISTS proxy_diagnostics;
          `);
        }
        for (const table of existingTables) {
          if (
            !knownTables.has(table.name) &&
            table.name !== '__drizzle_migrations' &&
            !(domain === 'proxies' && table.name in legacyAuditTables)
          ) {
            throw new Error(`Unknown ${domain} database table: ${table.name}`);
          }
        }
        let seedFleetRevision = false;
        for (const table of tables) {
          const name = `"${table.name.replaceAll('"', '""')}"`;
          const columns = raw
            .prepare(`PRAGMA table_info(${name})`)
            .all() as Array<{ name: string; type: string }>;
          if (columns.length === 0) {
            raw.exec(table.sql);
            continue;
          }
          const wanted = expected
            .prepare(`PRAGMA table_info(${name})`)
            .all() as Array<{
            name: string;
            type: string;
            notnull: number;
            dflt_value: string | null;
            pk: number;
          }>;
          for (const column of columns) {
            const target = wanted.find((item) => item.name === column.name);
            if (!target) {
              throw new Error(
                `Unknown column in ${table.name}: ${column.name}`,
              );
            }
            const actualType = column.type.toUpperCase();
            const targetType = target.type.toUpperCase();
            const isNumeric = (t: string) =>
              ['INTEGER', 'REAL', 'NUMERIC', 'FLOAT', 'DOUBLE'].includes(t);
            const compatible =
              actualType === targetType ||
              (isNumeric(actualType) && isNumeric(targetType));
            if (!compatible) {
              throw new Error(
                `Schema mismatch: ${table.name}.${column.name} (${actualType} vs ${targetType})`,
              );
            }
          }
          for (const column of wanted) {
            if (columns.some((existing) => existing.name === column.name))
              continue;
            if (column.pk)
              throw new Error(
                `Missing primary key: ${table.name}.${column.name}`,
              );
            if (column.notnull && column.dflt_value === null)
              throw new Error(
                `Missing required column: ${table.name}.${column.name}`,
              );
            if (
              table.name === 'fleet_nodes' &&
              column.name === 'desired_revision'
            )
              seedFleetRevision = true;
            const identifier = `"${column.name.replaceAll('"', '""')}"`;
            raw.exec(
              `ALTER TABLE ${name} ADD COLUMN ${identifier} ${column.type}${column.notnull ? ' NOT NULL' : ''}${column.dflt_value === null ? '' : ` DEFAULT ${column.dflt_value}`}`,
            );
          }
        }
        if (seedFleetRevision) {
          raw
            .prepare(
              `UPDATE fleet_nodes SET desired_revision = 1 + MAX(?, COALESCE(updated_at,0), COALESCE((SELECT MAX(updated_at) FROM fleet_proxy_endpoints WHERE node_id=fleet_nodes.id),0), COALESCE((SELECT MAX(current_revision) FROM fleet_proxy_endpoints WHERE node_id=fleet_nodes.id),0))`,
            )
            .run(Date.now());
        }
        const indexes = expected
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL",
          )
          .all() as Array<{ sql: string }>;
        for (const index of indexes)
          raw.exec(
            index.sql.replace(
              /^CREATE (UNIQUE )?INDEX /i,
              'CREATE $1INDEX IF NOT EXISTS ',
            ),
          );
        raw.exec(
          'CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC NOT NULL)',
        );
        const recorded = raw
          .prepare(
            'SELECT hash FROM __drizzle_migrations ORDER BY created_at LIMIT 1',
          )
          .get() as { hash: string } | undefined;
        if (recorded && recorded.hash !== hash)
          throw new Error(`Migration checksum mismatch: ${domain}`);
        if (!recorded)
          raw
            .prepare(
              'INSERT INTO __drizzle_migrations(hash,created_at) VALUES (?,?)',
            )
            .run(hash, journal.entries[0].when);
      })
      .immediate();
  } finally {
    expected.close();
  }
}
