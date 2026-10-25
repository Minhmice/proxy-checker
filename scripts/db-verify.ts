import path from "node:path";
import { inspectDatabase } from "../src/db/common/sqlite.js";

const beforeDir = path.resolve(process.argv[2] || "data");
const afterDir = path.resolve(process.argv[3] || "data");
const files = ["proxies.sqlite3", "fleet.sqlite3", "antigravity-rotation.sqlite3"];

for (const file of files) {
  const before = inspectDatabase(path.join(beforeDir, file));
  const after = inspectDatabase(path.join(afterDir, file));
  const same =
    JSON.stringify(before.tables) === JSON.stringify(after.tables) &&
    JSON.stringify(before.indexes) === JSON.stringify(after.indexes) &&
    JSON.stringify(before.rowDigests) === JSON.stringify(after.rowDigests);
  if (!same) throw new Error(`Database verification failed: ${file}`);
  console.log(`Verified ${file}: ${before.tables.length} tables`);
}
