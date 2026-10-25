import { Client } from "ssh2";

export interface NineRouterServerTarget {
  id: string;
  name: string;
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
}

export const TARGET_NINEROUTER_SERVERS: NineRouterServerTarget[] = [
  {
    id: "server-lan",
    name: "Master Node (192.168.1.54)",
    host: process.env.NINEROUTER_LAN_HOST || "192.168.1.54",
    port: Number(process.env.NINEROUTER_LAN_PORT || 22),
    username: process.env.NINEROUTER_LAN_SSH_USER || "minhmice",
    password: process.env.NINEROUTER_LAN_SSH_PASS || "minh2908",
  },
  {
    id: "server-vpn",
    name: "Tailscale Node (100.73.175.42)",
    host: process.env.NINEROUTER_VPN_HOST || "100.73.175.42",
    port: Number(process.env.NINEROUTER_VPN_PORT || 22),
    username: process.env.NINEROUTER_VPN_SSH_USER || "netnut",
    password: process.env.NINEROUTER_VPN_SSH_PASS || "netnut2026@",
    privateKey: process.env.NINEROUTER_VPN_SSH_KEY || undefined,
  },
];

export interface InteractiveUpgradeResult {
  serverId: string;
  serverName: string;
  host: string;
  status: "pending" | "running" | "success" | "failed";
  output: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
}

export interface InteractiveJob {
  id: string;
  createdAt: number;
  completedAt?: number;
  status: "running" | "completed" | "failed";
  targets: Record<string, InteractiveUpgradeResult>;
  done?: Promise<InteractiveJob>;
}

export interface NineRouterInteractiveSshRunner {
  runUpgradeSequence(target: NineRouterServerTarget): Promise<InteractiveUpgradeResult>;
}

/**
 * Connects over SSH with PTY (pseudo-terminal) allocated, runs:
 * 1. sudo npm i -g 9router@latest --prefer-online
 * 2. 9router (starts server & shows menu)
 * 3. Sends Enter (selects "Web UI (Open in Browser)")
 * 4. Waits for "Press Enter to go back to menu..."
 * 5. Sends Enter (goes back to menu)
 * 6. Sends Down Arrow twice + Enter (selects "Hide to Tray (Background)")
 */
export async function executeNineRouterInteractiveUpgrade(
  target: NineRouterServerTarget,
  timeoutMs = 180_000,
): Promise<InteractiveUpgradeResult> {
  const startedAt = Date.now();
  const { promise, resolve } = Promise.withResolvers<InteractiveUpgradeResult>();
  const client = new Client();
  let settled = false;
  let fullOutput = "";

  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      try {
        client.destroy();
      } catch {}
      resolve({
        serverId: target.id,
        serverName: target.name,
        host: target.host,
        status: "failed",
        output: fullOutput,
        error: "Execution timed out",
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      });
    }
  }, timeoutMs);

  function finish(status: "success" | "failed", error?: string) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try {
      client.end();
    } catch {}
    resolve({
      serverId: target.id,
      serverName: target.name,
      host: target.host,
      status,
      output: fullOutput,
      error,
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    });
  }

  client
    .on("error", (err: Error) => {
      fullOutput += `\n[SSH Connection Error]: ${err.message}`;
      finish("failed", err.message);
    })
    .on("ready", () => {
      // Allocate interactive PTY (pseudo-terminal) so 9router TUI/raw-mode works properly
      client.shell(
        {
          term: "xterm-256color",
          cols: 100,
          rows: 30,
        },
        (err, stream) => {
          if (err) {
            fullOutput += `\n[Shell PTY Error]: ${err.message}`;
            finish("failed", err.message);
            return;
          }
          let phase:
            | "waiting_shell"
            | "updating"
            | "starting_router"
            | "web_selected"
            | "returning_to_menu"
            | "hiding"
            | "done" = "waiting_shell";
          let routerStartedTimeout: NodeJS.Timeout | null = null;
          let webReturnTimeout: NodeJS.Timeout | null = null;
          let menuNavTimeout: NodeJS.Timeout | null = null;
          let slidingCleanBuffer = "";
          let hasUpdateNoticeInMenu = false;
          let sudoSent = false;

          const startNpmUpdate = () => {
            if (phase !== "waiting_shell") return;
            phase = "updating";
            slidingCleanBuffer = "";
            fullOutput += "\n[Action]: Shell ready, starting npm update...\n";
            stream.write(
              `sudo -S npm i -g 9router@latest --prefer-online && echo "###NPM_UPGRADE_DONE###" || echo "###NPM_UPGRADE_FAILED###"\n`,
            );
          };

          // Fallback: if shell prompt character is not detected within 2.5s, start update anyway
          const shellReadyTimer = setTimeout(startNpmUpdate, 2500);
          stream.on("data", (chunk: Buffer) => {
            const rawText = chunk.toString("utf8");
            fullOutput += rawText;

            // Maintain a clean, ANSI-stripped sliding window of the last 4000 characters
            const cleanText = rawText.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
            slidingCleanBuffer = (slidingCleanBuffer + cleanText).slice(-4000);

            // Handle sudo password prompt (checks both recent chunk and trailing sliding buffer)
            if (
              !sudoSent &&
              (/(?:password|Password):\s*$/i.test(slidingCleanBuffer.trim()) ||
                cleanText.includes("Password:") ||
                cleanText.includes("[sudo] password") ||
                cleanText.includes("password for")) &&
              target.password
            ) {
              sudoSent = true;
              stream.write(`${target.password}\n`);
            } else if (
              cleanText.includes("try again") ||
              cleanText.includes("Authentication failed")
            ) {
              sudoSent = false;
            }

            // Phase 0: Waiting for initial login shell prompt ($ or #)
            if (phase === "waiting_shell") {
              if (/[#$]\s*$/.test(slidingCleanBuffer.trim())) {
                clearTimeout(shellReadyTimer);
                startNpmUpdate();
                return;
              }
            }

            // Phase 1: Waiting for npm update to finish (must match actual output, not the command echo)
            else if (phase === "updating") {
              const hasFailureSignal =
                slidingCleanBuffer.includes("###NPM_UPGRADE_FAILED###") &&
                [...slidingCleanBuffer.matchAll(/###NPM_UPGRADE_FAILED###/g)].some(
                  (m) =>
                    !/echo\s+["']?###NPM_UPGRADE_FAILED###/.test(
                      slidingCleanBuffer.slice(
                        Math.max(0, (m.index ?? 0) - 30),
                        (m.index ?? 0) + 30,
                      ),
                    ),
                );

              const hasDoneSignal =
                slidingCleanBuffer.includes("###NPM_UPGRADE_DONE###") &&
                [...slidingCleanBuffer.matchAll(/###NPM_UPGRADE_DONE###/g)].some(
                  (m) =>
                    !/echo\s+["']?###NPM_UPGRADE_DONE###/.test(
                      slidingCleanBuffer.slice(
                        Math.max(0, (m.index ?? 0) - 30),
                        (m.index ?? 0) + 30,
                      ),
                    ),
                );

              if (hasFailureSignal) {
                finish("failed", "npm package installation failed on remote server");
                return;
              }
              if (hasDoneSignal) {
                phase = "starting_router";
                slidingCleanBuffer = "";
                fullOutput += "\n[Action]: npm update completed, starting 9router...\n";
                stream.write("9router\n");

                // Safety timeout in case menu prompt text varies
                routerStartedTimeout = setTimeout(() => {
                  if (phase === "starting_router") {
                    phase = "web_selected";
                    stream.write("\r");
                  }
                }, 15_000);
              }
            }

            // Phase 2: 9router started, menu displayed
            else if (phase === "starting_router") {
              if (
                slidingCleanBuffer.includes("Choose Interface") ||
                slidingCleanBuffer.includes("Web UI") ||
                slidingCleanBuffer.includes("Terminal UI") ||
                slidingCleanBuffer.includes("Hide to Tray")
              ) {
                if (routerStartedTimeout) clearTimeout(routerStartedTimeout);

                hasUpdateNoticeInMenu = /Update to v[0-9.]+/i.test(slidingCleanBuffer);
                phase = "web_selected";
                slidingCleanBuffer = "";
                fullOutput += `\n[Action]: Selecting Web UI (UpdateNotice=${hasUpdateNoticeInMenu})...\n`;

                if (hasUpdateNoticeInMenu) {
                  stream.write("\x1b[B"); // Move down to "Web UI"
                  setTimeout(() => {
                    stream.write("\r"); // Select "Web UI"
                  }, 300);
                } else {
                  setTimeout(() => {
                    stream.write("\r"); // Item 0 is "Web UI"
                  }, 300);
                }
              }
            }

            // Phase 3: Web UI opened, waiting for return prompt
            else if (phase === "web_selected") {
              if (!webReturnTimeout) {
                // Safety timeout: on headless remote Linux, xdg-open may not render pause prompt; return after 8s
                webReturnTimeout = setTimeout(() => {
                  if (phase === "web_selected") {
                    phase = "returning_to_menu";
                    slidingCleanBuffer = "";
                    fullOutput +=
                      "\n[Action]: Safety timer elapsed in Web UI, returning to menu...\n";
                    stream.write("\r");
                  }
                }, 8000);
              }

              if (
                slidingCleanBuffer.includes("Press Enter to go back") ||
                slidingCleanBuffer.includes("Press Enter to continue") ||
                slidingCleanBuffer.includes("go back to menu")
              ) {
                if (webReturnTimeout) {
                  clearTimeout(webReturnTimeout);
                  webReturnTimeout = null;
                }
                phase = "returning_to_menu";
                slidingCleanBuffer = "";
                fullOutput += "\n[Action]: Back prompt received, returning to menu...\n";
                stream.write("\r");
              }
            }

            // Phase 4: Returning to menu, waiting for Choose Interface to reappear
            else if (phase === "returning_to_menu") {
              const triggerHide = () => {
                if (phase !== "returning_to_menu") return;
                if (menuNavTimeout) {
                  clearTimeout(menuNavTimeout);
                  menuNavTimeout = null;
                }
                phase = "hiding";
                slidingCleanBuffer = "";
                fullOutput += "\n[Action]: Back at menu, navigating to Hide to Tray...\n";

                const downArrowCount = hasUpdateNoticeInMenu ? 3 : 2;
                setTimeout(() => {
                  for (let i = 0; i < downArrowCount; i++) {
                    setTimeout(() => {
                      stream.write("\x1b[B");
                    }, i * 350);
                  }
                  setTimeout(
                    () => {
                      stream.write("\r");
                    },
                    downArrowCount * 350 + 350,
                  );
                }, 600);
              };

              if (!menuNavTimeout) {
                // Fallback: if menu re-render string is missed, trigger navigation after 5s
                menuNavTimeout = setTimeout(triggerHide, 5000);
              }

              if (slidingCleanBuffer.includes("Choose Interface")) {
                triggerHide();
              }
            }

            // Phase 5: Hidden in background / tray
            else if (phase === "hiding") {
              if (
                slidingCleanBuffer.includes("running in background") ||
                slidingCleanBuffer.includes("Switching to tray mode") ||
                slidingCleanBuffer.includes("running in tray") ||
                slidingCleanBuffer.includes("close this terminal") ||
                slidingCleanBuffer.includes("You can close this terminal")
              ) {
                phase = "done";
                fullOutput += "\n[Success]: 9Router is now running in background/tray.\n";
                setTimeout(() => {
                  finish("success");
                }, 1000);
              }
            }
          });

          stream.on("close", () => {
            if (phase === "done" || fullOutput.includes("running in background")) {
              finish("success");
            } else {
              finish("failed", "Interactive session closed before completion");
            }
          });

          // Waiting for shell prompt before kicking off npm update
          // shellReadyTimer will trigger fallback if prompt is delayed
        },
      );
    })
    .connect({
      host: target.host,
      port: target.port || 22,
      username: target.username,
      password: target.password,
      privateKey: target.privateKey,
      readyTimeout: 20_000,
    });

  return promise;
}

export class NineRouterServerManager {
  private jobs = new Map<string, InteractiveJob>();
  private activeServerLocks = new Set<string>();
  private runner: (target: NineRouterServerTarget) => Promise<InteractiveUpgradeResult>;
  private maxStoredJobs = 50;

  constructor(runner?: (target: NineRouterServerTarget) => Promise<InteractiveUpgradeResult>) {
    this.runner = runner || executeNineRouterInteractiveUpgrade;
  }

  getJob(jobId: string): InteractiveJob | null {
    return this.jobs.get(jobId) || null;
  }

  listJobs(): InteractiveJob[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  getTargets(): NineRouterServerTarget[] {
    return TARGET_NINEROUTER_SERVERS;
  }

  isServerLocked(serverId: string): boolean {
    return this.activeServerLocks.has(serverId);
  }

  async startInteractiveUpgrade(serverIds?: string[]): Promise<InteractiveJob> {
    const targets =
      serverIds && serverIds.length > 0
        ? TARGET_NINEROUTER_SERVERS.filter((t) => serverIds.includes(t.id))
        : TARGET_NINEROUTER_SERVERS;

    // Check concurrency locks on target servers
    for (const target of targets) {
      if (this.activeServerLocks.has(target.id)) {
        throw new Error(
          `An upgrade job is already currently running on ${target.name} (${target.host})`,
        );
      }
    }

    // Acquire locks
    for (const target of targets) {
      this.activeServerLocks.add(target.id);
    }

    const jobId = `upg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const targetMap: Record<string, InteractiveUpgradeResult> = {};

    for (const target of targets) {
      targetMap[target.id] = {
        serverId: target.id,
        serverName: target.name,
        host: target.host,
        status: "pending",
        output: "",
      };
    }

    const { promise: donePromise, resolve: resolveDone } = Promise.withResolvers<InteractiveJob>();

    const job: InteractiveJob = {
      id: jobId,
      createdAt: Date.now(),
      status: "running",
      targets: targetMap,
      done: donePromise,
    };

    // Evict oldest completed jobs if max capacity reached
    if (this.jobs.size >= this.maxStoredJobs) {
      const oldestKey = this.jobs.keys().next().value;
      if (oldestKey) this.jobs.delete(oldestKey);
    }

    this.jobs.set(jobId, job);

    (async () => {
      try {
        const promises = targets.map(async (target) => {
          job.targets[target.id].status = "running";
          job.targets[target.id].startedAt = Date.now();

          try {
            const result = await this.runner(target);
            job.targets[target.id] = result;
          } catch (err) {
            const completedAt = Date.now();
            const startedAt = job.targets[target.id].startedAt || completedAt;
            job.targets[target.id] = {
              serverId: target.id,
              serverName: target.name,
              host: target.host,
              status: "failed",
              output: `[Runner Error]: ${(err as Error).message}`,
              error: (err as Error).message,
              startedAt,
              completedAt,
              durationMs: completedAt - startedAt,
            };
          }
        });

        await Promise.allSettled(promises);

        const anyFailed = Object.values(job.targets).some((t) => t.status === "failed");
        const allFailed = Object.values(job.targets).every((t) => t.status === "failed");

        job.status = allFailed ? "failed" : anyFailed ? "failed" : "completed";
        job.completedAt = Date.now();
        resolveDone(job);
      } catch (err) {
        job.status = "failed";
        job.completedAt = Date.now();
        resolveDone(job);
      } finally {
        // Release locks
        for (const target of targets) {
          this.activeServerLocks.delete(target.id);
        }
      }
    })();

    return job;
  }
}
