import { openSqlite } from "../common/client.js";
import * as schema from "./schema.js";

export function openFleetDb(filePath: string) {
  return openSqlite(filePath, schema);
}
