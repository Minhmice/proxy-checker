import type { FleetDeviceInfo, FleetRuntimeSnapshot, FleetCapacitySettings } from "./runtime.js";
export type FleetNodeRole = "controller-worker" | "worker";

export type FleetNodeStatus = "online" | "offline" | "degraded";

export type FleetConfigurationStatus = "pending" | "applied" | "failed" | "unknown";

export interface FleetNodeConfigurationView {
  status: FleetConfigurationStatus;
  desiredRevision: number;
  appliedRevision: number | null;
  deploymentRevision: number | null;
  error: string | null;
  updatedAt: number | null;
}

export interface FleetNodeRecord {
  id: string;
  name: string;
  role: FleetNodeRole;
  status: FleetNodeStatus;
  public_ip: string | null;
  wireguard_ip: string;
  wireguard_public_key: string | null;
  os: string | null;
  arch: string | null;
  agent_version: string | null;
  last_heartbeat_at: number | null;
  desired_revision: number;
  applied_revision?: number | null;
  deployment_revision?: number | null;
  deployment_status?: FleetConfigurationStatus;
  deployment_error?: string | null;
  deployment_updated_at?: number | null;
  configuration?: FleetNodeConfigurationView;
  device?: FleetDeviceInfo | null;
  runtime?: FleetRuntimeSnapshot | null;
  runtimeReceivedAt?: number | null;
  capacity?: FleetCapacitySettings;
  created_at: number;
  updated_at: number;
}

export interface FleetNodeInterfaceRecord {
  id: string;
  node_id: string;
  name: string;
  mac_address: string | null;
  ipv4_address: string | null;
  ipv6_address: string | null;
  is_default: boolean;
  status: string;
  created_at: number;
}

export interface FleetEgressRecord {
  id: string;
  node_id: string;
  interface_id: string | null;
  name: string;
  source_ip: string | null;
  gateway_ip: string | null;
  routing_table_id: number | null;
  expected_public_ip: string | null;
  created_at: number;
}

export type FleetProxyProtocol = "http" | "socks5";

export interface FleetProxyEndpointRecord {
  id: string;
  node_id: string;
  protocol: FleetProxyProtocol;
  listen_ip: string;
  listen_port: number;
  egress_id: string | null;
  username: string;
  credential_ref: string;
  enabled: boolean;
  current_revision: number;
  health?: FleetHealthCheckRecord | null;
  created_at: number;
  updated_at: number;
}
export interface FleetNodeDesiredState {
  revision: number;
  capacity?: FleetCapacitySettings;
  proxies: Array<{
    id: string;
    node_id: string;
    protocol: FleetProxyProtocol;
    listen_ip: string;
    listen_port: number;
    username: string;
    password: string;
    enabled: boolean;
    current_revision: number;
  }>;
}


export interface FleetProxyCredentialRecord {
  id: string;
  endpoint_id: string;
  username: string;
  encrypted_password: string;
  salt: string;
  rotated_at: number;
}

export type FleetHealthStatus =
  | "healthy"
  | "degraded"
  | "offline"
  | "route_leak"
  | "auth_error"
  | "timeout"
  | "configuration_error";

export interface FleetHealthCheckRecord {
  id: string;
  endpoint_id: string;
  node_id: string;
  status: FleetHealthStatus;
  exit_ip: string | null;
  latency_ms: number | null;
  error_message: string | null;
  checked_at: number;
}

export type FleetDeploymentStatus = "pending" | "applied" | "failed" | "rolled_back";

export interface FleetDeploymentRecord {
  id: string;
  node_id: string;
  revision: number;
  config_digest: string;
  status: FleetDeploymentStatus;
  error_message: string | null;
  applied_at: number | null;
  created_at: number;
}

export interface FleetEnrollmentTokenRecord {
  token_hash: string;
  node_name: string;
  assigned_ip: string | null;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
}
export type FleetRemovalStatus = "pending" | "completed";

export interface FleetRemovalRecord {
  nodeId: string;
  nodeName: string;
  wireguardIp: string;
  publicKey: string | null;
  status: FleetRemovalStatus;
  lastError: string | null;
  requestedAt: number;
  completedAt: number | null;
}

export interface NodeRemovalService {
  remove(nodeId: string): Promise<FleetRemovalRecord>;
  retryPending(): Promise<void>;
  retryNode?(nodeId: string): Promise<FleetRemovalRecord>;
}

export interface FleetEventRecord {
  id: string;
  node_id: string | null;
  endpoint_id: string | null;
  event_type: string;
  eventType?: string;
  level: "info" | "warn" | "error";
  payload: Record<string, unknown>;
  created_at: number;
  createdAt?: number;
}

export interface RecordDeploymentResultInput {
  nodeId: string;
  revision: number;
  configDigest: string;
  status: "applied" | "failed";
  errorMessage?: string;
}

export interface RecordDeploymentResultOutcome {
  ok: boolean;
  accepted: boolean;
  reason?: "stale_revision" | "duplicate_revision" | "future_revision" | "node_not_found" | string;
  node?: FleetNodeWithCamel;
}

export type FleetNodeWithCamel = FleetNodeRecord & {
  wireguardIp: string;
  publicIp: string | null;
  agentVersion: string | null;
  appliedRevision: number | null;
  deploymentRevision: number | null;
  deploymentStatus: FleetConfigurationStatus;
  deploymentError: string | null;
  deploymentUpdatedAt: number | null;
  configuration: FleetNodeConfigurationView;
};
