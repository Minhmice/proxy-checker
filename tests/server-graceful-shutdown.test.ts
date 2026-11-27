import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// Signals are emitted in-process via process.emit (child.kill("SIGTERM") force-kills on Windows).
const preload = `
import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/package.json");
const nextPath = require.resolve("next");
const handler = (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/slow") {
    console.log("slow-start");
    setTimeout(() => res.end("done"), Number(url.searchParams.get("ms") || 1000));
  } else if (url.pathname === "/hang") {
    console.log("hang-start");
  } else if (url.pathname.startsWith("/signals/")) {
    res.setHeader("Connection", "close");
    res.end("ok");
    setImmediate(() => {
      for (const name of url.pathname.slice(9).split(",")) process.emit(name, name);
    });
  } else {
    res.end("ok");
  }
};
require.cache[nextPath] = { id: nextPath, filename: nextPath, loaded: true, exports: () => ({
  prepare: async () => {}, getRequestHandler: () => handler,
}) };
`;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const srv = net.createServer();
  srv.on("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address() as net.AddressInfo;
    srv.close(() => resolve(port));
  });
  return promise;
}

interface Harness {
  child: ChildProcess;
  dir: string;
  port: number;
  logs: () => string;
  exited: Promise<number | null>;
  waitFor(text: string, count?: number): Promise<void>;
  cleanup(): void;
}

async function start(): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "server-shutdown-test-"));
  const preloadPath = path.join(dir, "preload.mjs");
  fs.writeFileSync(preloadPath, preload);
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({ nineRouterUrl: "", antigravityRotatorEnabled: false }),
  );
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_DATA_DIR: dir,
    APP_BACKUP_DIR: path.join(dir, "backups"),
    APP_CONFIG_PATH: path.join(dir, "settings.json"),
    NODE_ENV: "development",
    PORT: String(port),
  };
  delete env.NODE_OPTIONS;
  delete env.npm_lifecycle_event;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--import", pathToFileURL(preloadPath).href, "src/server/server.ts"],
    { cwd: process.cwd(), env, stdio: "pipe" },
  );
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exit = Promise.withResolvers<number | null>();
  child.on("exit", (code) => exit.resolve(code));
  const harness: Harness = {
    child,
    dir,
    port,
    logs: () => output,
    exited: exit.promise,
    async waitFor(text, count = 1) {
      const deadline = Date.now() + 30_000;
      while (output.split(text).length - 1 < count) {
        if (Date.now() > deadline) throw new Error(`timeout waiting for "${text}"\n${output}`);
        await delay(25);
      }
    },
    cleanup() {
      child.kill("SIGKILL");
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    },
  };
  await harness.waitFor("listening on");
  return harness;
}

const leasePath = (h: Harness) => path.join(h.dir, ".proxy-checker.lease");

function connectRefused(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = net.connect(port, "127.0.0.1");
  socket.on("connect", () => {
    socket.destroy();
    resolve(false);
  });
  socket.on("error", () => resolve(true));
  return promise;
}

test("graceful shutdown lets in-flight request finish, then releases lease and exits 0", async () => {
  const h = await start();
  try {
    assert.ok(fs.existsSync(leasePath(h)));
    const inflight = fetch(`http://127.0.0.1:${h.port}/slow?ms=1500`).then((r) => r.text());
    await h.waitFor("slow-start");
    await fetch(`http://127.0.0.1:${h.port}/signals/SIGTERM`);
    assert.equal(await inflight, "done");
    assert.equal(await h.exited, 0, h.logs());
    assert.match(h.logs(), /Shutdown complete/);
    assert.ok(!fs.existsSync(leasePath(h)));
  } finally {
    h.cleanup();
  }
});

test("graceful shutdown refuses new connections while draining", async () => {
  const h = await start();
  try {
    const inflight = fetch(`http://127.0.0.1:${h.port}/slow?ms=3000`).then((r) => r.text());
    await h.waitFor("slow-start");
    await fetch(`http://127.0.0.1:${h.port}/signals/SIGINT`);
    const deadline = Date.now() + 2000;
    let refused = false;
    while (!refused && Date.now() < deadline) {
      refused = await connectRefused(h.port);
      if (!refused) await delay(25);
    }
    assert.ok(refused, "new connection should be refused during drain");
    assert.equal(h.child.exitCode, null, "process must still wait for in-flight request");
    assert.equal(await inflight, "done");
    assert.equal(await h.exited, 0, h.logs());
  } finally {
    h.cleanup();
  }
});

test("hung request is force-exited after 10s timeout", { timeout: 30_000 }, async () => {
  const h = await start();
  try {
    const hung = fetch(`http://127.0.0.1:${h.port}/hang`).catch(() => {});
    await h.waitFor("hang-start");
    const started = Date.now();
    await fetch(`http://127.0.0.1:${h.port}/signals/SIGTERM`);
    assert.equal(await h.exited, 1, h.logs());
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 9_000 && elapsed < 20_000, `elapsed ${elapsed}ms`);
    assert.match(h.logs(), /Forcing exit: graceful shutdown timeout/);
    assert.ok(!fs.existsSync(leasePath(h)));
    await hung;
  } finally {
    h.cleanup();
  }
});

test("repeated signals start shutdown once and second signal forces exit", async () => {
  const h = await start();
  try {
    const hung = fetch(`http://127.0.0.1:${h.port}/hang`).catch(() => {});
    await h.waitFor("hang-start");
    const started = Date.now();
    await fetch(`http://127.0.0.1:${h.port}/signals/SIGTERM,SIGINT,SIGTERM`);
    assert.equal(await h.exited, 1, h.logs());
    assert.ok(Date.now() - started < 8_000, "second signal must not wait for timeout");
    assert.equal(h.logs().split("Shutdown started").length - 1, 1, h.logs());
    assert.match(h.logs(), /Forcing exit: second SIGINT during shutdown/);
    assert.ok(!fs.existsSync(leasePath(h)));
    await hung;
  } finally {
    h.cleanup();
  }
});
