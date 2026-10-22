import fs from 'node:fs';
import path from 'node:path';

export type DataLeaseMode = 'application' | 'maintenance';

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

export function acquireDataLease(
  dataDir: string,
  mode: DataLeaseMode,
): () => void {
  fs.mkdirSync(dataDir, { recursive: true });
  const leaseDir = path.join(dataDir, '.proxy-checker.lease');
  try {
    fs.mkdirSync(leaseDir);
  } catch (error) {
    const ownerPath = path.join(leaseDir, 'owner');
    const owner = fs.existsSync(ownerPath)
      ? fs.readFileSync(ownerPath, 'utf8').trim().split(/\s+/)
      : [];
    const ownerPid = Number(owner[1]);
    if (!Number.isInteger(ownerPid) || processIsAlive(ownerPid)) {
      throw new Error(
        mode === 'maintenance'
          ? `Data directory is in use; stop application writers before maintenance: ${dataDir}`
          : `Data directory is under maintenance: ${dataDir}`,
        { cause: error },
      );
    }
    fs.rmSync(leaseDir, { recursive: true, force: true });
    fs.mkdirSync(leaseDir);
  }
  fs.writeFileSync(path.join(leaseDir, 'owner'), `${mode}\n${process.pid}\n`, {
    encoding: 'utf8',
  });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fs.rmSync(leaseDir, { recursive: true, force: true });
  };
}
