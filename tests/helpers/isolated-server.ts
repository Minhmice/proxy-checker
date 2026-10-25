import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface IsolatedServerOptions {
  mode: "development" | "production";
  mockApi: boolean;
}

export interface IsolatedServerInstance {
  baseUrl: string;
  password: string;
  port: number;
  stop(): Promise<void>;
}

function getAvailablePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1", () => {
    const address = srv.address();
    if (!address || typeof address === "string") {
      srv.close(() => reject(new Error("Unable to obtain port")));
      return;
    }
    const port = address.port;
    srv.close(() => resolve(port));
  });
  srv.on("error", reject);
  return promise;
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export async function startIsolatedServer(
  options: IsolatedServerOptions,
): Promise<IsolatedServerInstance> {
  const port = await getAvailablePort();
  const password = `test-pass-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-isolated-srv-"));
  const configPath = path.join(tmpDir, "settings.json");

  // Create isolated settings without live credentials
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      controlPassword: password,
      nineRouterUrl: "http://127.0.0.1:9",
      nineRouterPassword: "",
      nineRouterApiKey: "",
      nineRouterAutoSync: false,
      antigravityRotatorEnabled: false,
      activePoolLimit: 10,
      nineRouterSyncMinutes: 60,
      checkConcurrency: 5,
      checkTimeoutMs: 5000,
      proxyTtlMinutes: 15,
      antigravityActiveLimit: 1,
      antigravityRotateMinutes: 60,
      antigravitySessionThreshold: 20,
    }),
    "utf8",
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    APP_DATA_DIR: tmpDir,
    APP_CONFIG_PATH: configPath,
    CONTROL_PASSWORD: password,
    NODE_ENV: options.mode,
    NEXT_PUBLIC_ENABLE_API_MOCKS: options.mockApi ? "true" : "false",
  };

  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/server/server.ts"], {
    env,
    stdio: "pipe",
  });

  let logs = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    logs += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    logs += chunk.toString();
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  // Poll /api/health until ready or timeout
  const deadline = Date.now() + 25_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`, { cache: "no-store" });
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      // Server not ready yet
    }
    await delay(250);
  }

  if (!ready) {
    child.kill("SIGKILL");
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
    throw new Error(
      `Isolated server failed to start within deadline on port ${port}.\nLogs:\n${logs}`,
    );
  }

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    child.kill("SIGTERM");
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    await promise;
    try {
      fs.rmSync(tmpDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    } catch {}
  };

  return {
    baseUrl,
    password,
    port,
    stop,
  };
}
