import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function maintenanceHarness(
  runCycle: (options: { force: boolean; rotation: boolean }) => Promise<object>,
) {
  const source = fs.readFileSync("src/server/server.ts", "utf8");
  const file = ts.createSourceFile("server.ts", source, ts.ScriptTarget.Latest, true);
  const fn = file.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "runScheduledMaintenance",
  );
  assert.ok(fn);
  let now = 1_800_000;
  let backups = 0;
  const context = vm.createContext({
    getSettingsSecrets: () => ({ antigravityRotatorEnabled: true, antigravityRotateMinutes: 1 }),
    nineRouterConfigured: () => true,
    Date: { now: () => now },
    logScoped: () => {},
    unifiedSyncCoordinator: { runUnifiedSyncCycle: runCycle },
    triggerFullBackupAndSync: async () => {
      backups++;
      return { backup: { ok: true, errors: [] }, git: { ok: true } };
    },
  });
  const code = `let lastScheduledRotationAt = 0; let lastScheduledBackupAt = 0;\n${fn.getText(file)}\nglobalThis.run = runScheduledMaintenance;`;
  vm.runInContext(ts.transpile(code), context);
  return {
    run: context.run as () => Promise<void>,
    setNow: (value: number) => {
      now = value;
    },
    backups: () => backups,
  };
}

test("busy maintenance retries rotation when free, then waits until due", async () => {
  const requested: boolean[] = [];
  const reports = [
    { started: false, running: true },
    { started: true, running: false, rotationSkipped: true, rotationSkipReason: "already-running" },
    { started: true, running: false },
    { started: true, running: false, rotationSkipped: true },
  ];
  const h = maintenanceHarness(async (options) => {
    requested.push(options.rotation);
    return reports.shift()!;
  });
  await h.run();
  h.setNow(1_815_000);
  await h.run();
  h.setNow(1_830_000);
  await h.run();
  h.setNow(1_845_000);
  await h.run();
  assert.deepEqual(requested, [true, true, true, false]);
  assert.equal(h.backups(), 1);
});

test("failed rotation counts as an attempt", async () => {
  const requested: boolean[] = [];
  const h = maintenanceHarness(async (options) => {
    requested.push(options.rotation);
    return { started: true, running: false, error: "failed" };
  });
  await h.run();
  h.setNow(1_815_000);
  await h.run();
  assert.deepEqual(requested, [true, false]);
});

test("older overlapping completion cannot move rotation timestamp backwards", async () => {
  const requested: boolean[] = [];
  const firstResult = Promise.withResolvers<object>();
  const h = maintenanceHarness((options) => {
    requested.push(options.rotation);
    if (requested.length === 1) return firstResult.promise;
    return Promise.resolve({ started: true, running: false });
  });
  const first = h.run();
  h.setNow(1_860_000);
  await h.run();
  firstResult.resolve({ started: true, running: false });
  await first;
  h.setNow(1_875_000);
  await h.run();
  assert.deepEqual(requested, [true, true, false]);
});
