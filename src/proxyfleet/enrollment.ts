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
  agentToken: string;
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
  } = {},
): EnrollmentService {
  const serverWireguardPublicKey =
    options.serverWireguardPublicKey || process.env.WIREGUARD_SERVER_PUBLIC_KEY;

  const serverWireguardEndpoint =
    options.serverWireguardEndpoint || process.env.WIREGUARD_SERVER_ENDPOINT;
  return {
    async issueToken(input: IssueTokenInput): Promise<IssueTokenResult> {
      if (input.assignedIp) {
        const parts = input.assignedIp.split(".");
        const octet =
          parts.length === 4 && parts[0] === "10" && parts[1] === "77" && parts[2] === "0"
            ? Number(parts[3])
            : NaN;
        if (!Number.isInteger(octet) || octet < 11 || octet > 254) {
          throw new Error("Invalid assignedIp: must be within 10.77.0.11-10.77.0.254");
        }
      }

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
      if (
        !serverWireguardPublicKey ||
        !serverWireguardEndpoint ||
        !/^[A-Za-z0-9+/]{43}=$/.test(serverWireguardPublicKey) ||
        Buffer.from(serverWireguardPublicKey, "base64").length !== 32 ||
        !serverWireguardEndpoint.includes(":")
      ) {
        throw new Error(
          "WireGuard server configuration missing or invalid: serverWireguardPublicKey (32-byte base64) and serverWireguardEndpoint (host:port) must be configured before enrolling nodes",
        );
      }

      const agentToken = `fla_${generateRandomToken(32)}`;
      const node = await repo.enrollNodeAtomic({
        token: input.token,
        nodeName: input.nodeName,
        wireguardPublicKey: input.wireguardPublicKey,
        publicIp: input.publicIp,
        os: input.os,
        arch: input.arch,
        agentVersion: input.agentVersion,
        agentToken,
      });

      return {
        nodeId: node.id,
        nodeName: node.name,
        wireguardIp: node.wireguardIp,
        serverWireguardPublicKey,
        serverWireguardEndpoint,
        agentToken,
      };
    },
  };
}
