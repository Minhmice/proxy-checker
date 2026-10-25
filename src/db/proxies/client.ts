import { migrateDomain } from "../common/migrate.js";
import { openSqlite } from "../common/client.js";
import * as schema from "./schema.js";

export function openProxyDb(filePath: string) {
  const client = openSqlite(filePath, schema);
  migrateDomain(client.raw, "proxies");
  return client;
}
