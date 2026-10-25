import crypto from "node:crypto";
import type { FleetRepository } from "./db.js";
import {
  createTailscaleSshClient,
  type SshTarget,
  type SshCredentials,
  type TailscaleSshClient,
} from "./tailscale-ssh.js";
import type { FleetNodeWithCamel } from "./types.js";

export const DEFAULT_UPGRADE_COMMAND = "sudo npm i -g 9router@latest --prefer-online";

export interface NodeUpgradeProgress {
  nodeId: string;
  nodeName: string;
  host: string;
  status: "pending" | "running" | "success" | "failed" | "skipped";
  output?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
}

export interface UpgradeJob {
  id: string;
  command: string;
  createdAt: number;
  completedAt?: number;
  status: "running" | "completed" | "failed";
  targetNodeCount: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  nodes: Record<string, NodeUpgradeProgress>;
  done?: Promise<UpgradeJob>;
}

export interface SshUpdaterOptions {
  repo: FleetRepository;
  sshClientFactory?: (target: SshTarget, creds: SshCredentials) => TailscaleSshClient;
  defaultTimeoutMs?: number;
}

export class FleetSshUpdater {
  private repo: FleetRepository;
  private clientFactory: (target: SshTarget, creds: SshCredentials) => TailscaleSshClient;
  private defaultTimeoutMs: number;
  private jobs = new Map<string, UpgradeJob>();

  constructor(options: SshUpdaterOptions) {
    this.repo = options.repo;
    this.clientFactory = options.sshClientFactory || createTailscaleSshClient;
    this.defaultTimeoutMs = options.defaultTimeoutMs || 120_000; // 2 minutes for npm install
  }

  getJob(jobId: string): UpgradeJob | null {
    return this.jobs.get(jobId) || null;
  }

  listJobs(): UpgradeJob[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Run upgrade command on a single node.
   */
  async upgradeSingleNode(
    node: FleetNodeWithCamel,
    command = DEFAULT_UPGRADE_COMMAND,
    timeoutMs?: number,
  ): Promise<NodeUpgradeProgress> {
    const startedAt = Date.now();
    const creds = await this.repo.getNodeSshCredentials(node.id);

    const host = node.tailscale_ip || node.wireguard_ip || node.public_ip || "";

    if (!creds || !host) {
      return {
        nodeId: node.id,
        nodeName: node.name,
        host,
        status: "skipped",
        error: !creds
          ? "No SSH credentials configured for node"
          : "No reachable IP address found for node",
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }

    const target: SshTarget = {
      host,
      port: creds.port || 22,
    };

    try {
      const client = this.clientFactory(target, {
        username: creds.username,
        password: creds.password,
        hostKeyFingerprint: creds.hostKeyFingerprint,
      });

      const effectiveTimeout = timeoutMs || this.defaultTimeoutMs;
      const output = await client.execute(command, effectiveTimeout);
      const completedAt = Date.now();

      await this.repo.recordEvent({
        nodeId: node.id,
        eventType: "node.upgrade_success",
        level: "info",
        payload: { command, host, durationMs: completedAt - startedAt },
      });

      return {
        nodeId: node.id,
        nodeName: node.name,
        host,
        status: "success",
        output,
        startedAt,
        completedAt,
        durationMs: completedAt - startedAt,
      };
    } catch (err) {
      const completedAt = Date.now();
      const errorMsg = (err as Error).message || "Unknown SSH upgrade failure";

      await this.repo.recordEvent({
        nodeId: node.id,
        eventType: "node.upgrade_failed",
        level: "error",
        payload: { command, host, error: errorMsg, durationMs: completedAt - startedAt },
      });

      return {
        nodeId: node.id,
        nodeName: node.name,
        host,
        status: "failed",
        error: errorMsg,
        startedAt,
        completedAt,
        durationMs: completedAt - startedAt,
      };
    }
  }

  /**
   * Start a fleet-wide or node-specific upgrade job in the background.
   */
  async startUpgradeJob(options?: {
    nodeIds?: string[];
    command?: string;
    timeoutMs?: number;
  }): Promise<UpgradeJob> {
    const command = options?.command || DEFAULT_UPGRADE_COMMAND;
    const timeoutMs = options?.timeoutMs || this.defaultTimeoutMs;
    const allNodes = await this.repo.listNodes();

    let targetNodes = allNodes;
    if (options?.nodeIds && options.nodeIds.length > 0) {
      const idSet = new Set(options.nodeIds);
      targetNodes = allNodes.filter((n) => idSet.has(n.id));
    }

    const jobId = `upg_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const initialNodes: Record<string, NodeUpgradeProgress> = {};

    for (const node of targetNodes) {
      const host = node.tailscale_ip || node.wireguard_ip || node.public_ip || "";
      initialNodes[node.id] = {
        nodeId: node.id,
        nodeName: node.name,
        host,
        status: "pending",
      };
    }

    const job: UpgradeJob = {
      id: jobId,
      command,
      createdAt: Date.now(),
      status: "running",
      targetNodeCount: targetNodes.length,
      successCount: 0,
      failedCount: 0,
      skippedCount: 0,
      nodes: initialNodes,
    };

    this.jobs.set(jobId, job);
    const { promise: donePromise, resolve: resolveDone } = Promise.withResolvers<UpgradeJob>();
    job.done = donePromise;

    // Run execution asynchronously without blocking the API response
    (async () => {
      try {
        const promises = targetNodes.map(async (node) => {
          job.nodes[node.id].status = "running";
          job.nodes[node.id].startedAt = Date.now();

          const result = await this.upgradeSingleNode(node, command, timeoutMs);
          job.nodes[node.id] = result;

          if (result.status === "success") {
            job.successCount++;
          } else if (result.status === "failed") {
            job.failedCount++;
          } else {
            job.skippedCount++;
          }
        });

        await Promise.allSettled(promises);

        job.status = job.failedCount > 0 && job.successCount === 0 ? "failed" : "completed";
        job.completedAt = Date.now();
        resolveDone(job);
      } catch (err) {
        job.status = "failed";
        job.completedAt = Date.now();
        resolveDone(job);
      }
    })();

    return job;
  }
}
