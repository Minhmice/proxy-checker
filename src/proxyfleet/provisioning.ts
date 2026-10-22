import type { FleetRepository } from "./db.js";
import {
  createTailscaleSshClient,
  type SshTarget,
  type SshCredentials,
} from "./tailscale-ssh.js";
import { validateTailscaleIpv4, validatePublicIpv4 } from "./public-ip-gate.js";
import { generateRandomToken } from "./security.js";
import type { FleetNodeWithCamel } from "./types.js";

export interface ProvisionRequest {
  name?: string;
  tailscaleIp: string;
  sshPort?: number;
  username: string;
  password: string;
  hostKeyFingerprint: string;
  expectedPublicIp?: string | null;
  controllerUrl: string;
}

export interface ProvisioningService {
  provision(input: ProvisionRequest): Promise<{ nodeId: string; done: Promise<void> }>;
  retry(nodeId: string, controllerUrl: string): Promise<{ done: Promise<void> }>;
  verifyAndActivate(nodeId: string): Promise<FleetNodeWithCamel>;
  disable(nodeId: string, reason?: string): Promise<FleetNodeWithCamel>;
}

export function createProvisioningService(deps: {
  repo: FleetRepository;
  sshClientFactory?: (target: SshTarget, creds: SshCredentials) => {
    execute(command: string): Promise<string>;
    readPublicIp(): Promise<string>;
  };
}): ProvisioningService {
  const factory = deps.sshClientFactory || createTailscaleSshClient;

  async function executeProvisioning(
    node: FleetNodeWithCamel,
    creds: { username: string; password: string; port: number; hostKeyFingerprint: string },
    controllerUrl: string
  ): Promise<void> {
    const target: SshTarget = { host: node.tailscale_ip || "", port: creds.port };
    const client = factory(target, creds);

    await deps.repo.recordProvisioningState(node.id, { status: "installing", error: null });

    try {
      // 1. Read remote public IP
      const observedIp = await client.readPublicIp();
      const ipDecision = await deps.repo.recordPublicIpObservation(node.id, observedIp);

      if (ipDecision.status !== "verified") {
        await deps.repo.recordProvisioningState(node.id, {
          status: "failed",
          error: ipDecision.reason || `Public IP validation failed: ${ipDecision.status}`,
        });
        return;
      }

      // 2. Generate agent token
      const agentToken = `fla_${generateRandomToken(32)}`;
      await deps.repo.setNodeAgentToken(node.id, agentToken);

      // 3. Run bootstrap command on remote host via curl installer
      const cleanServer = controllerUrl.trim().replace(/\/+$/, "");
      const bootstrapCmd = `curl -fsSL "${cleanServer}/scripts/install-agent.sh" | sudo bash -s -- --server "${cleanServer}" --token "${agentToken}" --node-name "${node.name}"`;
      await client.execute(bootstrapCmd);

      // 4. Mark ready and activate
      await deps.repo.recordProvisioningState(node.id, { status: "ready", error: null });
      await deps.repo.activateNode(node.id);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await deps.repo.recordProvisioningState(node.id, { status: "failed", error: errMsg.slice(0, 500) });
      await deps.repo.disableNode(node.id, `Provisioning failed: ${errMsg.slice(0, 200)}`);
    }
  }

  return {
    async provision(input: ProvisionRequest): Promise<{ nodeId: string; done: Promise<void> }> {
      const tailscaleIp = validateTailscaleIpv4(input.tailscaleIp);
      const expectedPublicIp = input.expectedPublicIp ? validatePublicIpv4(input.expectedPublicIp) : null;
      const username = (input.username || "").trim();
      if (!username) throw new Error("SSH username is required");
      if (!input.password) throw new Error("SSH password is required");
      const fingerprint = (input.hostKeyFingerprint || "").trim();
      if (!fingerprint) throw new Error("Host key fingerprint is required");
      const port = Number(input.sshPort || 22);

      const name = (input.name || "").trim() || `worker-${tailscaleIp.replaceAll(".", "-")}`;

      // Check if node with this Tailscale IP already exists
      const existingNodes = await deps.repo.listNodes();
      let node = existingNodes.find((n) => n.tailscale_ip === tailscaleIp);
      if (!node) {
        node = await deps.repo.createTailscaleNode({
          name,
          tailscaleIp,
          expectedPublicIp,
        });
      }

      await deps.repo.setNodeSshCredentials(node.id, {
        username,
        password: input.password,
        port,
        hostKeyFingerprint: fingerprint,
      });

      // Fire async execution
      const done = executeProvisioning(
        node,
        { username, password: input.password, port, hostKeyFingerprint: fingerprint },
        input.controllerUrl
      );

      return { nodeId: node.id, done };
    },

    async retry(nodeId: string, controllerUrl: string): Promise<{ done: Promise<void> }> {
      const node = await deps.repo.getNode(nodeId);
      if (!node) throw new Error("Node not found");
      const creds = await deps.repo.getNodeSshCredentials(nodeId);
      if (!creds) throw new Error("No SSH credentials stored for node");

      const done = executeProvisioning(node, creds, controllerUrl);
      return { done };
    },

    async verifyAndActivate(nodeId: string): Promise<FleetNodeWithCamel> {
      const node = await deps.repo.getNode(nodeId);
      if (!node) throw new Error("Node not found");
      const creds = await deps.repo.getNodeSshCredentials(nodeId);
      if (!creds) throw new Error("No SSH credentials stored for node");

      const target: SshTarget = { host: node.tailscale_ip || "", port: creds.port };
      const client = factory(target, creds);

      const observed = await client.readPublicIp();
      const decision = await deps.repo.recordPublicIpObservation(node.id, observed);
      if (decision.status !== "verified") {
        throw new Error(decision.reason || `Public IP validation failed (${decision.status})`);
      }

      return await deps.repo.activateNode(nodeId);
    },

    async disable(nodeId: string, reason?: string): Promise<FleetNodeWithCamel> {
      return await deps.repo.disableNode(nodeId, reason || "Disabled by operator");
    },
  };
}
