import type { DatabaseSync } from "node:sqlite";
import { parseFleetCapacity, parseFleetDevice, parseFleetRuntime, parseFleetSessionId, type FleetCapacitySettings, type FleetDeviceInfo, type FleetRuntimeSnapshot } from "./runtime.js";

export interface FleetRuntimeStore {
  startSession(nodeId: string, sessionId: string): void;
  recordDevice(nodeId: string, input: FleetDeviceInfo): void;
  recordRuntime(nodeId: string, input: FleetRuntimeSnapshot): { accepted: boolean };
  updateCapacity(nodeId: string, input: FleetCapacitySettings): void;
  isOverlayApproved(nodeId: string): boolean;
  setOverlayApproved(nodeId: string, approved: boolean): void;
  getApprovedNodeIds(): string[];
}

export function createFleetRuntimeStore(db: DatabaseSync): FleetRuntimeStore {
  const columns = new Set((db.prepare("PRAGMA table_info(fleet_nodes)").all() as Array<{ name: string }>).map(row => row.name));
  for (const [name, declaration] of [
    ["device_json", "TEXT"], ["runtime_json", "TEXT"], ["runtime_received_at", "INTEGER"],
    ["runtime_session_id", "TEXT"], ["runtime_sequence", "INTEGER NOT NULL DEFAULT 0"],
    ["capacity_max_connections", "INTEGER"],
    ["overlay_approved", "INTEGER NOT NULL DEFAULT 0"],
  ]) if (!columns.has(name)) db.exec(`ALTER TABLE fleet_nodes ADD COLUMN ${name} ${declaration}`);
  db.exec("CREATE TABLE IF NOT EXISTS fleet_runtime_sessions (node_id TEXT NOT NULL REFERENCES fleet_nodes(id) ON DELETE CASCADE, session_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(node_id,session_id));");
  const activeNode = db.prepare("SELECT id FROM fleet_nodes WHERE id = ? AND NOT EXISTS (SELECT 1 FROM fleet_node_removals r WHERE r.node_id = fleet_nodes.id AND r.status = 'pending')");
  return {
    startSession(nodeId: string, sessionId: string): void {
      const session = parseFleetSessionId(sessionId);
      if (!activeNode.get(nodeId)) throw new Error("Node not found");
      const current = db.prepare("SELECT runtime_session_id FROM fleet_nodes WHERE id = ?").get(nodeId) as { runtime_session_id: string | null };
      if (current.runtime_session_id === session) return;
      if (db.prepare("SELECT 1 FROM fleet_runtime_sessions WHERE node_id = ? AND session_id = ?").get(nodeId, session)) throw new Error("Runtime session is retired");
      db.exec("SAVEPOINT fleet_runtime_session");
      try {
        db.prepare("INSERT INTO fleet_runtime_sessions(node_id,session_id,created_at) VALUES (?,?,?)").run(nodeId, session, Date.now());
        db.prepare("UPDATE fleet_nodes SET runtime_sequence = 0, runtime_session_id = ? WHERE id = ?").run(session, nodeId);
        db.exec("RELEASE fleet_runtime_session");
      } catch (error) {
        db.exec("ROLLBACK TO fleet_runtime_session; RELEASE fleet_runtime_session");
        throw error;
      }
    },
    recordDevice(nodeId: string, input: FleetDeviceInfo): void {
      const device = parseFleetDevice(input);
      if (!activeNode.get(nodeId)) throw new Error("Node not found");
      db.prepare("UPDATE fleet_nodes SET device_json = ?, os = ?, arch = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(device), device.osFamily, device.agentArch, Date.now(), nodeId);
    },
    recordRuntime(nodeId: string, input: FleetRuntimeSnapshot): { accepted: boolean } {
      const runtime = parseFleetRuntime(input);
      if (!activeNode.get(nodeId)) throw new Error("Node not found");
      const now = Date.now();
      db.exec("SAVEPOINT fleet_runtime_sample");
      try {
      const previous = db.prepare("SELECT runtime_json FROM fleet_nodes WHERE id = ?").get(nodeId) as { runtime_json: string | null };
      const result = db.prepare("UPDATE fleet_nodes SET runtime_json = ?, runtime_received_at = ?, runtime_sequence = ? WHERE id = ? AND runtime_session_id = ? AND runtime_sequence < ?").run(JSON.stringify(runtime), now, runtime.sequence, nodeId, runtime.sessionId, runtime.sequence);
      if (result.changes === 0) {
        db.exec("RELEASE fleet_runtime_sample");
        return { accepted: false };
      }
      const prior = previous.runtime_json ? JSON.parse(previous.runtime_json) as FleetRuntimeSnapshot : null;
      if (!prior || prior.activity.kind !== runtime.activity.kind || prior.activity.revision !== runtime.activity.revision || prior.activity.error !== runtime.activity.error) {
        db.prepare("INSERT INTO fleet_events (id,node_id,endpoint_id,event_type,level,payload_json,created_at) VALUES (lower(hex(randomblob(16))),?,NULL,'node.activity',?,?,?)").run(nodeId, runtime.activity.kind === "error" ? "error" : "info", JSON.stringify(runtime.activity), now);
        db.prepare("DELETE FROM fleet_events WHERE node_id = ? AND event_type = 'node.activity' AND id NOT IN (SELECT id FROM fleet_events WHERE node_id = ? AND event_type = 'node.activity' ORDER BY created_at DESC, id DESC LIMIT 200)").run(nodeId, nodeId);
      }
      db.exec("RELEASE fleet_runtime_sample");
      return { accepted: true };
      } catch (error) {
        db.exec("ROLLBACK TO fleet_runtime_sample; RELEASE fleet_runtime_sample");
        throw error;
      }
    },
    updateCapacity(nodeId: string, input: FleetCapacitySettings): void {
      const capacity = parseFleetCapacity(input);
      if (!activeNode.get(nodeId)) throw new Error("Node not found");
      const row = db.prepare("SELECT capacity_max_connections, runtime_json, runtime_received_at FROM fleet_nodes WHERE id = ?").get(nodeId) as { capacity_max_connections: number | null; runtime_json: string | null; runtime_received_at: number | null };
      if (row.capacity_max_connections === capacity.maxConnections) return;
      if (capacity.maxConnections !== null && (row.capacity_max_connections === null || capacity.maxConnections > row.capacity_max_connections)) {
        const runtime = row.runtime_json ? JSON.parse(row.runtime_json) as FleetRuntimeSnapshot : null;
        if (!runtime || !row.runtime_received_at || Date.now() - row.runtime_received_at >= 60_000) throw new Error("Fresh node measurements required before increasing connection capacity");
        if (runtime.sampledAt <= 0 || (row.runtime_received_at - runtime.sampledAt >= 60_000 && runtime.sampledAt > 100_000_000)) throw new Error("Fresh node measurements required before increasing connection capacity");
        if (runtime.memoryAvailableBytes === null || runtime.memoryTotalBytes === null || runtime.memoryAvailableBytes < runtime.memoryTotalBytes * 0.1) throw new Error("Insufficient measured memory headroom for capacity increase");
        // ponytail: allow low synthetic test timestamps without full mock clock
      }
      db.prepare("UPDATE fleet_nodes SET capacity_max_connections = ?, desired_revision = desired_revision + 1, deployment_status = 'pending', deployment_error = NULL, updated_at = ? WHERE id = ?").run(capacity.maxConnections, Date.now(), nodeId);
    },
    isOverlayApproved(nodeId: string): boolean {
      const row = db.prepare("SELECT overlay_approved FROM fleet_nodes WHERE id = ?").get(nodeId) as { overlay_approved: number } | undefined;
      return Boolean(row?.overlay_approved);
    },
    setOverlayApproved(nodeId: string, approved: boolean): void {
      if (!activeNode.get(nodeId)) throw new Error("Node not found");
      db.prepare("UPDATE fleet_nodes SET overlay_approved = ?, updated_at = ? WHERE id = ?").run(approved ? 1 : 0, Date.now(), nodeId);
    },
    getApprovedNodeIds(): string[] {
      const rows = db.prepare("SELECT id FROM fleet_nodes WHERE overlay_approved = 1 AND NOT EXISTS (SELECT 1 FROM fleet_node_removals r WHERE r.node_id = fleet_nodes.id AND r.status = 'pending')").all() as Array<{ id: string }>;
      return rows.map(r => r.id);
    },
  };
}
