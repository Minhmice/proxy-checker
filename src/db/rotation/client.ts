import { migrateDomain } from "../common/migrate.js";
import { openSqlite } from "../common/client.js";
import * as schema from "./schema.js";

export function openRotationDb(filePath: string) {
  const client = openSqlite(filePath, schema, "NORMAL");
  migrateDomain(client.raw, "rotation");
  return client;
}
