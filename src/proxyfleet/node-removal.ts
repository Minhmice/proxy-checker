import type { FleetRepository } from "./db.js";
import type { FleetRemovalRecord, NodeRemovalService } from "./types.js";

export interface NodeRemovalServiceDeps {
  repo: FleetRepository;
  removeOwnedPeer: (record: FleetRemovalRecord) => Promise<void>;
  unlinkManagedEndpoints: (nodeId: string) => Promise<void>;
}

export function createNodeRemovalService(deps: NodeRemovalServiceDeps): NodeRemovalService {
  const inFlight = new Map<string, Promise<FleetRemovalRecord>>();

  async function executeRemoval(nodeId: string): Promise<FleetRemovalRecord> {
    const existing = await deps.repo.getNodeRemoval(nodeId);
    if (existing && existing.status === "completed") {
      return existing;
    }

    let record: FleetRemovalRecord;
    if (existing && existing.status === "pending") {
      record = existing;
    } else {
      record = await deps.repo.requestNodeRemoval(nodeId);
    }

    try {
      await deps.removeOwnedPeer(record);
      await deps.unlinkManagedEndpoints(nodeId);
      return await deps.repo.completeNodeRemoval(nodeId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await deps.repo.recordNodeRemovalError(nodeId, message);
      const pendingRecord = await deps.repo.getNodeRemoval(nodeId);
      return pendingRecord || record;
    }
  }

  return {
    async remove(nodeId: string): Promise<FleetRemovalRecord> {
      const active = inFlight.get(nodeId);
      if (active) {
        return active;
      }

      const promise = executeRemoval(nodeId).finally(() => {
        inFlight.delete(nodeId);
      });

      inFlight.set(nodeId, promise);
      return promise;
    },

    async retryPending(): Promise<void> {
      const pendingList = await deps.repo.listPendingNodeRemovals();
      for (const pending of pendingList) {
        try {
          await this.remove(pending.nodeId);
        } catch {
          // Errors are recorded durably on the pending removal record
        }
      }
    },

    async retryNode(nodeId: string): Promise<FleetRemovalRecord> {
      return this.remove(nodeId);
    },
  };
}
