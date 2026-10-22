import { desc } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';

export const fleetNodes = sqliteTable('fleet_nodes', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  role: text('role').notNull().default('worker'),
  status: text('status').notNull().default('offline'),
  publicIp: text('public_ip'),
  wireguardIp: text('wireguard_ip').notNull().unique(),
  wireguardPublicKey: text('wireguard_public_key'),
  os: text('os'),
  arch: text('arch'),
  agentVersion: text('agent_version'),
  lastHeartbeatAt: integer('last_heartbeat_at'),
  desiredRevision: integer('desired_revision').notNull().default(1),
  agentTokenHash: text('agent_token_hash'),
  appliedRevision: integer('applied_revision'),
  deploymentRevision: integer('deployment_revision'),
  deploymentStatus: text('deployment_status').notNull().default('unknown'),
  deploymentError: text('deployment_error'),
  deploymentUpdatedAt: integer('deployment_updated_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  tailscaleIp: text('tailscale_ip'),
  expectedPublicIp: text('expected_public_ip'),
  publicIpStatus: text('public_ip_status').notNull().default('unknown'),
  publicIpCheckedAt: integer('public_ip_checked_at'),
  proxyActivation: text('proxy_activation').notNull().default('disabled'),
  proxyActivationReason: text('proxy_activation_reason'),
  provisionStatus: text('provision_status').notNull().default('pending'),
  provisionError: text('provision_error'),
  deviceJson: text('device_json'),
  runtimeJson: text('runtime_json'),
  runtimeReceivedAt: integer('runtime_received_at'),
  runtimeSessionId: text('runtime_session_id'),
  runtimeSequence: integer('runtime_sequence').notNull().default(0),
  capacityMaxConnections: integer('capacity_max_connections'),
  overlayApproved: integer('overlay_approved').notNull().default(0),
});
export const fleetNodeInterfaces = sqliteTable('fleet_node_interfaces', {
  id: text('id').primaryKey(),
  nodeId: text('node_id')
    .notNull()
    .references(() => fleetNodes.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  macAddress: text('mac_address'),
  ipv4Address: text('ipv4_address'),
  ipv6Address: text('ipv6_address'),
  isDefault: integer('is_default').notNull().default(0),
  status: text('status').notNull(),
  createdAt: integer('created_at').notNull(),
});
export const fleetEgresses = sqliteTable('fleet_egresses', {
  id: text('id').primaryKey(),
  nodeId: text('node_id')
    .notNull()
    .references(() => fleetNodes.id, { onDelete: 'cascade' }),
  interfaceId: text('interface_id').references(() => fleetNodeInterfaces.id, {
    onDelete: 'set null',
  }),
  name: text('name').notNull(),
  sourceIp: text('source_ip'),
  gatewayIp: text('gateway_ip'),
  routingTableId: integer('routing_table_id'),
  expectedPublicIp: text('expected_public_ip'),
  createdAt: integer('created_at').notNull(),
});
export const fleetProxyEndpoints = sqliteTable(
  'fleet_proxy_endpoints',
  {
    id: text('id').primaryKey(),
    nodeId: text('node_id')
      .notNull()
      .references(() => fleetNodes.id, { onDelete: 'cascade' }),
    protocol: text('protocol').notNull(),
    listenIp: text('listen_ip').notNull(),
    listenPort: integer('listen_port').notNull(),
    egressId: text('egress_id').references(() => fleetEgresses.id, {
      onDelete: 'set null',
    }),
    username: text('username').notNull(),
    credentialRef: text('credential_ref').notNull(),
    enabled: integer('enabled').notNull().default(1),
    currentRevision: integer('current_revision').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    unique().on(t.nodeId, t.listenIp, t.listenPort),
    index('idx_fleet_endpoints_node').on(t.nodeId),
  ],
);
export const fleetProxyCredentials = sqliteTable('fleet_proxy_credentials', {
  id: text('id').primaryKey(),
  endpointId: text('endpoint_id')
    .notNull()
    .references(() => fleetProxyEndpoints.id, { onDelete: 'cascade' }),
  username: text('username').notNull(),
  encryptedPassword: text('encrypted_password').notNull(),
  salt: text('salt').notNull(),
  iv: text('iv').notNull(),
  tag: text('tag').notNull(),
  rotatedAt: integer('rotated_at').notNull(),
});
export const fleetHealthChecks = sqliteTable(
  'fleet_health_checks',
  {
    id: text('id').primaryKey(),
    endpointId: text('endpoint_id')
      .notNull()
      .references(() => fleetProxyEndpoints.id, { onDelete: 'cascade' }),
    nodeId: text('node_id')
      .notNull()
      .references(() => fleetNodes.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    exitIp: text('exit_ip'),
    latencyMs: real('latency_ms'),
    errorMessage: text('error_message'),
    checkedAt: integer('checked_at').notNull(),
  },
  (t) => [
    index('idx_fleet_health_endpoint').on(t.endpointId, desc(t.checkedAt)),
  ],
);
export const fleetDeployments = sqliteTable(
  'fleet_deployments',
  {
    id: text('id').primaryKey(),
    nodeId: text('node_id')
      .notNull()
      .references(() => fleetNodes.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    configDigest: text('config_digest').notNull(),
    status: text('status').notNull(),
    errorMessage: text('error_message'),
    appliedAt: integer('applied_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_fleet_deployments_node').on(t.nodeId, desc(t.revision))],
);
export const fleetEnrollmentTokens = sqliteTable('fleet_enrollment_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  nodeName: text('node_name').notNull(),
  assignedIp: text('assigned_ip'),
  expiresAt: integer('expires_at').notNull(),
  consumedAt: integer('consumed_at'),
  createdAt: integer('created_at').notNull(),
});
export const fleetEvents = sqliteTable(
  'fleet_events',
  {
    id: text('id').primaryKey(),
    nodeId: text('node_id'),
    endpointId: text('endpoint_id'),
    eventType: text('event_type').notNull(),
    level: text('level').notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_fleet_events_created').on(desc(t.createdAt))],
);
export const fleetNodeRemovals = sqliteTable(
  'fleet_node_removals',
  {
    nodeId: text('node_id').primaryKey(),
    nodeName: text('node_name').notNull(),
    wireguardIp: text('wireguard_ip').notNull(),
    wireguardPublicKey: text('wireguard_public_key'),
    status: text('status').notNull(),
    errorMessage: text('error_message'),
    requestedAt: integer('requested_at').notNull(),
    completedAt: integer('completed_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_fleet_removals_status').on(t.status)],
);
export const fleetNodeSsh = sqliteTable('fleet_node_ssh', {
  nodeId: text('node_id')
    .primaryKey()
    .references(() => fleetNodes.id, { onDelete: 'cascade' }),
  username: text('username').notNull(),
  encryptedPassword: text('encrypted_password').notNull(),
  salt: text('salt').notNull(),
  iv: text('iv').notNull(),
  tag: text('tag').notNull(),
  port: integer('port').notNull().default(22),
  hostKeyFingerprint: text('host_key_fingerprint').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
export const fleetRuntimeSessions = sqliteTable(
  'fleet_runtime_sessions',
  {
    nodeId: text('node_id')
      .notNull()
      .references(() => fleetNodes.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.nodeId, t.sessionId] })],
);
