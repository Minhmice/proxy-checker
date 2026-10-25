import { migrateDomain } from "../common/migrate.js";
import { openSqlite, type SqliteClient } from "../common/client.js";
import * as schema from "./schema.js";

export type SyncDbClient = SqliteClient<typeof schema>;

export function openSyncDb(filePath: string): SyncDbClient {
  const client = openSqlite(filePath, schema);
  migrateDomain(client.raw, "sync");
  return client;
}
