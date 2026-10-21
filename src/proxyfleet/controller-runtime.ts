import os from "node:os";
import crypto from "node:crypto";
import net from "node:net";
import type { FleetDeviceInfo, FleetRuntimeSnapshot, FleetOverlayObservation } from "./runtime.js";

export function createControllerRuntimeObserver() {
  const sessionId = crypto.randomUUID();
  let sequence = 0;
  let previous: { total: number; idle: number } | null = null;
  const startedAt = Date.now();
  const cpus = os.cpus();
  const device: FleetDeviceInfo = {
    schemaVersion: 1, hostname: os.hostname(), osFamily: os.platform(), osVersion: os.version(),
    kernel: os.release(), osArch: os.machine(), agentArch: process.arch,
    model: null, vendor: null, cpuModel: cpus[0]?.model ?? null,
    logicalCpus: cpus.length || null, memoryTotalBytes: os.totalmem(), virtualization: null,
    sources: { cpuModel: "node:os.cpus", osArch: "node:os.machine", memoryTotalBytes: "node:os.totalmem" },
  };
  return {
    sessionId,
    device,
    async sample(endpoints: Array<{ listen_ip: string; listen_port: number }>, overlay: FleetOverlayObservation): Promise<FleetRuntimeSnapshot> {
      let total = 0, idle = 0;
      for (const cpu of os.cpus()) {
        idle += cpu.times.idle;
        total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
      }
      const delta = previous ? total - previous.total : 0;
      const cpuPercent = previous && delta > 0 && idle >= previous.idle
        ? Math.max(0, Math.min(100, 100 * (delta - (idle - previous.idle)) / delta)) : null;
      previous = { total, idle };
      let listeningEndpoints = 0;
      // Bounded batches avoid opening one socket per endpoint simultaneously.
      for (let offset = 0; offset < endpoints.length; offset += 16) {
        const results = await Promise.all(endpoints.slice(offset, offset + 16).map(endpoint => new Promise<boolean>(resolve => {
          const socket = net.createConnection({ host: endpoint.listen_ip, port: endpoint.listen_port });
          let settled = false;
          const finish = (ok: boolean) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(ok);
          };
          socket.setTimeout(1000, () => finish(false));
          socket.once("connect", () => finish(true));
          socket.once("error", () => finish(false));
        })));
        listeningEndpoints += results.filter(Boolean).length;
      }
      const now = Date.now();
      return {
        schemaVersion: 1, sessionId, sequence: ++sequence, sampledAt: now,
        uptimeSeconds: os.uptime(), cpuPercent,
        loadAverage1m: process.platform === "win32" ? null : os.loadavg()[0],
        memoryAvailableBytes: os.freemem(), memoryTotalBytes: os.totalmem(),
        activity: { kind: "idle", startedAt, revision: null, error: null },
        network: { interfaceName: null, scope: "unknown", rxBytes: null, txBytes: null, rxBytesPerSecond: null, txBytesPerSecond: null },
        proxy: { state: "unknown", enabledEndpoints: endpoints.length, listeningEndpoints, activeConnections: null, checkedAt: now, error: endpoints.length > listeningEndpoints ? "Some managed controller listeners are unreachable" : null },
        overlay,
        unavailable: { model: "Controller hardware model requires native device agent", activeConnections: "Controller connection attribution requires native device agent", network: "Controller network counters require native device agent" },
      };
    },
  };
}
