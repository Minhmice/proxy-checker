import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const preload = `
import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/package.json");
const nextPath = require.resolve("next");
require.cache[nextPath] = { id: nextPath, filename: nextPath, loaded: true, exports: () => ({
  prepare: async () => {}, getRequestHandler: () => () => {},
}) };
import http from "node:http";
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  this.once("listening", () => {
    setImmediate(() => {
      const mode = process.env.FAILURE_TEST_MODE;
      if (mode === "exception" || mode === "reset-exception") {
        const error = new Error(mode === "exception" ? "fatal exception marker" : "ECONNRESET fatal marker");
        if (mode === "reset-exception") error.code = "ECONNRESET";
        throw error;
      }
      if (mode === "rejection") {
        Promise.reject(new Error("fatal rejection marker"));
        return;
      }
      let reply = "";
      const socket = { writable: true, end(value) { reply = value; } };
      const error = new Error("client error");
      if (mode === "reset") error.code = "ECONNRESET";
      this.emit("clientError", error, socket);
      const expected = mode === "reset" ? "" : "HTTP/1.1 400 Bad Request\\r\\n\\r\\n";
      if (reply !== expected) throw new Error("unexpected clientError reply: " + reply);
      console.log("local clientError handled");
      process.exit(0);
    });
  });
  return listen.apply(this, args.filter((arg) => typeof arg !== "function"));
};
`;

for (const [mode, marker] of [
  ["exception", "fatal exception marker"],
  ["reset-exception", "ECONNRESET fatal marker"],
  ["rejection", "fatal rejection marker"],
  ["reset", "local clientError handled"],
  ["bad-request", "local clientError handled"],
] as const) {
  test(`server process handles ${mode}`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "server-failure-test-"));
    try {
      const preloadPath = path.join(dir, "preload.mjs");
      fs.writeFileSync(preloadPath, preload);
      fs.writeFileSync(
        path.join(dir, "settings.json"),
        JSON.stringify({
          nineRouterUrl: "",
          antigravityRotatorEnabled: false,
        }),
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        APP_DATA_DIR: dir,
        APP_BACKUP_DIR: path.join(dir, "backups"),
        APP_CONFIG_PATH: path.join(dir, "settings.json"),
        NODE_ENV: "development",
        PORT: "0",
        FAILURE_TEST_MODE: mode,
      };
      delete env.NODE_OPTIONS;
      delete env.npm_lifecycle_event;
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", "--import", pathToFileURL(preloadPath).href, "src/server/server.ts"],
        {
          cwd: process.cwd(),
          env,
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      assert.ifError(child.error);
      assert.match(child.stdout + child.stderr, new RegExp(marker));
      assert.equal(child.status, mode === "reset" || mode === "bad-request" ? 0 : 1, child.stderr);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
