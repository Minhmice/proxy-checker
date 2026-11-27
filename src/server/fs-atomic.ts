import fs from "node:fs";
import path from "node:path";

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function isTransientLock(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    (err.code === "EPERM" || err.code === "EBUSY")
  );
}

export function replaceFileAtomicSync(
  source: string,
  destination: string,
  rename: (from: string, to: string) => void = fs.renameSync,
): void {
  const delaysMs = [10, 25, 50, 100];
  for (let attempt = 0; ; attempt++) {
    try {
      rename(source, destination);
      return;
    } catch (err) {
      if (!isTransientLock(err) || attempt >= delaysMs.length) throw err;
      Atomics.wait(sleepCell, 0, 0, delaysMs[attempt]);
    }
  }
}

export function writeJsonAtomicSync(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  const json = JSON.stringify(data, null, 2);
  try {
    fs.writeFileSync(temp, json);
    replaceFileAtomicSync(temp, filePath);
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Preserve the write or rename error.
    }
    throw err;
  }
}
