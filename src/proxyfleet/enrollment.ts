import { hashToken, generateRandomToken } from "./security.js";
import type { FleetRepository } from "./db.js";

export interface IssueTokenInput {
  nodeName: string;
  ttlMinutes?: number;
  assignedIp?: string;
}

export interface IssueTokenResult {
  token: string;
  nodeName: string;
  expiresAt: number;
}

export interface EnrollNodeInput {
  token: string;
  nodeName: string;
  wireguardPublicKey: string;
  publicIp?: string | null;
  os?: string | null;
  arch?: string | null;
  agentVersion?: string | null;
}

export interface EnrollNodeResult {
  nodeId: string;
  nodeName: string;
  wireguardIp: string;
  serverWireguardPublicKey: string;
  serverWireguardEndpoint: string;
}

export interface EnrollmentService {
  issueToken(input: IssueTokenInput): Promise<IssueTokenResult>;
  enrollNode(input: EnrollNodeInput): Promise<EnrollNodeResult>;
}

export function createEnrollmentService(
  repo: FleetRepository,
  options: {
    serverWireguardPublicKey?: string;
    serverWireguardEndpoint?: string;
  } = {}
): EnrollmentService {
  const serverWireguardPublicKey =
    options.serverWireguardPublicKey ||
    process.env.WIREGUARD_SERVER_PUBLIC_KEY ||
    "t7zO1q2R3s4T5u6V7w8X9y0Z1a2B3c4D5e6F7g8H9i0=";

  const serverWireguardEndpoint =
    options.serverWireguardEndpoint ||
    process.env.WIREGUARD_SERVER_ENDPOINT ||
    "127.0.0.1:51820";

  return {
    async issueToken(input: IssueTokenInput): Promise<IssueTokenResult> {
      const token = `flt_${generateRandomToken(20)}`;
      const tokenHash = hashToken(token);
      const ttlMs = Math.max(1, input.ttlMinutes || 15) * 60_000;
      const expiresAt = Date.now() + ttlMs;

      await repo.createEnrollmentToken({
        tokenHash,
        nodeName: input.nodeName.trim(),
        expiresAt,
        assignedIp: input.assignedIp || null,
      });

      return {
        token,
        nodeName: input.nodeName.trim(),
        expiresAt,
      };
    },

    async enrollNode(input: EnrollNodeInput): Promise<EnrollNodeResult> {
      const tokenHash = hashToken(input.token);
      const consumed = await repo.consumeEnrollmentToken(tokenHash);

      if (!consumed) {
        throw new Error("Enrollment token already consumed or expired");
      }

      const assignedWireguardIp = consumed.assignedIp || (await repo.getNextWireguardIp());

      const node = await repo.createNode({
        name: consumed.nodeName || input.nodeName,
        wireguardIp: assignedWireguardIp,
        publicIp: input.publicIp || null,
        wireguardPublicKey: input.wireguardPublicKey,
        os: input.os || null,
        arch: input.arch || null,
        agentVersion: input.agentVersion || null,
      });

      await repo.recordEvent({
        nodeId: node.id,
        eventType: "node.enrolled",
        level: "info",
        payload: {
          nodeName: node.name,
          wireguardIp: assignedWireguardIp,
          publicIp: input.publicIp || null,
        },
      });

      return {
        nodeId: node.id,
        nodeName: node.name,
        wireguardIp: assignedWireguardIp,
        serverWireguardPublicKey,
        serverWireguardEndpoint,
      };
    },
  };
}
