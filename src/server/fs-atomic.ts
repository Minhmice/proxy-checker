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

/**
 * Atomic rename with short retry. Windows rejects rename (EPERM/EBUSY) while any
 * process holds the destination open; that lock is usually released within ms.
 * Never falls back to copy: a non-atomic write could leave a torn file on crash.
 */
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
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  try {
    replaceFileAtomicSync(temp, filePath);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}
