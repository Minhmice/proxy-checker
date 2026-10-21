export interface FleetDeviceInfo {
  schemaVersion: 1;
  hostname: string;
  osFamily: string;
  osVersion: string | null;
  kernel: string | null;
  osArch: string | null;
  agentArch: string;
  model: string | null;
  vendor: string | null;
  cpuModel: string | null;
  logicalCpus: number | null;
  memoryTotalBytes: number | null;
  virtualization: string | null;
  sources: Record<string, string>;
}

export interface FleetOverlayObservation {
  state: "healthy" | "unhealthy" | "unknown";
  interfacePresent: boolean | null;
  peerPresent: boolean | null;
  lastHandshakeAt: number | null;
  probeOk: boolean | null;
  rxBytes: number | null;
  txBytes: number | null;
  error: string | null;
  lastRecoveryAt: number | null;
}

export interface FleetRuntimeSnapshot {
  schemaVersion: 1;
  sessionId: string;
  sequence: number;
  sampledAt: number;
  uptimeSeconds: number | null;
  activity: {
    kind: "idle" | "applying" | "checking" | "recovering" | "error";
    startedAt: number;
    revision: number | null;
    error: string | null;
  };
  cpuPercent: number | null;
  loadAverage1m: number | null;
  memoryAvailableBytes: number | null;
  memoryTotalBytes: number | null;
  network: {
    interfaceName: string | null;
    scope: "overlay" | "egress" | "unknown";
    rxBytes: number | null;
    txBytes: number | null;
    rxBytesPerSecond: number | null;
    txBytesPerSecond: number | null;
  };
  proxy: {
    state: "running" | "stopped" | "unknown";
    enabledEndpoints: number;
    listeningEndpoints: number | null;
    activeConnections: number | null;
    checkedAt: number | null;
    error: string | null;
  };
  overlay: FleetOverlayObservation;
  unavailable: Record<string, string>;
}

export interface FleetCapacitySettings { maxConnections: number | null }

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${name}`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max = 256): string {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
function nullableText(value: unknown, name: string, max = 256): string | null {
  return value == null ? null : text(value, name, max);
}
function number(value: unknown, name: string, max = Number.MAX_SAFE_INTEGER, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isSafeInteger(value))) throw new Error(`Invalid ${name}`);
  return value;
}
function nullableNumber(value: unknown, name: string, max = Number.MAX_SAFE_INTEGER, integer = false): number | null {
  return value == null ? null : number(value, name, max, integer);
}
function nullableBoolean(value: unknown, name: string): boolean | null {
  if (value == null) return null;
  if (typeof value !== "boolean") throw new Error(`Invalid ${name}`);
  return value;
}
function choice<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`Invalid ${name}`);
  return value as T;
}
function messages(value: unknown, name: string): Record<string, string> {
  const entries = Object.entries(object(value ?? {}, name));
  if (entries.length > 32) throw new Error(`Too many ${name}`);
  return Object.fromEntries(entries.map(([key, val]) => [text(key, name, 64), text(val, name)]));
}
function boundedPayload(value: unknown, name: string): Record<string, unknown> {
  const result = object(value, name);
  if (Buffer.byteLength(JSON.stringify(result)) > 32_768) throw new Error(`${name} exceeds 32 KiB`);
  if (result.schemaVersion !== 1) throw new Error(`Unsupported ${name} schemaVersion`);
  return result;
}
export function parseFleetSessionId(value: unknown): string {
  const result = text(value, "runtime session", 128);
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(result)) throw new Error("Invalid runtime session");
  return result;
}
export function parseFleetDevice(value: unknown): FleetDeviceInfo {
  const d = boundedPayload(value, "device");
  return {
    schemaVersion: 1, hostname: text(d.hostname, "hostname"), osFamily: text(d.osFamily, "osFamily"),
    osVersion: nullableText(d.osVersion, "osVersion"), kernel: nullableText(d.kernel, "kernel"),
    osArch: nullableText(d.osArch, "osArch"), agentArch: text(d.agentArch, "agentArch"),
    model: nullableText(d.model, "model"), vendor: nullableText(d.vendor, "vendor"), cpuModel: nullableText(d.cpuModel, "cpuModel"),
    logicalCpus: nullableNumber(d.logicalCpus, "logicalCpus", 65_536, true),
    memoryTotalBytes: nullableNumber(d.memoryTotalBytes, "memoryTotalBytes", Number.MAX_SAFE_INTEGER, true),
    virtualization: nullableText(d.virtualization, "virtualization"), sources: messages(d.sources, "sources"),
  };
}
export function parseFleetOverlay(value: unknown): FleetOverlayObservation {
  const o = object(value, "overlay");
  return {
    state: choice(o.state, ["healthy", "unhealthy", "unknown"], "overlay state"),
    interfacePresent: nullableBoolean(o.interfacePresent, "interfacePresent"), peerPresent: nullableBoolean(o.peerPresent, "peerPresent"),
    lastHandshakeAt: nullableNumber(o.lastHandshakeAt, "lastHandshakeAt"), probeOk: nullableBoolean(o.probeOk, "probeOk"),
    rxBytes: nullableNumber(o.rxBytes, "overlay rxBytes", Number.MAX_SAFE_INTEGER, true), txBytes: nullableNumber(o.txBytes, "overlay txBytes", Number.MAX_SAFE_INTEGER, true),
    error: nullableText(o.error, "overlay error", 2048), lastRecoveryAt: nullableNumber(o.lastRecoveryAt, "lastRecoveryAt"),
  };
}
export function parseFleetRuntime(value: unknown): FleetRuntimeSnapshot {
  const r = boundedPayload(value, "runtime");
  const a = object(r.activity, "activity"), n = object(r.network, "network"), p = object(r.proxy, "proxy");
  const sequence = number(r.sequence, "sequence", Number.MAX_SAFE_INTEGER, true);
  if (!sequence) throw new Error("Invalid sequence");
  const available = nullableNumber(r.memoryAvailableBytes, "memoryAvailableBytes", Number.MAX_SAFE_INTEGER, true);
  const total = nullableNumber(r.memoryTotalBytes, "memoryTotalBytes", Number.MAX_SAFE_INTEGER, true);
  if (available !== null && total !== null && available > total) throw new Error("Available memory exceeds total memory");
  const enabled = number(p.enabledEndpoints, "enabledEndpoints", 65_535, true);
  const listening = nullableNumber(p.listeningEndpoints, "listeningEndpoints", 65_535, true);
  if (listening !== null && listening > enabled) throw new Error("Listening endpoints exceed enabled endpoints");
  const sampled = number(r.sampledAt, "sampledAt", Number.MAX_SAFE_INTEGER, true);
  if (sampled <= 0) throw new Error("Invalid sampledAt: must be positive");
  if (sampled > Date.now() + 300_000) throw new Error("Sample timestamp is in the future");
  return {
    schemaVersion: 1, sessionId: parseFleetSessionId(r.sessionId), sequence, sampledAt: sampled,
    uptimeSeconds: nullableNumber(r.uptimeSeconds, "uptimeSeconds"), cpuPercent: nullableNumber(r.cpuPercent, "cpuPercent", 100),
    loadAverage1m: nullableNumber(r.loadAverage1m, "loadAverage1m"), memoryAvailableBytes: available, memoryTotalBytes: total,
    activity: { kind: choice(a.kind, ["idle", "applying", "checking", "recovering", "error"], "activity kind"), startedAt: number(a.startedAt, "startedAt"), revision: nullableNumber(a.revision, "activity revision", Number.MAX_SAFE_INTEGER, true), error: nullableText(a.error, "activity error", 2048) },
    network: { interfaceName: nullableText(n.interfaceName, "interfaceName"), scope: choice(n.scope, ["overlay", "egress", "unknown"], "network scope"), rxBytes: nullableNumber(n.rxBytes, "rxBytes", Number.MAX_SAFE_INTEGER, true), txBytes: nullableNumber(n.txBytes, "txBytes", Number.MAX_SAFE_INTEGER, true), rxBytesPerSecond: nullableNumber(n.rxBytesPerSecond, "rxBytesPerSecond"), txBytesPerSecond: nullableNumber(n.txBytesPerSecond, "txBytesPerSecond") },
    proxy: { state: choice(p.state, ["running", "stopped", "unknown"], "proxy state"), enabledEndpoints: enabled, listeningEndpoints: listening, activeConnections: nullableNumber(p.activeConnections, "activeConnections", Number.MAX_SAFE_INTEGER, true), checkedAt: nullableNumber(p.checkedAt, "checkedAt"), error: nullableText(p.error, "proxy error", 2048) },
    overlay: parseFleetOverlay(r.overlay), unavailable: messages(r.unavailable, "unavailable"),
  };
}
export function parseFleetCapacity(value: unknown): FleetCapacitySettings {
  const c = object(value, "capacity");
  if (c.maxConnections === null) return { maxConnections: null };
  const maxConnections = number(c.maxConnections, "maxConnections", 1_000_000, true);
  if (!maxConnections) throw new Error("maxConnections must be positive or null");
  return { maxConnections };
}
