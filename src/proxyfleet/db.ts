import {
  createFleetRuntimeStore,
  type FleetRuntimeStore,
} from './runtime-store.js';
import type {
  FleetDeviceInfo,
  FleetRuntimeSnapshot,
  FleetCapacitySettings,
} from './runtime.js';
import type Database from 'better-sqlite3';
import { openFleetDb } from '../db/fleet/client.js';
import type { SqliteClient } from '../db/common/client.js';
import type * as fleetSchema from '../db/fleet/schema.js';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  encryptSecret,
  decryptSecret,
  type EncryptedPayload,
} from './security.js';
import {
  evaluatePublicIp,
  validateTailscaleIpv4,
  validatePublicIpv4,
  type IpDecision,
} from './public-ip-gate.js';
import type {
  FleetNodeRecord,
  FleetNodeRole,
  FleetNodeStatus,
  FleetProxyEndpointRecord,
  FleetProxyProtocol,
  FleetNodeDesiredState,
  FleetHealthCheckRecord,
  FleetHealthStatus,
  FleetDeploymentRecord,
  FleetDeploymentStatus,
  FleetEventRecord,
  FleetConfigurationStatus,
  FleetNodeConfigurationView,
  RecordDeploymentResultInput,
  RecordDeploymentResultOutcome,
  FleetNodeWithCamel,
  FleetRemovalRecord,
  FleetRemovalStatus,
  FleetPublicIpStatus,
  FleetProxyActivation,
  FleetProvisionStatus,
} from './types.js';
export interface BootstrapControllerNodeInput {
  id?: string;
  name?: string;
  wireguardIp?: string;
  os?: string | null;
  arch?: string | null;
  agentVersion?: string | null;
}

export interface CreateNodeInput {
  id?: string;
  name: string;
  role?: FleetNodeRole;
  wireguardIp: string;
  status?: FleetNodeStatus;
  publicIp?: string | null;
  wireguardPublicKey?: string | null;
  os?: string | null;
  arch?: string | null;
  agentVersion?: string | null;
  desired_revision?: number;
}

export interface CreateEndpointInput {
  id?: string;
  nodeId: string;
  protocol: FleetProxyProtocol;
  listenIp: string;
  listenPort: number;
  egressId?: string | null;
  username: string;
  password?: string;
  enabled?: boolean;
}

export interface RecordHeartbeatInput {
  status?: FleetNodeStatus;
  cpuUsage?: number;
  memoryUsage?: number;
  publicIp?: string | null;
  agentVersion?: string | null;
}

export interface RecordHealthCheckInput {
  endpointId: string;
  nodeId: string;
  status: FleetHealthStatus;
  exitIp?: string | null;
  latencyMs?: number | null;
  errorMessage?: string | null;
}

export interface RecordEventInput {
  nodeId?: string | null;
  endpointId?: string | null;
  eventType: string;
  level: 'info' | 'warn' | 'error';
  payload?: Record<string, unknown>;
}

export type { FleetNodeWithCamel } from './types.js';

export type FleetEndpointWithCamel = FleetProxyEndpointRecord & {
  nodeId: string;
  listenIp: string;
  listenPort: number;
};

export type FleetHealthCheckWithCamel = FleetHealthCheckRecord & {
  endpointId: string;
  nodeId: string;
  exitIp: string | null;
  latencyMs: number | null;
};

export interface FleetRepository {
  migrate(): Promise<void>;
  startRuntimeSession(nodeId: string, sessionId: string): Promise<void>;
  recordNodeDevice(nodeId: string, device: FleetDeviceInfo): Promise<void>;
  recordNodeRuntime(
    nodeId: string,
    runtime: FleetRuntimeSnapshot,
  ): Promise<{ accepted: boolean }>;
  updateNodeCapacity(
    nodeId: string,
    capacity: FleetCapacitySettings,
  ): Promise<FleetNodeWithCamel>;
  isOverlayApproved(nodeId: string): boolean;
  setOverlayApproved(nodeId: string, approved: boolean): void;
  getApprovedNodeIds(): string[];
  createNode(input: CreateNodeInput): Promise<FleetNodeWithCamel>;
  getNode(id: string): Promise<FleetNodeWithCamel | null>;
  listNodes(filter?: {
    status?: FleetNodeStatus;
  }): Promise<FleetNodeWithCamel[]>;
  setNodeAgentToken(nodeId: string, token: string): Promise<void>;
  verifyNodeAgentToken(nodeId: string, token: string): Promise<boolean>;
  recordHeartbeat(nodeId: string, input: RecordHeartbeatInput): Promise<void>;
  createProxyEndpoint(
    input: CreateEndpointInput,
  ): Promise<FleetEndpointWithCamel>;
  listEndpoints(filter?: {
    nodeId?: string;
    enabled?: boolean;
  }): Promise<FleetEndpointWithCamel[]>;
  getEndpoint(id: string): Promise<FleetEndpointWithCamel | null>;
  getEndpointCredentials(
    endpointId: string,
  ): Promise<{ username: string; password: string } | null>;
  getNodeDesiredState(nodeId: string): Promise<FleetNodeDesiredState | null>;
  updateEndpoint(
    id: string,
    patch: { enabled?: boolean; username?: string; password?: string },
  ): Promise<FleetEndpointWithCamel>;
  recordHealthCheck(
    input: RecordHealthCheckInput,
  ): Promise<FleetHealthCheckWithCamel>;
  getLatestHealthCheck(
    endpointId: string,
  ): Promise<FleetHealthCheckWithCamel | null>;
  recordEvent(input: RecordEventInput): Promise<FleetEventRecord>;
  listEvents(filter?: {
    nodeId?: string;
    endpointId?: string;
    limit?: number;
  }): Promise<FleetEventRecord[]>;
  createEnrollmentToken(input: {
    tokenHash: string;
    nodeName: string;
    expiresAt: number;
    assignedIp?: string | null;
  }): Promise<void>;
  consumeEnrollmentToken(
    tokenHash: string,
  ): Promise<{ nodeName: string; assignedIp: string | null } | null>;
  getNextWireguardIp(): Promise<string>;
  bootstrapControllerNode(
    input?: BootstrapControllerNodeInput,
  ): Promise<FleetNodeWithCamel>;
  close(): void;
  updateNodeDesiredRevision(
    nodeId: string,
    desiredRevision: number,
  ): Promise<void>;
  recordDeploymentResult(
    input: RecordDeploymentResultInput,
  ): Promise<RecordDeploymentResultOutcome>;
  getNodeDeployments(
    nodeId: string,
    limit?: number,
  ): Promise<FleetDeploymentRecord[]>;
  requestNodeRemoval(nodeId: string): Promise<FleetRemovalRecord>;
  getNodeRemoval(nodeId: string): Promise<FleetRemovalRecord | null>;
  listPendingNodeRemovals(): Promise<FleetRemovalRecord[]>;
  recordNodeRemovalError(nodeId: string, message: string): Promise<void>;
  completeNodeRemoval(nodeId: string): Promise<FleetRemovalRecord>;
  listEndpointsForNodeRemovalCleanup(
    nodeId: string,
  ): Promise<FleetEndpointWithCamel[]>;
  enrollNodeAtomic(input: {
    token: string;
    nodeName: string;
    wireguardPublicKey: string;
    publicIp?: string | null;
    os?: string | null;
    arch?: string | null;
    agentVersion?: string | null;
    agentToken: string;
  }): Promise<FleetNodeWithCamel>;
  createTailscaleNode(input: {
    name: string;
    tailscaleIp: string;
    expectedPublicIp?: string | null;
  }): Promise<FleetNodeWithCamel>;
  setNodeSshCredentials(
    nodeId: string,
    input: {
      username: string;
      password: string;
      port?: number;
      hostKeyFingerprint: string;
    },
  ): Promise<void>;
  getNodeSshCredentials(
    nodeId: string,
  ): Promise<{
    username: string;
    password: string;
    port: number;
    hostKeyFingerprint: string;
  } | null>;
  recordProvisioningState(
    nodeId: string,
    input: { status: FleetProvisionStatus; error: string | null },
  ): Promise<void>;
  recordPublicIpObservation(
    nodeId: string,
    observed: string | null,
  ): Promise<IpDecision>;
  activateNode(nodeId: string): Promise<FleetNodeWithCamel>;
  disableNode(
    nodeId: string,
    reason?: string | null,
  ): Promise<FleetNodeWithCamel>;
  getActiveWorkerPublicIps(excludeNodeId?: string): Promise<string[]>;
}

class SqliteFleetRepository implements FleetRepository {
  private client: SqliteClient<typeof fleetSchema>;
  private db: Database.Database;
  private runtimeStore!: FleetRuntimeStore;

  constructor(filePath: string) {
    this.client = openFleetDb(filePath);
    this.db = this.client.raw;
  }

  async migrate(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fleet_nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'worker',
        status TEXT NOT NULL DEFAULT 'offline',
        public_ip TEXT,
        wireguard_ip TEXT NOT NULL UNIQUE,
        wireguard_public_key TEXT,
        os TEXT,
        arch TEXT,
        agent_version TEXT,
        last_heartbeat_at INTEGER,
        desired_revision INTEGER NOT NULL DEFAULT 1,
        agent_token_hash TEXT,
        applied_revision INTEGER,
        deployment_revision INTEGER,
        deployment_status TEXT NOT NULL DEFAULT 'unknown',
        deployment_error TEXT,
        deployment_updated_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fleet_node_interfaces (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES fleet_nodes(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        mac_address TEXT,
        ipv4_address TEXT,
        ipv6_address TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fleet_egresses (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES fleet_nodes(id) ON DELETE CASCADE,
        interface_id TEXT REFERENCES fleet_node_interfaces(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        source_ip TEXT,
        gateway_ip TEXT,
        routing_table_id INTEGER,
        expected_public_ip TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fleet_proxy_endpoints (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES fleet_nodes(id) ON DELETE CASCADE,
        protocol TEXT NOT NULL,
        listen_ip TEXT NOT NULL,
        listen_port INTEGER NOT NULL,
        egress_id TEXT REFERENCES fleet_egresses(id) ON DELETE SET NULL,
        username TEXT NOT NULL,
        credential_ref TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        current_revision INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(node_id, listen_ip, listen_port)
      );

      CREATE TABLE IF NOT EXISTS fleet_proxy_credentials (
        id TEXT PRIMARY KEY,
        endpoint_id TEXT NOT NULL REFERENCES fleet_proxy_endpoints(id) ON DELETE CASCADE,
        username TEXT NOT NULL,
        encrypted_password TEXT NOT NULL,
        salt TEXT NOT NULL,
        iv TEXT NOT NULL,
        tag TEXT NOT NULL,
        rotated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fleet_health_checks (
        id TEXT PRIMARY KEY,
        endpoint_id TEXT NOT NULL REFERENCES fleet_proxy_endpoints(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL REFERENCES fleet_nodes(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        exit_ip TEXT,
        latency_ms REAL,
        error_message TEXT,
        checked_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fleet_deployments (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES fleet_nodes(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        config_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT,
        applied_at INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fleet_enrollment_tokens (
        token_hash TEXT PRIMARY KEY,
        node_name TEXT NOT NULL,
        assigned_ip TEXT,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fleet_events (
        id TEXT PRIMARY KEY,
        node_id TEXT,
        endpoint_id TEXT,
        event_type TEXT NOT NULL,
        level TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fleet_node_removals (
        node_id TEXT PRIMARY KEY,
        node_name TEXT NOT NULL,
        wireguard_ip TEXT NOT NULL,
        wireguard_public_key TEXT,
        status TEXT NOT NULL,
        error_message TEXT,
        requested_at INTEGER NOT NULL,
        completed_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fleet_node_ssh (
        node_id TEXT PRIMARY KEY REFERENCES fleet_nodes(id) ON DELETE CASCADE,
        username TEXT NOT NULL,
        encrypted_password TEXT NOT NULL,
        salt TEXT NOT NULL,
        iv TEXT NOT NULL,
        tag TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 22,
        host_key_fingerprint TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_fleet_removals_status ON fleet_node_removals(status);

      CREATE INDEX IF NOT EXISTS idx_fleet_endpoints_node ON fleet_proxy_endpoints(node_id);
      CREATE INDEX IF NOT EXISTS idx_fleet_health_endpoint ON fleet_health_checks(endpoint_id, checked_at DESC);
      CREATE INDEX IF NOT EXISTS idx_fleet_events_created ON fleet_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_fleet_deployments_node ON fleet_deployments(node_id, revision DESC);
    `);
    const columns = this.db
      .prepare('PRAGMA table_info(fleet_nodes)')
      .all() as Array<{ name: string; type: string }>;
    const columnNames = new Set(columns.map((c) => c.name));

    if (!columnNames.has('role')) {
      this.db.exec(
        "ALTER TABLE fleet_nodes ADD COLUMN role TEXT NOT NULL DEFAULT 'worker';",
      );
    }

    if (!columnNames.has('agent_token_hash')) {
      this.db.exec('ALTER TABLE fleet_nodes ADD COLUMN agent_token_hash TEXT;');
    }
    if (!columnNames.has('applied_revision')) {
      this.db.exec(
        'ALTER TABLE fleet_nodes ADD COLUMN applied_revision INTEGER;',
      );
    }
    if (!columnNames.has('deployment_revision')) {
      this.db.exec(
        'ALTER TABLE fleet_nodes ADD COLUMN deployment_revision INTEGER;',
      );
    }
    if (!columnNames.has('deployment_status')) {
      this.db.exec(
        "ALTER TABLE fleet_nodes ADD COLUMN deployment_status TEXT NOT NULL DEFAULT 'unknown';",
      );
    }
    if (!columnNames.has('tailscale_ip')) {
      this.db.exec('ALTER TABLE fleet_nodes ADD COLUMN tailscale_ip TEXT;');
    }
    if (!columnNames.has('expected_public_ip')) {
      this.db.exec(
        'ALTER TABLE fleet_nodes ADD COLUMN expected_public_ip TEXT;',
      );
    }
    if (!columnNames.has('public_ip_status')) {
      this.db.exec(
        "ALTER TABLE fleet_nodes ADD COLUMN public_ip_status TEXT NOT NULL DEFAULT 'unknown';",
      );
    }
    if (!columnNames.has('public_ip_checked_at')) {
      this.db.exec(
        'ALTER TABLE fleet_nodes ADD COLUMN public_ip_checked_at INTEGER;',
      );
    }
    if (!columnNames.has('proxy_activation')) {
      this.db.exec(
        "ALTER TABLE fleet_nodes ADD COLUMN proxy_activation TEXT NOT NULL DEFAULT 'disabled';",
      );
    }
    if (!columnNames.has('proxy_activation_reason')) {
      this.db.exec(
        'ALTER TABLE fleet_nodes ADD COLUMN proxy_activation_reason TEXT;',
      );
    }
    if (!columnNames.has('provision_status')) {
      this.db.exec(
        "ALTER TABLE fleet_nodes ADD COLUMN provision_status TEXT NOT NULL DEFAULT 'pending';",
      );
    }
    if (!columnNames.has('provision_error')) {
      this.db.exec('ALTER TABLE fleet_nodes ADD COLUMN provision_error TEXT;');
    }
    if (!columnNames.has('deployment_error')) {
      this.db.exec('ALTER TABLE fleet_nodes ADD COLUMN deployment_error TEXT;');
    }
    if (!columnNames.has('deployment_updated_at')) {
      this.db.exec(
        'ALTER TABLE fleet_nodes ADD COLUMN deployment_updated_at INTEGER;',
      );
    }

    if (!columnNames.has('desired_revision')) {
      this.db.exec('BEGIN IMMEDIATE;');
      try {
        this.db.exec(
          'ALTER TABLE fleet_nodes ADD COLUMN desired_revision INTEGER NOT NULL DEFAULT 1;',
        );

        const existingNodes = this.db
          .prepare('SELECT id, updated_at FROM fleet_nodes')
          .all() as Array<{
          id: string;
          updated_at: number;
        }>;
        const getEpStats = this.db.prepare(
          'SELECT MAX(updated_at) AS max_updated, MAX(current_revision) AS max_rev FROM fleet_proxy_endpoints WHERE node_id = ?',
        );
        const updateNodeRev = this.db.prepare(
          'UPDATE fleet_nodes SET desired_revision = ? WHERE id = ?',
        );

        const now = Date.now();
        for (const node of existingNodes) {
          const epStats = getEpStats.get(node.id) as
            | { max_updated?: number | null; max_rev?: number | null }
            | undefined;
          const maxEpUpdated =
            epStats?.max_updated != null ? Number(epStats.max_updated) : 0;
          const maxEpRev =
            epStats?.max_rev != null ? Number(epStats.max_rev) : 0;
          const nodeUpdated =
            node.updated_at != null ? Number(node.updated_at) : 0;
          const maxHistorical = Math.max(
            now,
            nodeUpdated,
            maxEpUpdated,
            maxEpRev,
          );
          const seedRevision = maxHistorical + 1;
          updateNodeRev.run(seedRevision, node.id);
        }

        this.db.exec('COMMIT;');
      } catch (err) {
        this.db.exec('ROLLBACK;');
        throw err;
      }
    }
    this.runtimeStore = createFleetRuntimeStore(this.db);
  }

  async startRuntimeSession(nodeId: string, sessionId: string): Promise<void> {
    this.runtimeStore.startSession(nodeId, sessionId);
  }

  async recordNodeDevice(
    nodeId: string,
    device: FleetDeviceInfo,
  ): Promise<void> {
    this.runtimeStore.recordDevice(nodeId, device);
  }

  async recordNodeRuntime(
    nodeId: string,
    runtime: FleetRuntimeSnapshot,
  ): Promise<{ accepted: boolean }> {
    return this.runtimeStore.recordRuntime(nodeId, runtime);
  }

  async updateNodeCapacity(
    nodeId: string,
    capacity: FleetCapacitySettings,
  ): Promise<FleetNodeWithCamel> {
    this.runtimeStore.updateCapacity(nodeId, capacity);
    const node = await this.getNode(nodeId);
    if (!node) throw new Error('Node not found');
    return node;
  }
  isOverlayApproved(nodeId: string): boolean {
    return this.runtimeStore.isOverlayApproved(nodeId);
  }

  setOverlayApproved(nodeId: string, approved: boolean): void {
    this.runtimeStore.setOverlayApproved(nodeId, approved);
  }

  getApprovedNodeIds(): string[] {
    return this.runtimeStore.getApprovedNodeIds();
  }

  private mapRemoval(
    row: Record<string, unknown> | undefined,
  ): FleetRemovalRecord | null {
    if (!row) return null;
    return {
      nodeId: String(row.node_id),
      nodeName: String(row.node_name),
      wireguardIp: String(row.wireguard_ip),
      publicKey: row.wireguard_public_key
        ? String(row.wireguard_public_key)
        : null,
      status: row.status as FleetRemovalStatus,
      lastError: row.error_message ? String(row.error_message) : null,
      requestedAt: Number(row.requested_at),
      completedAt: row.completed_at != null ? Number(row.completed_at) : null,
    };
  }

  private mapNode(
    row: Record<string, unknown> | undefined,
  ): FleetNodeWithCamel | null {
    if (!row) return null;
    const now = Date.now();
    const role = (row.role as FleetNodeRole) || 'worker';
    const reportedStatus = row.status as FleetNodeStatus;
    const lastHeartbeatAt =
      row.last_heartbeat_at != null ? Number(row.last_heartbeat_at) : null;
    const desiredRevision = Number(row.desired_revision || 1);

    const effectiveStatus: FleetNodeStatus =
      lastHeartbeatAt === null || now - lastHeartbeatAt >= 60_000
        ? 'offline'
        : reportedStatus;
    const appliedRevision =
      row.applied_revision != null ? Number(row.applied_revision) : null;
    const deploymentRevision =
      row.deployment_revision != null ? Number(row.deployment_revision) : null;
    const deploymentStatus =
      (row.deployment_status as FleetConfigurationStatus) || 'unknown';
    const deploymentError = row.deployment_error
      ? String(row.deployment_error)
      : null;
    const deploymentUpdatedAt =
      row.deployment_updated_at != null
        ? Number(row.deployment_updated_at)
        : null;

    const configuration: FleetNodeConfigurationView = {
      status: deploymentStatus,
      desiredRevision,
      appliedRevision,
      deploymentRevision,
      error: deploymentError,
      updatedAt: deploymentUpdatedAt,
    };

    return {
      id: String(row.id),
      name: String(row.name),
      role,
      status: effectiveStatus,
      public_ip: row.public_ip ? String(row.public_ip) : null,
      publicIp: row.public_ip ? String(row.public_ip) : null,
      wireguard_ip: String(row.wireguard_ip),
      wireguardIp: String(row.wireguard_ip),
      wireguard_public_key: row.wireguard_public_key
        ? String(row.wireguard_public_key)
        : null,
      tailscale_ip: row.tailscale_ip ? String(row.tailscale_ip) : null,
      tailscaleIp: row.tailscale_ip ? String(row.tailscale_ip) : null,
      expected_public_ip: row.expected_public_ip
        ? String(row.expected_public_ip)
        : null,
      expectedPublicIp: row.expected_public_ip
        ? String(row.expected_public_ip)
        : null,
      public_ip_status:
        (row.public_ip_status as FleetPublicIpStatus) || 'unknown',
      publicIpStatus:
        (row.public_ip_status as FleetPublicIpStatus) || 'unknown',
      public_ip_checked_at:
        row.public_ip_checked_at != null
          ? Number(row.public_ip_checked_at)
          : null,
      publicIpCheckedAt:
        row.public_ip_checked_at != null
          ? Number(row.public_ip_checked_at)
          : null,
      proxy_activation:
        (row.proxy_activation as FleetProxyActivation) || 'disabled',
      proxyActivation:
        (row.proxy_activation as FleetProxyActivation) || 'disabled',
      proxy_activation_reason: row.proxy_activation_reason
        ? String(row.proxy_activation_reason)
        : null,
      proxyActivationReason: row.proxy_activation_reason
        ? String(row.proxy_activation_reason)
        : null,
      provision_status:
        (row.provision_status as FleetProvisionStatus) || 'pending',
      provisionStatus:
        (row.provision_status as FleetProvisionStatus) || 'pending',
      provision_error: row.provision_error ? String(row.provision_error) : null,
      provisionError: row.provision_error ? String(row.provision_error) : null,
      ssh_credentials_set: Boolean(
        this.db
          .prepare('SELECT 1 FROM fleet_node_ssh WHERE node_id = ? LIMIT 1')
          .get(String(row.id)),
      ),
      sshCredentialsSet: Boolean(
        this.db
          .prepare('SELECT 1 FROM fleet_node_ssh WHERE node_id = ? LIMIT 1')
          .get(String(row.id)),
      ),
      os: row.os ? String(row.os) : null,
      arch: row.arch ? String(row.arch) : null,
      agent_version: row.agent_version ? String(row.agent_version) : null,
      agentVersion: row.agent_version ? String(row.agent_version) : null,
      last_heartbeat_at: lastHeartbeatAt,
      desired_revision: desiredRevision,
      applied_revision: appliedRevision,
      appliedRevision,
      deployment_revision: deploymentRevision,
      deploymentRevision,
      deployment_status: deploymentStatus,
      deploymentStatus,
      deployment_error: deploymentError,
      deploymentError,
      deployment_updated_at: deploymentUpdatedAt,
      deploymentUpdatedAt,
      configuration,
      device: row.device_json
        ? (JSON.parse(String(row.device_json)) as FleetDeviceInfo)
        : null,
      runtime: row.runtime_json
        ? (JSON.parse(String(row.runtime_json)) as FleetRuntimeSnapshot)
        : null,
      runtimeReceivedAt:
        row.runtime_received_at == null
          ? null
          : Number(row.runtime_received_at),
      capacity: {
        maxConnections:
          row.capacity_max_connections == null
            ? null
            : Number(row.capacity_max_connections),
      },
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    };
  }
  private mapEndpoint(
    row: Record<string, unknown> | undefined,
  ): FleetEndpointWithCamel | null {
    if (!row) return null;
    const latestHealth = this.db
      .prepare(
        'SELECT * FROM fleet_health_checks WHERE endpoint_id = ? ORDER BY checked_at DESC LIMIT 1',
      )
      .get(String(row.id)) as Record<string, unknown> | undefined;
    return {
      id: String(row.id),
      node_id: String(row.node_id),
      nodeId: String(row.node_id),
      protocol: row.protocol as FleetProxyProtocol,
      listen_ip: String(row.listen_ip),
      listenIp: String(row.listen_ip),
      listen_port: Number(row.listen_port),
      listenPort: Number(row.listen_port),
      egress_id: row.egress_id ? String(row.egress_id) : null,
      username: String(row.username),
      credential_ref: String(row.credential_ref),
      enabled: Boolean(row.enabled),
      current_revision: Number(row.current_revision),
      health: latestHealth ? this.mapHealthCheck(latestHealth) : null,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    };
  }

  private mapHealthCheck(
    row: Record<string, unknown> | undefined,
  ): FleetHealthCheckWithCamel | null {
    if (!row) return null;
    return {
      id: String(row.id),
      endpoint_id: String(row.endpoint_id),
      endpointId: String(row.endpoint_id),
      node_id: String(row.node_id),
      nodeId: String(row.node_id),
      status: row.status as FleetHealthStatus,
      exit_ip: row.exit_ip ? String(row.exit_ip) : null,
      exitIp: row.exit_ip ? String(row.exit_ip) : null,
      latency_ms:
        row.latency_ms !== null && row.latency_ms !== undefined
          ? Number(row.latency_ms)
          : null,
      latencyMs:
        row.latency_ms !== null && row.latency_ms !== undefined
          ? Number(row.latency_ms)
          : null,
      error_message: row.error_message ? String(row.error_message) : null,
      checked_at: Number(row.checked_at),
    };
  }

  async createNode(input: CreateNodeInput): Promise<FleetNodeWithCamel> {
    const id = input.id || crypto.randomUUID();
    const now = Date.now();
    const desiredRevision =
      input.desired_revision && input.desired_revision > 0
        ? input.desired_revision
        : 1;
    const query = `
      INSERT INTO fleet_nodes (
        id, name, role, status, public_ip, wireguard_ip, wireguard_public_key, os, arch, agent_version, desired_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    this.db
      .prepare(query)
      .run(
        id,
        input.name,
        input.role || 'worker',
        input.status || 'offline',
        input.publicIp || null,
        input.wireguardIp,
        input.wireguardPublicKey || null,
        input.os || null,
        input.arch || null,
        input.agentVersion || null,
        desiredRevision,
        now,
        now,
      );

    const node = await this.getNode(id);
    if (!node) throw new Error('Failed to insert node');
    return node;
  }

  async getNode(id: string): Promise<FleetNodeWithCamel | null> {
    const removal = this.db
      .prepare('SELECT status FROM fleet_node_removals WHERE node_id = ?')
      .get(id) as { status: string } | undefined;
    if (removal?.status === 'pending') {
      return null;
    }
    const stmt = this.db.prepare('SELECT * FROM fleet_nodes WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return this.mapNode(row);
  }
  async updateNodeDesiredRevision(
    nodeId: string,
    desiredRevision: number,
  ): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE fleet_nodes SET desired_revision = ?, deployment_status = 'pending', deployment_error = NULL, updated_at = ? WHERE id = ?",
      )
      .run(desiredRevision, now, nodeId);
  }

  async setNodeAgentToken(nodeId: string, token: string): Promise<void> {
    if (!nodeId) throw new Error('nodeId is required');
    if (!token) throw new Error('token is required');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    this.db.exec('SAVEPOINT fleet_token_rotation');
    try {
      const result = this.db
        .prepare(
          "UPDATE fleet_nodes SET agent_token_hash = ?, runtime_session_id = NULL, runtime_sequence = 0, runtime_json = NULL, runtime_received_at = NULL, updated_at = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM fleet_node_removals WHERE node_id = ? AND status = 'pending')",
        )
        .run(hash, Date.now(), nodeId, nodeId);
      if (result.changes === 0) throw new Error(`Node ${nodeId} not found`);
      this.db
        .prepare('DELETE FROM fleet_runtime_sessions WHERE node_id = ?')
        .run(nodeId);
      this.db.exec('RELEASE fleet_token_rotation');
    } catch (error) {
      this.db.exec(
        'ROLLBACK TO fleet_token_rotation; RELEASE fleet_token_rotation',
      );
      throw error;
    }
  }

  async verifyNodeAgentToken(nodeId: string, token: string): Promise<boolean> {
    if (!nodeId || !token) return false;
    const removal = this.db
      .prepare('SELECT status FROM fleet_node_removals WHERE node_id = ?')
      .get(nodeId) as { status: string } | undefined;
    if (removal?.status === 'pending') {
      return false;
    }
    const row = this.db
      .prepare('SELECT agent_token_hash FROM fleet_nodes WHERE id = ?')
      .get(nodeId) as { agent_token_hash: string | null } | undefined;
    if (!row || !row.agent_token_hash) {
      return false;
    }
    const expectedHash = row.agent_token_hash;
    const actualHash = crypto.createHash('sha256').update(token).digest('hex');
    const expectedBuffer = Buffer.from(expectedHash, 'hex');
    const actualBuffer = Buffer.from(actualHash, 'hex');
    if (expectedBuffer.length !== 32 || actualBuffer.length !== 32) {
      return false;
    }
    return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
  }

  async bootstrapControllerNode(
    input: BootstrapControllerNodeInput = {},
  ): Promise<FleetNodeWithCamel> {
    const existing = this.db
      .prepare(
        "SELECT * FROM fleet_nodes WHERE role = 'controller-worker' OR wireguard_ip = '10.77.0.1' LIMIT 1",
      )
      .get() as Record<string, unknown> | undefined;

    const defaultName = os.hostname() || 'controller-node';
    const targetName =
      input.name ||
      (existing && existing.name !== 'controller-001'
        ? (existing.name as string)
        : defaultName);

    if (existing) {
      if (input.name || existing.name === 'controller-001') {
        this.db
          .prepare(
            'UPDATE fleet_nodes SET name = ?, updated_at = ? WHERE id = ?',
          )
          .run(targetName, Date.now(), existing.id as string);
      }
      return (await this.getNode(existing.id as string))!;
    }

    const id = input.id || 'controller-node-master';
    const name = input.name || defaultName;
    const wireguardIp = input.wireguardIp || '10.77.0.1';
    const now = Date.now();

    this.db
      .prepare(`
      INSERT INTO fleet_nodes (
        id, name, role, status, public_ip, wireguard_ip, wireguard_public_key, os, arch, agent_version, last_heartbeat_at, desired_revision, created_at, updated_at
      ) VALUES (?, ?, 'controller-worker', 'online', NULL, ?, NULL, ?, ?, ?, ?, 1, ?, ?)
    `)
      .run(
        id,
        name,
        wireguardIp,
        input.os || null,
        input.arch || null,
        input.agentVersion || null,
        now,
        now,
        now,
      );

    return (await this.getNode(id))!;
  }

  async listNodes(filter?: {
    status?: FleetNodeStatus;
  }): Promise<FleetNodeWithCamel[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM fleet_nodes
      WHERE id NOT IN (SELECT node_id FROM fleet_node_removals WHERE status = 'pending')
      ORDER BY created_at DESC
    `);
    const rows = stmt.all() as Array<Record<string, unknown>>;
    const nodes = rows.map((r) => this.mapNode(r)!) as FleetNodeWithCamel[];
    if (filter?.status) {
      return nodes.filter((n) => n.status === filter.status);
    }
    return nodes;
  }

  async recordHeartbeat(
    nodeId: string,
    input: RecordHeartbeatInput,
  ): Promise<void> {
    const now = Date.now();
    const node = await this.getNode(nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found`);

    const status = input.status || 'online';
    this.db
      .prepare(
        'UPDATE fleet_nodes SET status = ?, public_ip = COALESCE(?, public_ip), agent_version = COALESCE(?, agent_version), last_heartbeat_at = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        status,
        input.publicIp || null,
        input.agentVersion || null,
        now,
        now,
        nodeId,
      );
  }

  async createProxyEndpoint(
    input: CreateEndpointInput,
  ): Promise<FleetEndpointWithCamel> {
    if (
      !Number.isInteger(input.listenPort) ||
      input.listenPort < 1 ||
      input.listenPort > 65535
    )
      throw new Error('Invalid managed listener port');
    if (input.protocol !== 'http' && input.protocol !== 'socks5')
      throw new Error('Invalid managed proxy protocol');
    if (
      !input.username ||
      /[\s\r\n:]/.test(input.username) ||
      /[\r\n]/.test(input.password ?? '')
    )
      throw new Error('Invalid proxy credentials');
    const activeNode = await this.getNode(input.nodeId);
    if (!activeNode) throw new Error('Node not found');
    const validBindIp =
      (activeNode.tailscale_ip && input.listenIp === activeNode.tailscale_ip) ||
      input.listenIp === activeNode.wireguard_ip;
    if (!validBindIp)
      throw new Error(
        'Managed listener must bind the node Tailscale or overlay IP',
      );
    const id = input.id || crypto.randomUUID();
    const credRef = `cred-${crypto.randomUUID()}`;
    const encrypted = input.password ? encryptSecret(input.password) : null;

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const nodeRow = this.db
        .prepare(
          "SELECT desired_revision, proxy_activation, tailscale_ip FROM fleet_nodes WHERE id = ? AND NOT EXISTS (SELECT 1 FROM fleet_node_removals r WHERE r.node_id = fleet_nodes.id AND r.status = 'pending')",
        )
        .get(input.nodeId) as
        | {
            desired_revision: number;
            proxy_activation: string;
            tailscale_ip: string | null;
          }
        | undefined;
      if (!nodeRow) throw new Error(`Node ${input.nodeId} not found`);
      const nextRevision = (Number(nodeRow.desired_revision) || 0) + 1;
      const now = Date.now();
      // If node is Tailscale-based and activation is disabled, force endpoint disabled
      const isBlocked =
        nodeRow.tailscale_ip && nodeRow.proxy_activation === 'disabled';
      const initialEnabled = isBlocked || input.enabled === false ? 0 : 1;

      this.db
        .prepare(`
        INSERT INTO fleet_proxy_endpoints (
          id, node_id, protocol, listen_ip, listen_port, egress_id, username, credential_ref, enabled, current_revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          id,
          input.nodeId,
          input.protocol,
          input.listenIp,
          input.listenPort,
          input.egressId || null,
          input.username,
          credRef,
          initialEnabled,
          1,
          now,
          now,
        );

      if (encrypted) {
        this.db
          .prepare(`
          INSERT INTO fleet_proxy_credentials (
            id, endpoint_id, username, encrypted_password, salt, iv, tag, rotated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
          .run(
            credRef,
            id,
            input.username,
            encrypted.ciphertext,
            encrypted.salt,
            encrypted.iv,
            encrypted.tag,
            now,
          );
      }

      this.db
        .prepare(
          "UPDATE fleet_nodes SET desired_revision = ?, deployment_status = 'pending', deployment_error = NULL, updated_at = ? WHERE id = ?",
        )
        .run(nextRevision, now, input.nodeId);

      const createdRow = this.db
        .prepare('SELECT * FROM fleet_proxy_endpoints WHERE id = ?')
        .get(id) as Record<string, unknown> | undefined;

      this.db.exec('COMMIT;');
      return this.mapEndpoint(createdRow)!;
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  async listEndpoints(filter?: {
    nodeId?: string;
    enabled?: boolean;
  }): Promise<FleetEndpointWithCamel[]> {
    let sql = `
      SELECT * FROM fleet_proxy_endpoints
      WHERE node_id NOT IN (SELECT node_id FROM fleet_node_removals WHERE status = 'pending')
    `;
    const params: Array<string | number> = [];

    if (filter?.nodeId) {
      sql += ' AND node_id = ?';
      params.push(filter.nodeId);
    }
    if (filter?.enabled !== undefined) {
      sql += ' AND enabled = ?';
      params.push(filter.enabled ? 1 : 0);
    }
    sql += ' ORDER BY listen_port ASC';

    const rows = this.db.prepare(sql).all(...params) as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => this.mapEndpoint(r)!) as FleetEndpointWithCamel[];
  }

  async getEndpoint(id: string): Promise<FleetEndpointWithCamel | null> {
    const row = this.db
      .prepare(`
      SELECT * FROM fleet_proxy_endpoints
      WHERE id = ? AND node_id NOT IN (SELECT node_id FROM fleet_node_removals WHERE status = 'pending')
    `)
      .get(id) as Record<string, unknown> | undefined;
    return this.mapEndpoint(row);
  }

  async getEndpointCredentials(
    endpointId: string,
  ): Promise<{ username: string; password: string } | null> {
    const row = this.db
      .prepare(`
        SELECT c.username, c.encrypted_password, c.salt, c.iv, c.tag
        FROM fleet_proxy_credentials c
        JOIN fleet_proxy_endpoints e ON e.id = c.endpoint_id
        WHERE c.endpoint_id = ?
          AND e.node_id NOT IN (SELECT node_id FROM fleet_node_removals WHERE status = 'pending')
      `)
      .get(endpointId) as
      | (EncryptedPayload & { username: string; encrypted_password: string })
      | undefined;
    if (!row) return null;
    const decrypted = decryptSecret({
      ciphertext: row.encrypted_password,
      salt: row.salt,
      iv: row.iv,
      tag: row.tag,
    });
    return { username: row.username, password: decrypted };
  }

  async getNodeDesiredState(
    nodeId: string,
  ): Promise<FleetNodeDesiredState | null> {
    if (!nodeId) return null;

    const removal = this.db
      .prepare('SELECT status FROM fleet_node_removals WHERE node_id = ?')
      .get(nodeId) as { status: string } | undefined;
    if (removal?.status === 'pending') {
      return null;
    }

    this.db.exec('BEGIN;');
    try {
      const nodeRow = this.db
        .prepare(
          'SELECT desired_revision, capacity_max_connections FROM fleet_nodes WHERE id = ?',
        )
        .get(nodeId) as
        | { desired_revision: number; capacity_max_connections: number | null }
        | undefined;
      if (!nodeRow) {
        this.db.exec('ROLLBACK;');
        return null;
      }

      const revision = Number(nodeRow.desired_revision || 1);

      const endpoints = this.db
        .prepare(
          'SELECT * FROM fleet_proxy_endpoints WHERE node_id = ? AND enabled = 1 ORDER BY listen_port ASC',
        )
        .all(nodeId) as Array<Record<string, unknown>>;

      const getCredStmt = this.db.prepare(
        'SELECT username, encrypted_password, salt, iv, tag FROM fleet_proxy_credentials WHERE endpoint_id = ?',
      );

      const proxies = endpoints.map((ep) => {
        const epId = String(ep.id);
        const credRow = getCredStmt.get(epId) as
          | (EncryptedPayload & {
              username: string;
              encrypted_password: string;
            })
          | undefined;

        let password = '';
        let username = String(ep.username);
        if (credRow) {
          username = credRow.username || username;
          password = decryptSecret({
            ciphertext: credRow.encrypted_password,
            salt: credRow.salt,
            iv: credRow.iv,
            tag: credRow.tag,
          });
        }

        return {
          id: epId,
          node_id: String(ep.node_id),
          protocol: ep.protocol as FleetProxyProtocol,
          listen_ip: String(ep.listen_ip),
          listen_port: Number(ep.listen_port),
          username,
          password,
          enabled: Boolean(ep.enabled),
          current_revision: Number(ep.current_revision),
        };
      });

      this.db.exec('COMMIT;');
      return {
        revision,
        capacity: { maxConnections: nodeRow.capacity_max_connections },
        proxies,
      };
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  async updateEndpoint(
    id: string,
    patch: { enabled?: boolean; username?: string; password?: string },
  ): Promise<FleetEndpointWithCamel> {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const epRow = this.db
        .prepare('SELECT * FROM fleet_proxy_endpoints WHERE id = ?')
        .get(id) as Record<string, unknown> | undefined;
      if (!epRow) throw new Error(`Endpoint ${id} not found`);

      const currentEnabled = Boolean(epRow.enabled);
      const currentUsername = String(epRow.username);
      const nodeId = String(epRow.node_id);

      const credRow = this.db
        .prepare(
          'SELECT id, username, encrypted_password, salt, iv, tag FROM fleet_proxy_credentials WHERE endpoint_id = ?',
        )
        .get(id) as
        | (EncryptedPayload & {
            id: string;
            username: string;
            encrypted_password: string;
          })
        | undefined;

      const targetEnabled =
        patch.enabled !== undefined ? Boolean(patch.enabled) : currentEnabled;
      const targetUsername =
        patch.username !== undefined ? patch.username : currentUsername;
      const isEnabledChanged =
        patch.enabled !== undefined && patch.enabled !== currentEnabled;
      const isUsernameChanged =
        patch.username !== undefined && patch.username !== currentUsername;

      let isPasswordChanged = false;
      let encrypted: EncryptedPayload | null = null;
      if (patch.password !== undefined) {
        if (credRow) {
          const currentPassword = decryptSecret({
            ciphertext: credRow.encrypted_password,
            salt: credRow.salt,
            iv: credRow.iv,
            tag: credRow.tag,
          });
          isPasswordChanged = patch.password !== currentPassword;
        } else {
          isPasswordChanged = true;
        }
        if (isPasswordChanged) {
          encrypted = encryptSecret(patch.password);
        }
      }

      if (!isEnabledChanged && !isUsernameChanged && !isPasswordChanged) {
        this.db.exec('COMMIT;');
        return this.mapEndpoint(epRow)!;
      }

      const now = Date.now();
      const nodeRow = this.db
        .prepare(
          "SELECT desired_revision FROM fleet_nodes WHERE id = ? AND NOT EXISTS (SELECT 1 FROM fleet_node_removals r WHERE r.node_id = fleet_nodes.id AND r.status = 'pending')",
        )
        .get(nodeId) as { desired_revision: number } | undefined;
      if (!nodeRow) throw new Error(`Node ${nodeId} not found`);
      const nextNodeRevision = (Number(nodeRow.desired_revision) || 0) + 1;
      const nextEndpointRevision = (Number(epRow.current_revision) || 1) + 1;

      this.db
        .prepare(`
        UPDATE fleet_proxy_endpoints
        SET enabled = ?,
            username = ?,
            current_revision = ?,
            updated_at = ?
        WHERE id = ?
      `)
        .run(
          targetEnabled ? 1 : 0,
          targetUsername,
          nextEndpointRevision,
          now,
          id,
        );

      if (encrypted) {
        if (credRow) {
          this.db
            .prepare(`
            UPDATE fleet_proxy_credentials
            SET username = ?,
                encrypted_password = ?,
                salt = ?,
                iv = ?,
                tag = ?,
                rotated_at = ?
            WHERE endpoint_id = ?
          `)
            .run(
              targetUsername,
              encrypted.ciphertext,
              encrypted.salt,
              encrypted.iv,
              encrypted.tag,
              now,
              id,
            );
        } else {
          const credRef = epRow.credential_ref
            ? String(epRow.credential_ref)
            : `cred-${crypto.randomUUID()}`;
          this.db
            .prepare(`
            INSERT INTO fleet_proxy_credentials (
              id, endpoint_id, username, encrypted_password, salt, iv, tag, rotated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `)
            .run(
              credRef,
              id,
              targetUsername,
              encrypted.ciphertext,
              encrypted.salt,
              encrypted.iv,
              encrypted.tag,
              now,
            );
        }
      } else if (isUsernameChanged && credRow) {
        this.db
          .prepare(
            'UPDATE fleet_proxy_credentials SET username = ? WHERE endpoint_id = ?',
          )
          .run(targetUsername, id);
      }

      this.db
        .prepare(
          "UPDATE fleet_nodes SET desired_revision = ?, deployment_status = 'pending', deployment_error = NULL, updated_at = ? WHERE id = ?",
        )
        .run(nextNodeRevision, now, nodeId);

      const updatedRow = this.db
        .prepare('SELECT * FROM fleet_proxy_endpoints WHERE id = ?')
        .get(id) as Record<string, unknown> | undefined;

      this.db.exec('COMMIT;');
      return this.mapEndpoint(updatedRow)!;
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }
  async recordHealthCheck(
    input: RecordHealthCheckInput,
  ): Promise<FleetHealthCheckWithCamel> {
    const removal = this.db
      .prepare('SELECT status FROM fleet_node_removals WHERE node_id = ?')
      .get(input.nodeId) as { status: string } | undefined;
    if (removal?.status === 'pending') {
      throw new Error(
        `Cannot record health check: node ${input.nodeId} is pending removal`,
      );
    }
    const node = this.db
      .prepare('SELECT id FROM fleet_nodes WHERE id = ?')
      .get(input.nodeId);
    if (!node) {
      throw new Error(
        `Cannot record health check: node ${input.nodeId} not found`,
      );
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare(`
      INSERT INTO fleet_health_checks (
        id, endpoint_id, node_id, status, exit_ip, latency_ms, error_message, checked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        input.endpointId,
        input.nodeId,
        input.status,
        input.exitIp || null,
        input.latencyMs ?? null,
        input.errorMessage || null,
        now,
      );

    return {
      id,
      endpoint_id: input.endpointId,
      endpointId: input.endpointId,
      node_id: input.nodeId,
      nodeId: input.nodeId,
      status: input.status,
      exit_ip: input.exitIp || null,
      exitIp: input.exitIp || null,
      latency_ms: input.latencyMs ?? null,
      latencyMs: input.latencyMs ?? null,
      error_message: input.errorMessage || null,
      checked_at: now,
    };
  }

  async getLatestHealthCheck(
    endpointId: string,
  ): Promise<FleetHealthCheckWithCamel | null> {
    const row = this.db
      .prepare(
        'SELECT * FROM fleet_health_checks WHERE endpoint_id = ? ORDER BY checked_at DESC LIMIT 1',
      )
      .get(endpointId) as Record<string, unknown> | undefined;
    return this.mapHealthCheck(row);
  }

  async recordEvent(input: RecordEventInput): Promise<FleetEventRecord> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const payloadStr = JSON.stringify(input.payload || {});

    this.db
      .prepare(`
      INSERT INTO fleet_events (
        id, node_id, endpoint_id, event_type, level, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        input.nodeId || null,
        input.endpointId || null,
        input.eventType,
        input.level,
        payloadStr,
        now,
      );

    return {
      id,
      node_id: input.nodeId || null,
      endpoint_id: input.endpointId || null,
      event_type: input.eventType,
      level: input.level,
      payload: input.payload || {},
      created_at: now,
    };
  }

  async listEvents(filter?: {
    nodeId?: string;
    endpointId?: string;
    limit?: number;
  }): Promise<FleetEventRecord[]> {
    let sql = 'SELECT * FROM fleet_events';
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (filter?.nodeId) {
      conditions.push('node_id = ?');
      params.push(filter.nodeId);
    }
    if (filter?.endpointId) {
      conditions.push('endpoint_id = ?');
      params.push(filter.endpointId);
    }
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }
    sql += ` ORDER BY created_at DESC LIMIT ${Math.min(500, filter?.limit || 100)}`;

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      node_id: string | null;
      endpoint_id: string | null;
      event_type: string;
      level: 'info' | 'warn' | 'error';
      payload_json: string;
      created_at: number;
    }>;

    return rows.map((r) => {
      let payload = {};
      try {
        payload = JSON.parse(r.payload_json);
      } catch {
        // ignore malformed
      }
      return {
        id: r.id,
        node_id: r.node_id,
        endpoint_id: r.endpoint_id,
        event_type: r.event_type,
        eventType: r.event_type,
        level: r.level,
        payload,
        created_at: r.created_at,
        createdAt: r.created_at,
      };
    });
  }

  async recordDeploymentResult(
    input: RecordDeploymentResultInput,
  ): Promise<RecordDeploymentResultOutcome> {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const nodeRow = this.db
        .prepare('SELECT * FROM fleet_nodes WHERE id = ?')
        .get(input.nodeId) as Record<string, unknown> | undefined;

      if (!nodeRow) {
        this.db.exec('ROLLBACK;');
        return { ok: false, accepted: false, reason: 'node_not_found' };
      }

      const desiredRevision = Number(nodeRow.desired_revision || 1);
      const currentDeploymentRev =
        nodeRow.deployment_revision != null
          ? Number(nodeRow.deployment_revision)
          : 0;
      const currentDeploymentStatus =
        (nodeRow.deployment_status as FleetConfigurationStatus) || 'unknown';
      const currentDeploymentError = nodeRow.deployment_error
        ? String(nodeRow.deployment_error)
        : null;

      if (input.revision > desiredRevision) {
        this.db.exec('ROLLBACK;');
        return { ok: false, accepted: false, reason: 'future_revision' };
      }

      if (input.revision < currentDeploymentRev) {
        this.db.exec('ROLLBACK;');
        return { ok: true, accepted: false, reason: 'stale_revision' };
      }

      if (input.revision === currentDeploymentRev) {
        if (currentDeploymentStatus === 'applied') {
          this.db.exec('ROLLBACK;');
          return { ok: true, accepted: false, reason: 'duplicate_revision' };
        }
        if (
          currentDeploymentStatus === 'failed' &&
          input.status === 'failed' &&
          (currentDeploymentError || '') === (input.errorMessage || '')
        ) {
          this.db.exec('ROLLBACK;');
          return { ok: true, accepted: false, reason: 'duplicate_revision' };
        }
      }

      const now = Date.now();
      const deploymentId = `dep-${crypto.randomUUID()}`;
      const appliedAt = input.status === 'applied' ? now : null;

      this.db
        .prepare(`
        INSERT INTO fleet_deployments (
          id, node_id, revision, config_digest, status, error_message, applied_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          deploymentId,
          input.nodeId,
          input.revision,
          input.configDigest,
          input.status,
          input.errorMessage ?? null,
          appliedAt,
          now,
        );

      const eventId = `evt-${crypto.randomUUID()}`;
      const eventType =
        input.status === 'applied'
          ? 'node_config_applied'
          : 'node_config_failed';
      const level = input.status === 'applied' ? 'info' : 'error';
      const payload = JSON.stringify({
        revision: input.revision,
        desiredRevision,
        configDigest: input.configDigest,
        error: input.errorMessage ?? null,
      });

      this.db
        .prepare(`
        INSERT INTO fleet_events (
          id, node_id, endpoint_id, event_type, level, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
        .run(eventId, input.nodeId, null, eventType, level, payload, now);

      const newDeploymentRev = Math.max(input.revision, currentDeploymentRev);
      let newAppliedRev =
        nodeRow.applied_revision != null
          ? Number(nodeRow.applied_revision)
          : null;
      let newDeploymentStatus: FleetConfigurationStatus;
      let newDeploymentError: string | null = null;

      if (input.status === 'applied') {
        newAppliedRev = Math.max(input.revision, newAppliedRev ?? 0);
        newDeploymentStatus =
          input.revision === desiredRevision ? 'applied' : 'pending';
        newDeploymentError = null;
      } else {
        newDeploymentStatus =
          input.revision === desiredRevision ? 'failed' : 'pending';
        newDeploymentError = input.errorMessage || 'Deployment failed';
      }

      this.db
        .prepare(`
        UPDATE fleet_nodes
        SET deployment_revision = ?,
            applied_revision = ?,
            deployment_status = ?,
            deployment_error = ?,
            deployment_updated_at = ?,
            updated_at = ?
        WHERE id = ?
      `)
        .run(
          newDeploymentRev,
          newAppliedRev,
          newDeploymentStatus,
          newDeploymentError,
          now,
          now,
          input.nodeId,
        );

      this.db.exec('COMMIT;');

      const updatedRow = this.db
        .prepare('SELECT * FROM fleet_nodes WHERE id = ?')
        .get(input.nodeId) as Record<string, unknown> | undefined;
      const mappedNode = this.mapNode(updatedRow);

      return {
        ok: true,
        accepted: true,
        node: mappedNode ?? undefined,
      };
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // ignore
      }
      throw err;
    }
  }

  async getNodeDeployments(
    nodeId: string,
    limit = 20,
  ): Promise<FleetDeploymentRecord[]> {
    const rows = this.db
      .prepare(
        'SELECT * FROM fleet_deployments WHERE node_id = ? ORDER BY revision DESC, created_at DESC LIMIT ?',
      )
      .all(nodeId, limit) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: String(r.id),
      node_id: String(r.node_id),
      revision: Number(r.revision),
      config_digest: String(r.config_digest),
      status: r.status as FleetDeploymentStatus,
      error_message: r.error_message ? String(r.error_message) : null,
      applied_at: r.applied_at != null ? Number(r.applied_at) : null,
      created_at: Number(r.created_at),
    }));
  }
  async createEnrollmentToken(input: {
    tokenHash: string;
    nodeName: string;
    expiresAt: number;
    assignedIp?: string | null;
  }): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(`
      INSERT INTO fleet_enrollment_tokens (
        token_hash, node_name, assigned_ip, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `)
      .run(
        input.tokenHash,
        input.nodeName,
        input.assignedIp || null,
        input.expiresAt,
        now,
      );
  }

  async consumeEnrollmentToken(
    tokenHash: string,
  ): Promise<{ nodeName: string; assignedIp: string | null } | null> {
    const now = Date.now();
    const row = this.db
      .prepare(
        'UPDATE fleet_enrollment_tokens SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at >= ? RETURNING node_name, assigned_ip',
      )
      .get(now, tokenHash, now) as
      | { node_name: string; assigned_ip: string | null }
      | undefined;

    if (!row) {
      return null;
    }

    return { nodeName: row.node_name, assignedIp: row.assigned_ip };
  }

  async getNextWireguardIp(): Promise<string> {
    const rows = this.db
      .prepare(`
      SELECT wireguard_ip FROM fleet_nodes
      UNION
      SELECT wireguard_ip FROM fleet_node_removals WHERE status = 'pending'
    `)
      .all() as Array<{ wireguard_ip: string }>;
    const usedLastOctets = new Set<number>();
    for (const r of rows) {
      const parts = r.wireguard_ip.split('.');
      if (parts.length === 4) {
        const octet = Number(parts[3]);
        if (Number.isInteger(octet)) usedLastOctets.add(octet);
      }
    }

    // Controller is 10.77.0.1; workers start at 10.77.0.11 up to 254
    for (let i = 11; i <= 254; i++) {
      if (!usedLastOctets.has(i)) {
        return `10.77.0.${i}`;
      }
    }
    throw new Error('No available WireGuard IP in subnet 10.77.0.0/24');
  }

  async requestNodeRemoval(nodeId: string): Promise<FleetRemovalRecord> {
    if (!nodeId) throw new Error('nodeId is required');

    const existingRemoval = this.db
      .prepare('SELECT * FROM fleet_node_removals WHERE node_id = ?')
      .get(nodeId) as Record<string, unknown> | undefined;
    if (existingRemoval) {
      if (existingRemoval.status === 'completed') {
        return this.mapRemoval(existingRemoval)!;
      }
      this.db
        .prepare(
          'UPDATE fleet_nodes SET agent_token_hash = NULL, runtime_session_id = NULL, runtime_sequence = 0 WHERE id = ?',
        )
        .run(nodeId);
      return this.mapRemoval(existingRemoval)!;
    }

    const nodeRow = this.db
      .prepare('SELECT * FROM fleet_nodes WHERE id = ?')
      .get(nodeId) as Record<string, unknown> | undefined;
    if (!nodeRow) {
      const err = new Error(`Node ${nodeId} not found`);
      Object.assign(err, { status: 404, statusCode: 404 });
      throw err;
    }

    const role = String(nodeRow.role || 'worker');
    if (role === 'controller-worker' || nodeRow.wireguard_ip === '10.77.0.1') {
      const err = new Error('Cannot remove controller node');
      Object.assign(err, { status: 409, statusCode: 409 });
      throw err;
    }

    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          'UPDATE fleet_nodes SET agent_token_hash = NULL, runtime_session_id = NULL, runtime_sequence = 0, updated_at = ? WHERE id = ?',
        )
        .run(now, nodeId);
      this.db
        .prepare('DELETE FROM fleet_runtime_sessions WHERE node_id = ?')
        .run(nodeId);

      this.db
        .prepare(`
        INSERT INTO fleet_node_removals (
          node_id, node_name, wireguard_ip, wireguard_public_key, status, error_message, requested_at, completed_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', NULL, ?, NULL, ?)
      `)
        .run(
          nodeId,
          String(nodeRow.name || nodeId),
          String(nodeRow.wireguard_ip),
          nodeRow.wireguard_public_key
            ? String(nodeRow.wireguard_public_key)
            : null,
          now,
          now,
        );

      const eventId = `evt-${crypto.randomUUID()}`;
      const payload = JSON.stringify({
        nodeId,
        nodeName: String(nodeRow.name || nodeId),
        wireguardIp: String(nodeRow.wireguard_ip),
        status: 'pending',
      });
      this.db
        .prepare(`
        INSERT INTO fleet_events (id, node_id, endpoint_id, event_type, level, payload_json, created_at)
        VALUES (?, ?, NULL, 'node_removal_requested', 'info', ?, ?)
      `)
        .run(eventId, nodeId, payload, now);

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    const removalRow = this.db
      .prepare('SELECT * FROM fleet_node_removals WHERE node_id = ?')
      .get(nodeId) as Record<string, unknown> | undefined;
    return this.mapRemoval(removalRow)!;
  }

  async getNodeRemoval(nodeId: string): Promise<FleetRemovalRecord | null> {
    if (!nodeId) return null;
    const row = this.db
      .prepare('SELECT * FROM fleet_node_removals WHERE node_id = ?')
      .get(nodeId) as Record<string, unknown> | undefined;
    return this.mapRemoval(row);
  }

  async listPendingNodeRemovals(): Promise<FleetRemovalRecord[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM fleet_node_removals WHERE status = 'pending' ORDER BY requested_at DESC",
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRemoval(r)!);
  }

  async recordNodeRemovalError(nodeId: string, message: string): Promise<void> {
    if (!nodeId) return;
    const boundedMsg = message ? String(message).slice(0, 2048) : null;
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE fleet_node_removals SET error_message = ?, updated_at = ? WHERE node_id = ? AND status = 'pending'",
      )
      .run(boundedMsg, now, nodeId);
  }

  async completeNodeRemoval(nodeId: string): Promise<FleetRemovalRecord> {
    if (!nodeId) throw new Error('nodeId is required');
    const existing = this.db
      .prepare('SELECT * FROM fleet_node_removals WHERE node_id = ?')
      .get(nodeId) as Record<string, unknown> | undefined;

    if (!existing) {
      throw new Error(`No removal intent found for node ${nodeId}`);
    }
    if (existing.status === 'completed') {
      return this.mapRemoval(existing)!;
    }

    const now = Date.now();
    this.db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;');
    try {
      this.db.prepare('DELETE FROM fleet_nodes WHERE id = ?').run(nodeId);

      this.db
        .prepare(`
        UPDATE fleet_node_removals
        SET status = 'completed', error_message = NULL, completed_at = ?, updated_at = ?
        WHERE node_id = ?
      `)
        .run(now, now, nodeId);

      const eventId = `evt-${crypto.randomUUID()}`;
      const payload = JSON.stringify({
        nodeId,
        nodeName: String(existing.node_name),
        wireguardIp: String(existing.wireguard_ip),
        status: 'completed',
      });
      this.db
        .prepare(`
        INSERT INTO fleet_events (id, node_id, endpoint_id, event_type, level, payload_json, created_at)
        VALUES (?, ?, NULL, 'node_removal_completed', 'info', ?, ?)
      `)
        .run(eventId, nodeId, payload, now);

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    const completedRow = this.db
      .prepare('SELECT * FROM fleet_node_removals WHERE node_id = ?')
      .get(nodeId) as Record<string, unknown> | undefined;
    return this.mapRemoval(completedRow)!;
  }

  async listEndpointsForNodeRemovalCleanup(
    nodeId: string,
  ): Promise<FleetEndpointWithCamel[]> {
    const rows = this.db
      .prepare(
        'SELECT * FROM fleet_proxy_endpoints WHERE node_id = ? ORDER BY listen_port ASC',
      )
      .all(nodeId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapEndpoint(r)!) as FleetEndpointWithCamel[];
  }

  async enrollNodeAtomic(input: {
    token: string;
    nodeName: string;
    wireguardPublicKey: string;
    publicIp?: string | null;
    os?: string | null;
    arch?: string | null;
    agentVersion?: string | null;
    agentToken: string;
  }): Promise<FleetNodeWithCamel> {
    const tokenHash = crypto
      .createHash('sha256')
      .update(input.token)
      .digest('hex');
    const agentTokenHash = crypto
      .createHash('sha256')
      .update(input.agentToken)
      .digest('hex');
    const id = crypto.randomUUID();
    const now = Date.now();

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      if (
        typeof input.wireguardPublicKey !== 'string' ||
        !/^[A-Za-z0-9+/]{43}=$/.test(input.wireguardPublicKey) ||
        Buffer.from(input.wireguardPublicKey, 'base64').length !== 32
      ) {
        throw new Error(
          'Invalid WireGuard public key: must be 32-byte base64 encoded string',
        );
      }

      const keyInUse = this.db
        .prepare(`
        SELECT 1 FROM fleet_nodes WHERE wireguard_public_key = ?
        UNION
        SELECT 1 FROM fleet_node_removals WHERE wireguard_public_key = ? AND status = 'pending'
      `)
        .get(input.wireguardPublicKey, input.wireguardPublicKey);
      if (keyInUse) {
        throw new Error(
          'WireGuard public key already in use or reserved by pending removal',
        );
      }

      const consumed = this.db
        .prepare(
          'UPDATE fleet_enrollment_tokens SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at >= ? RETURNING node_name, assigned_ip',
        )
        .get(now, tokenHash, now) as
        | { node_name: string; assigned_ip: string | null }
        | undefined;

      if (!consumed) {
        throw new Error('Enrollment token already consumed or expired');
      }

      let assignedIp = consumed.assigned_ip;
      if (assignedIp) {
        const parts = assignedIp.split('.');
        const octet =
          parts.length === 4 &&
          parts[0] === '10' &&
          parts[1] === '77' &&
          parts[2] === '0'
            ? Number(parts[3])
            : NaN;
        if (!Number.isInteger(octet) || octet < 11 || octet > 254) {
          throw new Error(
            'Invalid assigned WireGuard IP: must be within 10.77.0.11-10.77.0.254',
          );
        }
        const ipInUse = this.db
          .prepare(`
          SELECT 1 FROM fleet_nodes WHERE wireguard_ip = ?
          UNION
          SELECT 1 FROM fleet_node_removals WHERE wireguard_ip = ? AND status = 'pending'
        `)
          .get(assignedIp, assignedIp);
        if (ipInUse) {
          throw new Error(
            `Assigned WireGuard IP ${assignedIp} already in use or reserved by pending removal`,
          );
        }
      }
      if (!assignedIp) {
        const rows = this.db
          .prepare(`
          SELECT wireguard_ip FROM fleet_nodes
          UNION
          SELECT wireguard_ip FROM fleet_node_removals WHERE status = 'pending'
        `)
          .all() as Array<{ wireguard_ip: string }>;
        const usedLastOctets = new Set<number>();
        for (const r of rows) {
          const parts = r.wireguard_ip.split('.');
          if (parts.length === 4) {
            const octet = Number(parts[3]);
            if (Number.isInteger(octet)) usedLastOctets.add(octet);
          }
        }
        for (let i = 11; i <= 254; i++) {
          if (!usedLastOctets.has(i)) {
            assignedIp = `10.77.0.${i}`;
            break;
          }
        }
        if (!assignedIp) {
          throw new Error('No available WireGuard IP in subnet 10.77.0.0/24');
        }
      }

      const nodeName = consumed.node_name || input.nodeName;
      this.db
        .prepare(`
        INSERT INTO fleet_nodes (
          id, name, role, status, public_ip, wireguard_ip, wireguard_public_key, os, arch, agent_version, desired_revision, agent_token_hash, created_at, updated_at
        ) VALUES (?, ?, 'worker', 'offline', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `)
        .run(
          id,
          nodeName,
          input.publicIp || null,
          assignedIp,
          input.wireguardPublicKey,
          input.os || null,
          input.arch || null,
          input.agentVersion || null,
          agentTokenHash,
          now,
          now,
        );

      const eventId = `evt-${crypto.randomUUID()}`;
      const payload = JSON.stringify({
        nodeId: id,
        nodeName,
        wireguardIp: assignedIp,
      });
      this.db
        .prepare(`
        INSERT INTO fleet_events (id, node_id, endpoint_id, event_type, level, payload_json, created_at)
        VALUES (?, ?, NULL, 'node.enrolled', 'info', ?, ?)
      `)
        .run(eventId, id, payload, now);

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    const node = await this.getNode(id);
    if (!node) throw new Error('Failed to retrieve enrolled node');
    return node;
  }
  async createTailscaleNode(input: {
    name: string;
    tailscaleIp: string;
    expectedPublicIp?: string | null;
  }): Promise<FleetNodeWithCamel> {
    const name = (input.name || '').trim();
    if (!name) throw new Error('node name is required');
    const tailscaleIp = validateTailscaleIpv4(input.tailscaleIp);
    const expectedPublicIp = input.expectedPublicIp
      ? validatePublicIpv4(input.expectedPublicIp)
      : null;

    const id = crypto.randomUUID();
    const now = Date.now();
    const dummyWireguardIp = `10.77.255.${Math.floor(Math.random() * 240 + 10)}`; // transitional unique allocation

    this.db
      .prepare(`
      INSERT INTO fleet_nodes (
        id, name, role, status, public_ip, wireguard_ip, tailscale_ip, expected_public_ip,
        public_ip_status, proxy_activation, provision_status, desired_revision, created_at, updated_at
      ) VALUES (?, ?, 'worker', 'offline', NULL, ?, ?, ?, 'unknown', 'disabled', 'pending', 1, ?, ?)
    `)
      .run(id, name, dummyWireguardIp, tailscaleIp, expectedPublicIp, now, now);

    const node = await this.getNode(id);
    if (!node) throw new Error('Failed to insert Tailscale node');
    return node;
  }

  async setNodeSshCredentials(
    nodeId: string,
    input: {
      username: string;
      password: string;
      port?: number;
      hostKeyFingerprint: string;
    },
  ): Promise<void> {
    if (!nodeId) throw new Error('nodeId is required');
    const username = (input.username || '').trim();
    if (!username) throw new Error('SSH username is required');
    if (!input.password) throw new Error('SSH password is required');
    const port = Number(input.port || 22);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('Invalid SSH port');
    const fingerprint = (input.hostKeyFingerprint || '').trim();
    if (!fingerprint) throw new Error('Host key fingerprint is required');

    const encrypted = encryptSecret(input.password);
    const now = Date.now();

    this.db
      .prepare(`
      INSERT INTO fleet_node_ssh (
        node_id, username, encrypted_password, salt, iv, tag, port, host_key_fingerprint, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET
        username = excluded.username,
        encrypted_password = excluded.encrypted_password,
        salt = excluded.salt,
        iv = excluded.iv,
        tag = excluded.tag,
        port = excluded.port,
        host_key_fingerprint = excluded.host_key_fingerprint,
        updated_at = excluded.updated_at
    `)
      .run(
        nodeId,
        username,
        encrypted.ciphertext,
        encrypted.salt,
        encrypted.iv,
        encrypted.tag,
        port,
        fingerprint,
        now,
      );
  }

  async getNodeSshCredentials(
    nodeId: string,
  ): Promise<{
    username: string;
    password: string;
    port: number;
    hostKeyFingerprint: string;
  } | null> {
    if (!nodeId) return null;
    const row = this.db
      .prepare('SELECT * FROM fleet_node_ssh WHERE node_id = ?')
      .get(nodeId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const password = decryptSecret({
      ciphertext: String(row.encrypted_password),
      salt: String(row.salt),
      iv: String(row.iv),
      tag: String(row.tag),
    });
    return {
      username: String(row.username),
      password,
      port: Number(row.port),
      hostKeyFingerprint: String(row.host_key_fingerprint),
    };
  }

  async recordProvisioningState(
    nodeId: string,
    input: { status: FleetProvisionStatus; error: string | null },
  ): Promise<void> {
    if (!nodeId) throw new Error('nodeId is required');
    const now = Date.now();
    this.db
      .prepare(`
      UPDATE fleet_nodes
      SET provision_status = ?, provision_error = ?, updated_at = ?
      WHERE id = ?
    `)
      .run(input.status, input.error, now, nodeId);
  }

  async getActiveWorkerPublicIps(excludeNodeId?: string): Promise<string[]> {
    const rows = this.db
      .prepare(`
      SELECT public_ip FROM fleet_nodes
      WHERE role = 'worker'
        AND proxy_activation = 'enabled'
        AND public_ip IS NOT NULL
        AND id NOT IN (SELECT node_id FROM fleet_node_removals WHERE status = 'pending')
        ${excludeNodeId ? 'AND id != ?' : ''}
    `)
      .all(...(excludeNodeId ? [excludeNodeId] : [])) as Array<{
      public_ip: string;
    }>;
    return rows.map((r) => r.public_ip).filter(Boolean);
  }

  async recordPublicIpObservation(
    nodeId: string,
    observed: string | null,
  ): Promise<IpDecision> {
    if (!nodeId) throw new Error('nodeId is required');

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const nodeRow = this.db
        .prepare('SELECT * FROM fleet_nodes WHERE id = ?')
        .get(nodeId) as Record<string, unknown> | undefined;
      if (!nodeRow) throw new Error(`Node ${nodeId} not found`);

      const activePeers = await this.getActiveWorkerPublicIps(nodeId);
      const decision = evaluatePublicIp({
        observed,
        expected: nodeRow.expected_public_ip
          ? String(nodeRow.expected_public_ip)
          : null,
        activePeerIps: activePeers,
      });

      const now = Date.now();
      const cleanObserved = observed ? observed.trim() : null;
      const newActivation =
        decision.status === 'verified' && nodeRow.proxy_activation === 'enabled'
          ? 'enabled'
          : 'disabled';

      this.db
        .prepare(`
        UPDATE fleet_nodes
        SET public_ip = ?, public_ip_status = ?, public_ip_checked_at = ?,
            proxy_activation = ?, proxy_activation_reason = ?, updated_at = ?
        WHERE id = ?
      `)
        .run(
          cleanObserved,
          decision.status,
          now,
          newActivation,
          decision.reason,
          now,
          nodeId,
        );

      this.db.exec('COMMIT;');
      return decision;
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  async activateNode(nodeId: string): Promise<FleetNodeWithCamel> {
    if (!nodeId) throw new Error('nodeId is required');

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const nodeRow = this.db
        .prepare('SELECT * FROM fleet_nodes WHERE id = ?')
        .get(nodeId) as Record<string, unknown> | undefined;
      if (!nodeRow) throw new Error(`Node ${nodeId} not found`);

      if (nodeRow.public_ip_status !== 'verified') {
        throw new Error(
          `Cannot activate node: public IP status is '${nodeRow.public_ip_status}'`,
        );
      }
      if (nodeRow.provision_status !== 'ready') {
        throw new Error(
          `Cannot activate node: provision status is '${nodeRow.provision_status}'`,
        );
      }

      // Duplicate check against other enabled workers
      const activePeers = await this.getActiveWorkerPublicIps(nodeId);
      if (
        nodeRow.public_ip &&
        activePeers.includes(String(nodeRow.public_ip))
      ) {
        this.db
          .prepare(
            "UPDATE fleet_nodes SET public_ip_status = 'duplicate', proxy_activation = 'disabled', proxy_activation_reason = 'Duplicate public IP active on another node' WHERE id = ?",
          )
          .run(nodeId);
        throw new Error(
          'Cannot activate node: public IP is active on another node',
        );
      }

      const now = Date.now();
      const nextRevision = (Number(nodeRow.desired_revision) || 0) + 1;

      this.db
        .prepare(`
        UPDATE fleet_nodes
        SET proxy_activation = 'enabled', proxy_activation_reason = NULL, desired_revision = ?, deployment_status = 'pending', updated_at = ?
        WHERE id = ?
      `)
        .run(nextRevision, now, nodeId);

      // Enable all proxy endpoints for this node
      this.db
        .prepare(`
        UPDATE fleet_proxy_endpoints
        SET enabled = 1, current_revision = current_revision + 1, updated_at = ?
        WHERE node_id = ?
      `)
        .run(now, nodeId);

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return (await this.getNode(nodeId))!;
  }

  async disableNode(
    nodeId: string,
    reason?: string | null,
  ): Promise<FleetNodeWithCamel> {
    if (!nodeId) throw new Error('nodeId is required');
    const now = Date.now();

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const nodeRow = this.db
        .prepare('SELECT desired_revision FROM fleet_nodes WHERE id = ?')
        .get(nodeId) as { desired_revision: number } | undefined;
      if (!nodeRow) throw new Error(`Node ${nodeId} not found`);
      const nextRevision = (Number(nodeRow.desired_revision) || 0) + 1;

      this.db
        .prepare(`
        UPDATE fleet_nodes
        SET proxy_activation = 'disabled', proxy_activation_reason = ?, desired_revision = ?, deployment_status = 'pending', updated_at = ?
        WHERE id = ?
      `)
        .run(reason || null, nextRevision, now, nodeId);

      // Force disable all endpoints
      this.db
        .prepare(`
        UPDATE fleet_proxy_endpoints
        SET enabled = 0, current_revision = current_revision + 1, updated_at = ?
        WHERE node_id = ?
      `)
        .run(now, nodeId);

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return (await this.getNode(nodeId))!;
  }

  close(): void {
    try {
      this.client.close();
    } catch {
      // ignore
    }
  }
}

export function createFleetRepository(
  options: { sqlitePath?: string } = {},
): FleetRepository {
  const sqlitePath =
    options.sqlitePath || path.join(process.cwd(), 'data', 'fleet.sqlite3');
  return new SqliteFleetRepository(sqlitePath);
}
