import assert from "node:assert/strict";
import fs from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync("src/server/server.ts", "utf8");
const file = ts.createSourceFile("server.ts", source, ts.ScriptTarget.Latest, true);
const maintenance = file.statements.find(
  (statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === "runScheduledMaintenance",
);
const settings = file.statements.find(
  (statement) =>
    ts.isExpressionStatement(statement) &&
    ts.isCallExpression(statement.expression) &&
    statement.expression.expression.getText(file) === "onSettingsChange",
);
assert.ok(maintenance);
assert.ok(settings);

for (const trigger of ["scheduled", "settings"] as const) {
  for (const [name, result, expected] of [
    [
      "backup failure",
      { backup: { ok: false, errors: ["snapshot failed"] }, git: { ok: true } },
      "snapshot failed",
    ],
    [
      "git failure",
      { backup: { ok: true, errors: [] }, git: { ok: false, error: "git failed" } },
      "git failed",
    ],
    ["success", { backup: { ok: true, errors: [] }, git: { ok: true } }, null],
  ] as const) {
    test(`${trigger} backup reports ${name}`, async () => {
      const warnings: string[] = [];
      let calls = 0;
      const context = vm.createContext({
        getSettingsSecrets: () => ({ antigravityRotatorEnabled: false }),
        nineRouterConfigured: () => false,
        unifiedSyncCoordinator: { runUnifiedSyncCycle: async () => ({ started: true }) },
        triggerFullBackupAndSync: async () => {
          calls++;
          return result;
        },
        logScoped: (_scope: string, _operation: string, level: string, message: string) => {
          if (level === "warn") warnings.push(message);
        },
        logActivity: (level: string, message: string) => {
          if (level === "warn") warnings.push(message);
        },
        onSettingsChange: (callback: unknown) => {
          context.settingsCallback = callback;
        },
      });
      const code = `let lastScheduledRotationAt = 0; let lastScheduledBackupAt = 0;\n${maintenance.getText(file)}\n${settings.getText(file)}\nglobalThis.run = runScheduledMaintenance;`;
      vm.runInContext(ts.transpile(code), context);
      if (trigger === "scheduled") await context.run();
      else context.settingsCallback({}, []);
      await nextTurn();
      assert.equal(calls, 1);
      assert.equal(warnings.length, expected ? 1 : 0);
      if (expected) assert.match(warnings[0], new RegExp(expected));
    });
  }
}
