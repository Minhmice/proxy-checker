import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { encryptSecret, decryptSecret, type EncryptedPayload } from "./security.js";
import type {
  FleetNodeRecord,
  FleetNodeRole,
  FleetNodeStatus,
  FleetProxyEndpointRecord,
  FleetProxyProtocol,
  FleetHealthCheckRecord,
  FleetHealthStatus,
  FleetEventRecord,
} from "./types.js";

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
  level: "info" | "warn" | "error";
  payload?: Record<string, unknown>;
}

export type FleetNodeWithCamel = FleetNodeRecord & {
  wireguardIp: string;
  publicIp: string | null;
  agentVersion: string | null;
};

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
  createNode(input: CreateNodeInput): Promise<FleetNodeWithCamel>;
  getNode(id: string): Promise<FleetNodeWithCamel | null>;
  listNodes(filter?: { status?: FleetNodeStatus }): Promise<FleetNodeWithCamel[]>;
  recordHeartbeat(nodeId: string, input: RecordHeartbeatInput): Promise<void>;
  createProxyEndpoint(input: CreateEndpointInput): Promise<FleetEndpointWithCamel>;
  listEndpoints(filter?: { nodeId?: string; enabled?: boolean }): Promise<FleetEndpointWithCamel[]>;
  getEndpoint(id: string): Promise<FleetEndpointWithCamel | null>;
  getEndpointCredentials(endpointId: string): Promise<{ username: string; password: string } | null>;
  updateEndpoint(
    id: string,
    patch: { enabled?: boolean; username?: string; password?: string }
  ): Promise<FleetEndpointWithCamel>;
  recordHealthCheck(input: RecordHealthCheckInput): Promise<FleetHealthCheckWithCamel>;
  getLatestHealthCheck(endpointId: string): Promise<FleetHealthCheckWithCamel | null>;
  recordEvent(input: RecordEventInput): Promise<FleetEventRecord>;
  listEvents(filter?: { nodeId?: string; endpointId?: string; limit?: number }): Promise<FleetEventRecord[]>;
  createEnrollmentToken(input: { tokenHash: string; nodeName: string; expiresAt: number; assignedIp?: string | null }): Promise<void>;
  consumeEnrollmentToken(tokenHash: string): Promise<{ nodeName: string; assignedIp: string | null } | null>;
  getNextWireguardIp(): Promise<string>;
  bootstrapControllerNode(input?: BootstrapControllerNodeInput): Promise<FleetNodeWithCamel>;
  close(): void;
}

class SqliteFleetRepository implements FleetRepository {
  private db: DatabaseSync;

  constructor(filePath: string) {
    if (filePath !== ":memory:") {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
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

      CREATE INDEX IF NOT EXISTS idx_fleet_endpoints_node ON fleet_proxy_endpoints(node_id);
      CREATE INDEX IF NOT EXISTS idx_fleet_health_endpoint ON fleet_health_checks(endpoint_id, checked_at DESC);
      CREATE INDEX IF NOT EXISTS idx_fleet_events_created ON fleet_events(created_at DESC);
    `);
    try {
      this.db.exec("ALTER TABLE fleet_nodes ADD COLUMN role TEXT NOT NULL DEFAULT 'worker';");
    } catch {
      // column already exists
    }
  }

  private mapNode(row: Record<string, unknown> | undefined): FleetNodeWithCamel | null {
    if (!row) return null;
    return {
      id: String(row.id),
      name: String(row.name),
      role: (row.role as FleetNodeRole) || "worker",
      status: row.status as FleetNodeStatus,
      public_ip: row.public_ip ? String(row.public_ip) : null,
      publicIp: row.public_ip ? String(row.public_ip) : null,
      wireguard_ip: String(row.wireguard_ip),
      wireguardIp: String(row.wireguard_ip),
      wireguard_public_key: row.wireguard_public_key ? String(row.wireguard_public_key) : null,
      os: row.os ? String(row.os) : null,
      arch: row.arch ? String(row.arch) : null,
      agent_version: row.agent_version ? String(row.agent_version) : null,
      agentVersion: row.agent_version ? String(row.agent_version) : null,
      last_heartbeat_at: row.last_heartbeat_at ? Number(row.last_heartbeat_at) : null,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    };
  }

  private mapEndpoint(row: Record<string, unknown> | undefined): FleetEndpointWithCamel | null {
    if (!row) return null;
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
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    };
  }

  private mapHealthCheck(row: Record<string, unknown> | undefined): FleetHealthCheckWithCamel | null {
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
      latency_ms: row.latency_ms !== null && row.latency_ms !== undefined ? Number(row.latency_ms) : null,
      latencyMs: row.latency_ms !== null && row.latency_ms !== undefined ? Number(row.latency_ms) : null,
      error_message: row.error_message ? String(row.error_message) : null,
      checked_at: Number(row.checked_at),
    };
  }

  async createNode(input: CreateNodeInput): Promise<FleetNodeWithCamel> {
    const id = input.id || crypto.randomUUID();
    const now = Date.now();
    const query = `
      INSERT INTO fleet_nodes (
        id, name, role, status, public_ip, wireguard_ip, wireguard_public_key, os, arch, agent_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    this.db.prepare(query).run(
      id,
      input.name,
      input.role || "worker",
      input.status || "offline",
      input.publicIp || null,
      input.wireguardIp,
      input.wireguardPublicKey || null,
      input.os || null,
      input.arch || null,
      input.agentVersion || null,
      now,
      now
    );

    const node = await this.getNode(id);
    if (!node) throw new Error("Failed to insert node");
    return node;
  }

  async getNode(id: string): Promise<FleetNodeWithCamel | null> {
    const stmt = this.db.prepare("SELECT * FROM fleet_nodes WHERE id = ?");
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return this.mapNode(row);
  }

  async bootstrapControllerNode(input: BootstrapControllerNodeInput = {}): Promise<FleetNodeWithCamel> {
    const existing = this.db.prepare(
      "SELECT * FROM fleet_nodes WHERE role = 'controller-worker' OR wireguard_ip = '10.77.0.1' LIMIT 1"
    ).get() as Record<string, unknown> | undefined;

    if (existing) {
      return this.mapNode(existing)!;
    }

    const id = input.id || "controller-node-master";
    const name = input.name || "controller-001";
    const wireguardIp = input.wireguardIp || "10.77.0.1";
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO fleet_nodes (
        id, name, role, status, public_ip, wireguard_ip, wireguard_public_key, os, arch, agent_version, last_heartbeat_at, created_at, updated_at
      ) VALUES (?, ?, 'controller-worker', 'online', NULL, ?, NULL, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      name,
      wireguardIp,
      input.os || null,
      input.arch || null,
      input.agentVersion || null,
      now,
      now,
      now
    );

    return (await this.getNode(id))!;
  }

  async listNodes(filter?: { status?: FleetNodeStatus }): Promise<FleetNodeWithCamel[]> {
    if (filter?.status) {
      const stmt = this.db.prepare("SELECT * FROM fleet_nodes WHERE status = ? ORDER BY created_at DESC");
      const rows = stmt.all(filter.status) as Array<Record<string, unknown>>;
      return rows.map((r) => this.mapNode(r)!) as FleetNodeWithCamel[];
    }
    const stmt = this.db.prepare("SELECT * FROM fleet_nodes ORDER BY created_at DESC");
    const rows = stmt.all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapNode(r)!) as FleetNodeWithCamel[];
  }

  async recordHeartbeat(nodeId: string, input: RecordHeartbeatInput): Promise<void> {
    const now = Date.now();
    const node = await this.getNode(nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found`);

    const status = input.status || "online";
    this.db
      .prepare(
        "UPDATE fleet_nodes SET status = ?, public_ip = COALESCE(?, public_ip), agent_version = COALESCE(?, agent_version), last_heartbeat_at = ?, updated_at = ? WHERE id = ?"
      )
      .run(status, input.publicIp || null, input.agentVersion || null, now, now, nodeId);
  }

  async createProxyEndpoint(input: CreateEndpointInput): Promise<FleetEndpointWithCamel> {
    const id = input.id || crypto.randomUUID();
    const now = Date.now();
    const credRef = `cred-${crypto.randomUUID()}`;

    const node = await this.getNode(input.nodeId);
    if (!node) throw new Error(`Node ${input.nodeId} not found`);

    const insertEndpoint = this.db.prepare(`
      INSERT INTO fleet_proxy_endpoints (
        id, node_id, protocol, listen_ip, listen_port, egress_id, username, credential_ref, enabled, current_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);

    insertEndpoint.run(
      id,
      input.nodeId,
      input.protocol,
      input.listenIp,
      input.listenPort,
      input.egressId || null,
      input.username,
      credRef,
      input.enabled === false ? 0 : 1,
      now,
      now
    );

    if (input.password) {
      const encrypted = encryptSecret(input.password);
      this.db
        .prepare(`
        INSERT INTO fleet_proxy_credentials (
          id, endpoint_id, username, encrypted_password, salt, iv, tag, rotated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(credRef, id, input.username, encrypted.ciphertext, encrypted.salt, encrypted.iv, encrypted.tag, now);
    }

    const created = await this.getEndpoint(id);
    if (!created) throw new Error("Failed to create endpoint");
    return created;
  }

  async listEndpoints(filter?: { nodeId?: string; enabled?: boolean }): Promise<FleetEndpointWithCamel[]> {
    let sql = "SELECT * FROM fleet_proxy_endpoints";
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (filter?.nodeId) {
      conditions.push("node_id = ?");
      params.push(filter.nodeId);
    }
    if (filter?.enabled !== undefined) {
      conditions.push("enabled = ?");
      params.push(filter.enabled ? 1 : 0);
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    sql += " ORDER BY listen_port ASC";

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapEndpoint(r)!) as FleetEndpointWithCamel[];
  }

  async getEndpoint(id: string): Promise<FleetEndpointWithCamel | null> {
    const row = this.db.prepare("SELECT * FROM fleet_proxy_endpoints WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return this.mapEndpoint(row);
  }

  async getEndpointCredentials(endpointId: string): Promise<{ username: string; password: string } | null> {
    const row = this.db
      .prepare("SELECT username, encrypted_password, salt, iv, tag FROM fleet_proxy_credentials WHERE endpoint_id = ?")
      .get(endpointId) as (EncryptedPayload & { username: string; encrypted_password: string }) | undefined;

    if (!row) return null;
    const decrypted = decryptSecret({
      ciphertext: row.encrypted_password,
      salt: row.salt,
      iv: row.iv,
      tag: row.tag,
    });
    return { username: row.username, password: decrypted };
  }

  async updateEndpoint(
    id: string,
    patch: { enabled?: boolean; username?: string; password?: string }
  ): Promise<FleetEndpointWithCamel> {
    const now = Date.now();
    const current = await this.getEndpoint(id);
    if (!current) throw new Error(`Endpoint ${id} not found`);

    if (patch.enabled !== undefined || patch.username !== undefined) {
      this.db
        .prepare(`
        UPDATE fleet_proxy_endpoints
        SET enabled = COALESCE(?, enabled),
            username = COALESCE(?, username),
            current_revision = current_revision + 1,
            updated_at = ?
        WHERE id = ?
      `)
        .run(patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : null, patch.username || null, now, id);
    }

    if (patch.password) {
      const encrypted = encryptSecret(patch.password);
      this.db
        .prepare(`
        UPDATE fleet_proxy_credentials
        SET encrypted_password = ?, salt = ?, iv = ?, tag = ?, rotated_at = ?
        WHERE endpoint_id = ?
      `)
        .run(encrypted.ciphertext, encrypted.salt, encrypted.iv, encrypted.tag, now, id);
    }

    const updated = await this.getEndpoint(id);
    if (!updated) throw new Error("Endpoint missing after update");
    return updated;
  }
  async recordHealthCheck(input: RecordHealthCheckInput): Promise<FleetHealthCheckWithCamel> {
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
        now
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

  async getLatestHealthCheck(endpointId: string): Promise<FleetHealthCheckWithCamel | null> {
    const row = this.db
      .prepare("SELECT * FROM fleet_health_checks WHERE endpoint_id = ? ORDER BY checked_at DESC LIMIT 1")
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
      .run(id, input.nodeId || null, input.endpointId || null, input.eventType, input.level, payloadStr, now);

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

  async listEvents(filter?: { nodeId?: string; endpointId?: string; limit?: number }): Promise<FleetEventRecord[]> {
    let sql = "SELECT * FROM fleet_events";
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (filter?.nodeId) {
      conditions.push("node_id = ?");
      params.push(filter.nodeId);
    }
    if (filter?.endpointId) {
      conditions.push("endpoint_id = ?");
      params.push(filter.endpointId);
    }
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    sql += ` ORDER BY created_at DESC LIMIT ${Math.min(500, filter?.limit || 100)}`;

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      node_id: string | null;
      endpoint_id: string | null;
      event_type: string;
      level: "info" | "warn" | "error";
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
      .run(input.tokenHash, input.nodeName, input.assignedIp || null, input.expiresAt, now);
  }

  async consumeEnrollmentToken(tokenHash: string): Promise<{ nodeName: string; assignedIp: string | null } | null> {
    const now = Date.now();
    const row = this.db
      .prepare("SELECT node_name, assigned_ip, expires_at, consumed_at FROM fleet_enrollment_tokens WHERE token_hash = ?")
      .get(tokenHash) as { node_name: string; assigned_ip: string | null; expires_at: number; consumed_at: number | null } | undefined;

    if (!row || row.consumed_at !== null || row.expires_at < now) {
      return null;
    }

    this.db.prepare("UPDATE fleet_enrollment_tokens SET consumed_at = ? WHERE token_hash = ?").run(now, tokenHash);
    return { nodeName: row.node_name, assignedIp: row.assigned_ip };
  }

  async getNextWireguardIp(): Promise<string> {
    const rows = this.db.prepare("SELECT wireguard_ip FROM fleet_nodes").all() as Array<{ wireguard_ip: string }>;
    const usedLastOctets = new Set<number>();
    for (const r of rows) {
      const parts = r.wireguard_ip.split(".");
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
    throw new Error("No available WireGuard IP in subnet 10.77.0.0/24");
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }
}

export function createFleetRepository(options: { sqlitePath?: string } = {}): FleetRepository {
  const sqlitePath = options.sqlitePath || path.join(process.cwd(), "data", "fleet.sqlite3");
  return new SqliteFleetRepository(sqlitePath);
}
