import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFile } from 'node:child_process';

export interface FleetWireGuardSettings {
  interfaceName: string;
  controllerAddressCidr: string;
  publicEndpoint: string;
  listenPort: number;
  mtu: number | null;
}

export interface OverlayObservation {
  state: 'healthy' | 'unhealthy' | 'unknown';
  interfacePresent: boolean | null;
  peerPresent: boolean | null;
  lastHandshakeAt: number | null;
  probeOk: boolean | null;
  rxBytes: number | null;
  txBytes: number | null;
  error: string | null;
  lastRecoveryAt: number | null;
}

export interface RemovalPeer {
  nodeId: string;
  nodeName: string;
  wireguardIp: string;
  publicKey: string | null;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type CommandExecutor = (
  file: string,
  args: string[],
  options?: { timeoutMs?: number; input?: string }
) => Promise<CommandResult>;

export interface ManagedPeerEntry {
  nodeId: string;
  publicKey: string;
  address: string;
}

export interface OwnershipMetadata {
  owner: 'proxyfleet-controller';
  interfaceName: string;
  controllerAddressCidr: string;
  listenPort: number;
  publicKey: string;
  createdAt: number;
  managedPeers: Record<string, ManagedPeerEntry>;
  recovery: {
    consecutiveFailures: number;
    lastRecoveryAt: number | null;
  };
}

export interface FleetWireGuardManagerOptions {
  configDir?: string;
  commandExecutor?: CommandExecutor;
}

export interface FleetWireGuardManager {
  preflight(): Promise<{ publicKey: string; observation: OverlayObservation }>;
  setup(): Promise<{ publicKey: string; observation: OverlayObservation }>;
  reconcilePeers(peers: Array<{ nodeId: string; publicKey: string; address: string }>): Promise<void>;
  removePeer(record: RemovalPeer): Promise<void>;
  observe(probeTargetIp?: string): Promise<OverlayObservation>;
  recover(probeTargetIp?: string): Promise<void>;
}

// ponytail: allocator fixed to 10.77.0.0/24 CIDR → skipped: arbitrary CIDR subnet math, add when dynamic subnet allocator ready.
export function validateFleetWireGuardSettings(input: unknown): FleetWireGuardSettings {
  if (!input || typeof input !== 'object') {
    throw new Error('WireGuard settings must be an object');
  }
  const raw = input as Record<string, unknown>;

  if (raw.interfaceName !== 'proxyfleet') {
    throw new Error(`interfaceName must be exactly 'proxyfleet' (got '${String(raw.interfaceName)}')`);
  }
  const interfaceName = raw.interfaceName;

  if (raw.controllerAddressCidr !== '10.77.0.1/24') {
    throw new Error(`controllerAddressCidr must be exactly '10.77.0.1/24' (got '${String(raw.controllerAddressCidr)}')`);
  }
  const cidr = raw.controllerAddressCidr;

  if (typeof raw.publicEndpoint !== 'string') {
    throw new Error('publicEndpoint must be a string');
  }
  const endpoint = raw.publicEndpoint.trim();
  let host = '';
  let portStr = '';

  if (endpoint.startsWith('[')) {
    const closeBracket = endpoint.indexOf(']:');
    if (closeBracket === -1) {
      throw new Error(`publicEndpoint IPv6 must be in '[ipv6]:port' format (got '${endpoint}')`);
    }
    host = endpoint.slice(1, closeBracket);
    portStr = endpoint.slice(closeBracket + 2);
    if (net.isIP(host) !== 6) {
      throw new Error(`publicEndpoint IPv6 address is invalid (got '${host}')`);
    }
  } else {
    const colonIdx = endpoint.lastIndexOf(':');
    if (colonIdx === -1) {
      throw new Error(`publicEndpoint must be in 'host:port' format (got '${endpoint}')`);
    }
    host = endpoint.slice(0, colonIdx);
    portStr = endpoint.slice(colonIdx + 1);
    if (net.isIP(host) === 6) {
      throw new Error(`IPv6 endpoint must be enclosed in brackets (got '${endpoint}')`);
    }
    if (net.isIP(host) !== 4) {
      if (!host || host.length > 253 || !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(host)) {
        throw new Error(`publicEndpoint host is invalid (got '${host}')`);
      }
    }
  }

  if (!/^[0-9]+$/.test(portStr)) {
    throw new Error(`publicEndpoint port must be an integer (got '${portStr}')`);
  }
  const epPort = parseInt(portStr, 10);
  if (epPort < 1 || epPort > 65535) {
    throw new Error(`publicEndpoint port must be between 1 and 65535 (got ${epPort})`);
  }

  if (typeof raw.listenPort !== 'number' || !Number.isInteger(raw.listenPort)) {
    throw new Error('listenPort must be an integer');
  }
  if (raw.listenPort < 1 || raw.listenPort > 65535) {
    throw new Error(`listenPort must be between 1 and 65535 (got ${raw.listenPort})`);
  }

  let mtu: number | null = null;
  if (raw.mtu !== null && raw.mtu !== undefined) {
    if (typeof raw.mtu !== 'number' || !Number.isInteger(raw.mtu)) {
      throw new Error('mtu must be an integer or null');
    }
    if (raw.mtu < 1280 || raw.mtu > 9000) {
      throw new Error(`mtu must be between 1280 and 9000 or null (got ${raw.mtu})`);
    }
    mtu = raw.mtu;
  }

  return {
    interfaceName,
    controllerAddressCidr: cidr,
    publicEndpoint: endpoint,
    listenPort: raw.listenPort,
    mtu,
  };
}

export function validateBase64Key(key: string, name = 'WireGuard key'): void {
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(key)) {
    throw new Error(`${name} must be canonical 44-character base64 for exactly 32 bytes`);
  }
  const buf = Buffer.from(key, 'base64');
  if (buf.length !== 32 || buf.toString('base64') !== key) {
    throw new Error(`${name} must decode to exactly 32 bytes`);
  }
}

export function validatePeerAddress(address: string, controllerAddressCidr: string): void {
  if (typeof address !== 'string') {
    throw new Error('Peer address must be a string');
  }
  const cleanAddr = address.endsWith('/32') ? address.slice(0, -3) : address;
  const match = /^10\.77\.0\.([0-9]{1,3})$/.exec(cleanAddr);
  if (!match) {
    throw new Error(`Peer address must be in 10.77.0.0/24 subnet (got '${address}')`);
  }
  const hostNum = parseInt(match[1], 10);
  if (hostNum < 1 || hostNum > 254) {
    throw new Error(`Peer address host byte must be between 1 and 254 (got ${hostNum})`);
  }
  const controllerHost = controllerAddressCidr.split('/')[0];
  if (cleanAddr === controllerHost) {
    throw new Error(`Peer address '${cleanAddr}' collides with controller address '${controllerHost}'`);
  }
}

export function scrubSecrets(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 16) {
      result = result.split(secret).join('[REDACTED]');
    }
  }
  return result;
}

export function generateWireGuardKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey } = crypto.generateKeyPairSync('x25519');
  const rawPriv = privateKey.export({ format: 'der', type: 'pkcs8' });
  const privBytes = rawPriv.subarray(rawPriv.length - 32);
  const privBase64 = privBytes.toString('base64');
  const pubBase64 = derivePublicKey(privBase64);
  return { privateKey: privBase64, publicKey: pubBase64 };
}

export function derivePublicKey(privBase64: string): string {
  validateBase64Key(privBase64, 'Private key');
  const privBytes = Buffer.from(privBase64, 'base64');
  const pkcs8Header = Buffer.from('302e020100300506032b656e04220420', 'hex');
  const pkcs8 = Buffer.concat([pkcs8Header, privBytes]);
  const privKey = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const pubKey = crypto.createPublicKey(privKey);
  const spki = pubKey.export({ format: 'der', type: 'spki' });
  return spki.subarray(spki.length - 32).toString('base64');
}

export interface DetectedBinaries {
  wgPath: string | null;
  wireguardPath: string | null;
  ipPath: string | null;
  pingPath: string | null;
}

export function detectBinaries(platform = process.platform): DetectedBinaries {
  const isWindows = platform === 'win32';
  let wgPath: string | null = null;
  let wireguardPath: string | null = null;
  let ipPath: string | null = null;
  let pingPath: string | null = null;

  if (isWindows) {
    const candidates = [
      'C:\\Program Files\\WireGuard\\wireguard.exe',
      'C:\\Program Files\\WireGuard\\wg.exe',
      'C:\\Program Files (x86)\\WireGuard\\wireguard.exe',
      'C:\\Program Files (x86)\\WireGuard\\wg.exe',
    ];
    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        if (cand.toLowerCase().endsWith('wireguard.exe') && !wireguardPath) {
          wireguardPath = cand;
        }
        if (cand.toLowerCase().endsWith('wg.exe') && !wgPath) {
          wgPath = cand;
        }
      }
    }
    // Also check PATH for wg.exe / wireguard.exe
    const envPath = process.env.PATH || '';
    for (const dir of envPath.split(path.delimiter)) {
      const wPath = path.join(dir, 'wireguard.exe');
      if (!wireguardPath && fs.existsSync(wPath)) wireguardPath = wPath;
      const wgP = path.join(dir, 'wg.exe');
      if (!wgPath && fs.existsSync(wgP)) wgPath = wgP;
    }
    pingPath = 'ping.exe';
  } else {
    // Linux/macOS
    const checkPaths = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin'];
    const envPath = process.env.PATH || '';
    const allDirs = Array.from(new Set([...envPath.split(path.delimiter), ...checkPaths]));

    for (const dir of allDirs) {
      const wgCandidate = path.join(dir, 'wg');
      if (!wgPath && fs.existsSync(wgCandidate)) wgPath = wgCandidate;
      const ipCandidate = path.join(dir, 'ip');
      if (!ipPath && fs.existsSync(ipCandidate)) ipPath = ipCandidate;
      const pingCandidate = path.join(dir, 'ping');
      if (!pingPath && fs.existsSync(pingCandidate)) pingPath = pingCandidate;
    }
  }

  return { wgPath, wireguardPath, ipPath, pingPath };
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const defaultCommandExecutor: CommandExecutor = (file, args, opts) => {
  const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
  const child = execFile(
    file,
    args,
    {
      timeout: opts?.timeoutMs ?? 10000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
    (error, stdout, stderr) => {
      if (error && 'code' in error && error.code === 'ENOENT') {
        reject(new Error(`Command '${file}' not found`));
        return;
      }
      const exitCode = error && 'code' in error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        code: exitCode,
      });
    }
  );
  if (opts?.input && child.stdin) {
    child.stdin.write(opts.input);
    child.stdin.end();
  }
  return promise;
};

function requireCommandSuccess(result: CommandResult, command: string, secrets: string[] = []): string {
  if (result.code !== 0) {
    const diagnostic = scrubSecrets(result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`, secrets).slice(0, 300);
    throw new Error(`${command} failed: ${diagnostic}`);
  }
  return result.stdout;
}

export interface ParsedDumpPeer {
  publicKey: string;
  presharedKey: string;
  endpoint: string;
  allowedIps: string[];
  latestHandshake: number;
  transferRx: number;
  transferTx: number;
  persistentKeepalive: string;
}

export interface ParsedDump {
  listenPort: number;
  peers: ParsedDumpPeer[];
}

export function parseWgShowDump(rawOutput: string): ParsedDump {
  const lines = rawOutput.trim().split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) {
    return { listenPort: 0, peers: [] };
  }

  // Line 0: interface: <private-key>\t<public-key>\t<listen-port>\t<fwmark>
  const ifaceFields = lines[0].split('\t');
  const listenPort = ifaceFields.length >= 3 ? parseInt(ifaceFields[2], 10) || 0 : 0;

  const peers: ParsedDumpPeer[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i].split('\t');
    if (fields.length < 8) continue;
    const allowedIps = fields[3].split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    peers.push({
      publicKey: fields[0],
      presharedKey: fields[1],
      endpoint: fields[2],
      allowedIps,
      latestHandshake: parseInt(fields[4], 10) || 0,
      transferRx: parseInt(fields[5], 10) || 0,
      transferTx: parseInt(fields[6], 10) || 0,
      persistentKeepalive: fields[7],
    });
  }

  return { listenPort, peers };
}

export function createFleetWireGuardManager(
  settingsInput: FleetWireGuardSettings,
  options?: FleetWireGuardManagerOptions
): FleetWireGuardManager {
  const settings = validateFleetWireGuardSettings(settingsInput);
  const isWindows = process.platform === 'win32';

  // Config dir resolution
  const resolvedConfigDir =
    options?.configDir ||
    (isWindows
      ? process.env.ProgramData
        ? path.join(process.env.ProgramData, 'WireGuard')
        : path.join(process.cwd(), 'data', 'wireguard')
      : fs.existsSync('/etc/wireguard')
        ? '/etc/wireguard'
        : path.join(process.cwd(), 'data', 'wireguard'));

  const ownerFilePath = path.join(resolvedConfigDir, `${settings.interfaceName}-owner.json`);
  const confFilePath = path.join(resolvedConfigDir, `${settings.interfaceName}.conf`);
  const keyFilePath = path.join(resolvedConfigDir, `${settings.interfaceName}.key`);

  const exec = options?.commandExecutor || defaultCommandExecutor;

  async function secureWindowsConfigDirectory(): Promise<string> {
    ensureConfigDir();
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const whoamiPath = path.join(systemRoot, 'System32', 'whoami.exe');
    const icaclsPath = path.join(systemRoot, 'System32', 'icacls.exe');
    const ownerResult = await exec(whoamiPath, ['/user', '/fo', 'csv', '/nh']);
    const ownerSid = requireCommandSuccess(ownerResult, 'Resolve current Windows owner SID').trim().split(',').at(-1)?.replaceAll('"', '').trim();
    if (!ownerSid || !/^S-1-\d+(?:-\d+)+$/.test(ownerSid)) throw new Error('Could not resolve current Windows owner SID for WireGuard ACL');
    const aclResult = await exec(icaclsPath, [resolvedConfigDir, '/inheritance:r', '/grant:r', `*${ownerSid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F']);
    requireCommandSuccess(aclResult, 'Secure Windows WireGuard config directory');
    return ownerSid;
  }

  function ensureConfigDir(): void {
    if (!fs.existsSync(resolvedConfigDir)) {
      fs.mkdirSync(resolvedConfigDir, { recursive: true, mode: 0o700 });
    }
    const stat = fs.lstatSync(resolvedConfigDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('WireGuard config directory must be a real directory, not a symlink');
    }
    if (!isWindows) {
      fs.chmodSync(resolvedConfigDir, 0o700);
      if ((fs.statSync(resolvedConfigDir).mode & 0o077) !== 0) {
        throw new Error('WireGuard config directory permissions must be 0700');
      }
    }
  }

  function readOwnership(): OwnershipMetadata | null {
    if (!fs.existsSync(ownerFilePath)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(ownerFilePath, 'utf8'));
      if (raw.owner !== 'proxyfleet-controller') {
        throw new Error(`Foreign interface ownership detected: ${ownerFilePath}`);
      }
      if (raw.interfaceName !== settings.interfaceName) {
        throw new Error(`Interface name mismatch in ${ownerFilePath}: expected ${settings.interfaceName}, got ${raw.interfaceName}`);
      }
      return raw as OwnershipMetadata;
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      if (msg.includes('Foreign interface')) throw err;
      return null;
    }
  }

  function writeOwnership(meta: OwnershipMetadata): void {
    ensureConfigDir();
    const tempFile = `${ownerFilePath}.${Date.now()}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(meta, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempFile, ownerFilePath);
  }

  function readExistingKey(): { privateKey: string; publicKey: string } | null {
    if (!fs.existsSync(keyFilePath)) return null;
    try {
      const priv = fs.readFileSync(keyFilePath, 'utf8').trim();
      validateBase64Key(priv, 'Persisted private key');
      const pub = derivePublicKey(priv);
      return { privateKey: priv, publicKey: pub };
    } catch {
      return null;
    }
  }

  async function getOrCreateKeypairForSetup(): Promise<{ privateKey: string; publicKey: string }> {
    ensureConfigDir();
    const existing = readExistingKey();
    if (existing) return existing;
    const pair = generateWireGuardKeyPair();
    const tempKeyFile = `${keyFilePath}.${Date.now()}.tmp`;
    try {
      if (isWindows) {
        fs.closeSync(fs.openSync(tempKeyFile, 'wx'));
        const ownerSid = await secureWindowsConfigDirectory();
        const icaclsPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
        const aclResult = await exec(icaclsPath, [tempKeyFile, '/inheritance:r', '/grant:r', `*${ownerSid}:F`, '*S-1-5-18:F', '*S-1-5-32-544:F']);
        requireCommandSuccess(aclResult, 'Secure Windows WireGuard private key');
        fs.writeFileSync(tempKeyFile, pair.privateKey, { encoding: 'utf8' });
      } else {
        fs.writeFileSync(tempKeyFile, pair.privateKey, { encoding: 'utf8', mode: 0o600 });
        fs.chmodSync(tempKeyFile, 0o600);
      }
      fs.renameSync(tempKeyFile, keyFilePath);
    } catch (err: unknown) {
      throw new Error(`Failed to secure secret private key permissions: ${getErrorMessage(err)}`);
    }
    return pair;
  }

  function renderConfigFile(privateKey: string, peers: Record<string, ManagedPeerEntry>): string {
    const lines = [
      '# Managed by ProxyFleet Controller - DO NOT EDIT MANUALLY',
      '[Interface]',
      `PrivateKey = ${privateKey}`,
      `Address = ${settings.controllerAddressCidr}`,
      `ListenPort = ${settings.listenPort}`,
    ];
    if (settings.mtu) lines.push(`MTU = ${settings.mtu}`);
    lines.push('');
    for (const peer of Object.values(peers)) {
      lines.push('[Peer]', `PublicKey = ${peer.publicKey}`, `AllowedIPs = ${peer.address}/32`, '');
    }
    return lines.join('\n');
  }

  async function writeConfigFileAtomically(content: string): Promise<void> {
    ensureConfigDir();
    const tempFile = `${confFilePath}.${Date.now()}.tmp`;
    try {
      if (isWindows) {
        fs.closeSync(fs.openSync(tempFile, 'wx'));
        const ownerSid = await secureWindowsConfigDirectory();
        const icaclsPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
        const aclResult = await exec(icaclsPath, [tempFile, '/inheritance:r', '/grant:r', `*${ownerSid}:F`, '*S-1-5-18:F', '*S-1-5-32-544:F']);
        requireCommandSuccess(aclResult, 'Secure Windows WireGuard config');
        fs.writeFileSync(tempFile, content, { encoding: 'utf8' });
      } else {
        fs.writeFileSync(tempFile, content, { encoding: 'utf8', mode: 0o600 });
        fs.chmodSync(tempFile, 0o600);
      }
      fs.renameSync(tempFile, confFilePath);
    } catch (err: unknown) {
      throw new Error(`Failed to secure secret configuration permissions: ${getErrorMessage(err)}`);
    }
  }

  async function probePeerActive(targetIp: string, pingBin: string | null): Promise<boolean> {
    if (!pingBin) return false;
    try {
      const args = isWindows ? ['-n', '1', '-w', '1000', targetIp] : ['-c', '1', '-W', '1', targetIp];
      const res = await exec(pingBin, args, { timeoutMs: 3000 });
      return res.code === 0;
    } catch {
      return false;
    }
  }

  return {
    async preflight(): Promise<{ publicKey: string; observation: OverlayObservation }> {
      const binaries = detectBinaries();
      if (!binaries.wgPath) {
        throw new Error('WireGuard tooling (wg) not found or not available');
      }

      // Pure readonly preflight: requires existing owned config and key
      if (fs.existsSync(confFilePath)) {
        const owner = readOwnership();
        if (!owner) {
          throw new Error(`Foreign configuration detected: ${confFilePath} exists without ProxyFleet ownership marker`);
        }
        if (owner.controllerAddressCidr !== settings.controllerAddressCidr) {
          throw new Error(`Controller CIDR conflict: existing owned configuration uses ${owner.controllerAddressCidr}, requested ${settings.controllerAddressCidr}`);
        }
      } else {
        throw new Error('WireGuard setup required: owned interface configuration is missing');
      }

      const keypair = readExistingKey();
      if (!keypair) {
        throw new Error('WireGuard setup required: controller private key not found');
      }

      const observation = await this.observe();
      const owner = readOwnership();
      if (!owner || owner.publicKey !== keypair.publicKey) throw new Error('Controller key and ownership identity do not match');
      if (observation.interfacePresent !== true) throw new Error('Owned WireGuard runtime interface is not available');
      return {
        publicKey: keypair.publicKey,
        observation,
      };
    },

    async setup(): Promise<{ publicKey: string; observation: OverlayObservation }> {
      const binaries = detectBinaries();
      if (!binaries.wgPath) {
        throw new Error('WireGuard tooling (wg) not installed or detected on host');
      }

      if (isWindows) {
        const scPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'sc.exe');
        const serviceCheck = await exec(scPath, ['query', `WireGuardTunnel$${settings.interfaceName}`]);
        if (serviceCheck.code === 0 && !readOwnership()) {
          throw new Error(`Foreign Windows service 'WireGuardTunnel$${settings.interfaceName}' detected without ProxyFleet ownership`);
        }
        const serviceOutput = `${serviceCheck.stdout}\n${serviceCheck.stderr}`;
        const serviceAbsent = serviceCheck.code === 1060 || serviceOutput.includes("1060");
        if (serviceCheck.code !== 0 && !serviceAbsent) {
          throw new Error(`Windows WireGuard service query failed: ${serviceCheck.stderr.trim() || serviceCheck.stdout.trim() || `exit code ${serviceCheck.code}`}`);
        }
      } else if (binaries.ipPath) {
        const linkCheck = await exec(binaries.ipPath, ['link', 'show', settings.interfaceName]);
        if (linkCheck.code === 0 && !readOwnership()) {
          throw new Error(`Foreign Linux interface '${settings.interfaceName}' detected without ProxyFleet ownership`);
        }
      }

      // Check foreign interface config
      if (fs.existsSync(confFilePath)) {
        const existingOwner = readOwnership();
        if (!existingOwner) {
          throw new Error(`Refusing to overwrite foreign configuration at ${confFilePath}`);
        }
      }
      let linuxSystemctlPath: string | null = null;
      if (!isWindows) {
        if (!binaries.ipPath || !binaries.wgPath) throw new Error('ip and wg binaries are required on Linux for WireGuard setup');
        if (resolvedConfigDir !== '/etc/wireguard') throw new Error('Persistent Linux WireGuard setup requires configDir=/etc/wireguard');
        linuxSystemctlPath = process.env.PATH?.split(path.delimiter).map((dir) => path.join(dir, 'systemctl')).find((candidate) => fs.existsSync(candidate)) || null;
        if (!linuxSystemctlPath) throw new Error('systemctl is required for persistent Linux WireGuard setup');
      }

      if (isWindows) await secureWindowsConfigDirectory();

      const keypair = await getOrCreateKeypairForSetup();
      const existingOwner = readOwnership();
      const managedPeers = existingOwner?.managedPeers || {};
      const recovery = existingOwner?.recovery || { consecutiveFailures: 0, lastRecoveryAt: null };

      // Persist ownership marker
      const meta: OwnershipMetadata = {
        owner: 'proxyfleet-controller',
        interfaceName: settings.interfaceName,
        controllerAddressCidr: settings.controllerAddressCidr,
        listenPort: settings.listenPort,
        publicKey: keypair.publicKey,
        createdAt: existingOwner?.createdAt || Date.now(),
        managedPeers,
        recovery,
      };
      writeOwnership(meta);

      const confContent = renderConfigFile(keypair.privateKey, managedPeers);
      await writeConfigFileAtomically(confContent);

      // Native interface provisioning
      if (isWindows) {
        if (!binaries.wireguardPath) {
          throw new Error('wireguard.exe is required on Windows for tunnel service installation');
        }
        const installRes = await exec(binaries.wireguardPath, ['/installtunnelservice', confFilePath]);
        requireCommandSuccess(installRes, 'Windows WireGuard tunnel installation', [keypair.privateKey]);
      } else {
        const enableRes = await exec(linuxSystemctlPath!, ['enable', '--now', `wg-quick@${settings.interfaceName}.service`]);
        requireCommandSuccess(enableRes, 'Enable persistent wg-quick service', [keypair.privateKey]);
      }

      const observation = await this.observe();
      return {
        publicKey: keypair.publicKey,
        observation,
      };
    },

    async reconcilePeers(peers: Array<{ nodeId: string; publicKey: string; address: string }>): Promise<void> {
      // Validate all peers
      const seenNodes = new Set<string>();
      const seenKeys = new Set<string>();
      const seenAddresses = new Set<string>();

      for (const p of peers) {
        if (!p.nodeId || typeof p.nodeId !== 'string') {
          throw new Error('Peer nodeId must be a non-empty string');
        }

        if (!/^[A-Za-z0-9_-]{1,64}$/.test(p.nodeId)) {
          throw new Error(`Peer nodeId must contain only letters, digits, underscore, or hyphen (got '${p.nodeId}')`);
        }
        if (seenNodes.has(p.nodeId)) {
          throw new Error(`Duplicate peer nodeId '${p.nodeId}'`);
        }
        seenNodes.add(p.nodeId);

        validateBase64Key(p.publicKey, `Peer '${p.nodeId}' public key`);
        if (seenKeys.has(p.publicKey)) {
          throw new Error(`Duplicate peer public key '${p.publicKey}'`);
        }
        seenKeys.add(p.publicKey);

        validatePeerAddress(p.address, settings.controllerAddressCidr);
        const cleanAddr = p.address.endsWith('/32') ? p.address.slice(0, -3) : p.address;
        if (seenAddresses.has(cleanAddr)) {
          throw new Error(`Duplicate peer address '${cleanAddr}'`);
        }
        seenAddresses.add(cleanAddr);
      }

      // Check ownership
      const owner = readOwnership();
      if (!owner) {
        throw new Error(`Cannot reconcile peers: interface '${settings.interfaceName}' has no ProxyFleet ownership marker`);
      }

      const keypair = readExistingKey();
      if (!keypair) {
        throw new Error('Controller private key not found for peer reconciliation');
      }
      const binaries = detectBinaries();
      const wgBin = binaries.wgPath;

      // Prepare desired managedPeers map
      const desiredPeers: Record<string, ManagedPeerEntry> = {};
      for (const p of peers) {
        const cleanAddr = p.address.endsWith('/32') ? p.address.slice(0, -3) : p.address;
        desiredPeers[p.nodeId] = {
          nodeId: p.nodeId,
          publicKey: p.publicKey,
          address: cleanAddr,
        };
      }

      if (!wgBin) {
        throw new Error('wg binary not available to apply runtime peer reconciliation');
      }

      const showRes = await exec(wgBin, ['show', settings.interfaceName, 'dump']);
      requireCommandSuccess(showRes, 'wg show dump for peer reconciliation', [keypair.privateKey]);
      const runningPeers = parseWgShowDump(showRes.stdout).peers;
      const previousOwnedKeys = new Set(Object.values(owner.managedPeers).map((p) => p.publicKey));
      const desiredKeySet = new Set(peers.map((p) => p.publicKey));
      for (const running of runningPeers) {
        if (!previousOwnedKeys.has(running.publicKey) && desiredKeySet.has(running.publicKey)) {
          throw new Error(`Refusing to claim foreign runtime peer '${running.publicKey}'`);
        }
      }

      for (const running of runningPeers) {
        if (previousOwnedKeys.has(running.publicKey) && !desiredKeySet.has(running.publicKey)) {
          const rmRes = await exec(wgBin, ['set', settings.interfaceName, 'peer', running.publicKey, 'remove']);
          requireCommandSuccess(rmRes, `remove stale peer '${running.publicKey}'`, [keypair.privateKey]);
        }
      }
      for (const p of peers) {
        const cleanAddr = p.address.endsWith('/32') ? p.address.slice(0, -3) : p.address;
        const setRes = await exec(wgBin, ['set', settings.interfaceName, 'peer', p.publicKey, 'allowed-ips', `${cleanAddr}/32`]);
        requireCommandSuccess(setRes, `apply peer '${p.nodeId}' to runtime`, [keypair.privateKey]);
      }

      const confContent = renderConfigFile(keypair.privateKey, desiredPeers);
      await writeConfigFileAtomically(confContent);
      owner.managedPeers = desiredPeers;
      writeOwnership(owner);
    },

    async removePeer(record: RemovalPeer): Promise<void> {
      const binaries = detectBinaries();
      const wgBin = binaries.wgPath;
      if (!wgBin) {
        throw new Error('WireGuard tooling not available for peer removal');
      }

      // Check ownership
      const owner = readOwnership();
      if (!owner) {
        throw new Error(`Cannot remove peer: interface '${settings.interfaceName}' is not owned by ProxyFleet`);
      }

      const keypair = readExistingKey();
      if (!keypair) {
        throw new Error('Controller private key not found for peer removal');
      }

      // Query running peers: dump MUST succeed
      const showRes = await exec(wgBin, ['show', settings.interfaceName, 'dump']);
      requireCommandSuccess(showRes, 'inspect running interface for removal', [keypair.privateKey]);
      const runningPeers = parseWgShowDump(showRes.stdout).peers;

      const cleanWireguardIp = record.wireguardIp ? (record.wireguardIp.endsWith('/32') ? record.wireguardIp.slice(0, -3) : record.wireguardIp) : '';

      // Resolve canonical persisted peer first
      const persistedPeer = owner.managedPeers[record.nodeId];
      if (persistedPeer) {
        // Conflict check: supplied key or IP must match canonical persisted peer
        if (record.publicKey && record.publicKey !== persistedPeer.publicKey) {
          throw new Error(`Removal conflict for node '${record.nodeId}': supplied publicKey '${record.publicKey}' does not match persisted '${persistedPeer.publicKey}'`);
        }
        if (cleanWireguardIp && cleanWireguardIp !== persistedPeer.address) {
          throw new Error(`Removal conflict for node '${record.nodeId}': supplied wireguardIp '${cleanWireguardIp}' does not match persisted '${persistedPeer.address}'`);
        }
      } else {
        // Check if supplied key/IP collides with another managed node
        for (const [otherNodeId, otherPeer] of Object.entries(owner.managedPeers)) {
          if ((record.publicKey && record.publicKey === otherPeer.publicKey) || (cleanWireguardIp && cleanWireguardIp === otherPeer.address)) {
            throw new Error(`Removal conflict: supplied credentials belong to node '${otherNodeId}', not '${record.nodeId}'`);
          }
        }
      }

      const targetKey = persistedPeer?.publicKey || record.publicKey;
      const matchingRunning = targetKey ? runningPeers.find((p) => p.publicKey === targetKey) : null;
      if (matchingRunning && !persistedPeer) throw new Error('Cannot remove an unowned runtime peer');

      // Verify persisted configuration as well as metadata before releasing an address.
      if (!matchingRunning && !persistedPeer) {
        if (targetKey && fs.readFileSync(confFilePath, 'utf8').includes(targetKey)) throw new Error('Peer still exists in persisted configuration');
        return;
      }

      // Remove from runtime if present
      if (matchingRunning) {
        const rmRes = await exec(wgBin, ['set', settings.interfaceName, 'peer', matchingRunning.publicKey, 'remove']);
        requireCommandSuccess(rmRes, 'remove running peer', [keypair.privateKey]);
      }

      // Remove from persisted config & owner marker
      if (persistedPeer) {
        delete owner.managedPeers[record.nodeId];
        writeOwnership(owner);
        const confContent = renderConfigFile(keypair.privateKey, owner.managedPeers);
        await writeConfigFileAtomically(confContent);
        if (targetKey && fs.readFileSync(confFilePath, 'utf8').includes(targetKey)) throw new Error('Peer still exists in persisted configuration');
      }

      // Post-verification: ensure absence from runtime via mandatory dump check
      const verifyRes = await exec(wgBin, ['show', settings.interfaceName, 'dump']);
      requireCommandSuccess(verifyRes, 'verify absence of removed peer', [keypair.privateKey]);
      const verifyPeers = parseWgShowDump(verifyRes.stdout).peers;
      if (targetKey && verifyPeers.some((p) => p.publicKey === targetKey)) {
        throw new Error(`Peer '${record.nodeId}' was not completely removed from runtime interface`);
      }
    },


    async observe(probeTargetIp?: string): Promise<OverlayObservation> {
      const binaries = detectBinaries();
      const wgBin = binaries.wgPath;

      const owner = readOwnership();
      const lastRecoveryAt = owner?.recovery.lastRecoveryAt || null;

      if (!wgBin) {
        return {
          state: 'unknown',
          interfacePresent: null,
          peerPresent: null,
          lastHandshakeAt: null,
          probeOk: null,
          rxBytes: null,
          txBytes: null,
          error: 'WireGuard CLI tool not available',
          lastRecoveryAt,
        };
      }

      let dump: ParsedDump | null = null;
      let execError: string | null = null;
      try {
        const res = await exec(wgBin, ['show', settings.interfaceName, 'dump']);
        if (res.code === 0) {
          dump = parseWgShowDump(res.stdout);
        } else {
          execError = res.stderr.trim() || `Exit code ${res.code}`;
        }
      } catch (err: unknown) {
        execError = getErrorMessage(err);
      }

      if (!dump) {
        return {
          state: 'unhealthy',
          interfacePresent: false,
          peerPresent: false,
          lastHandshakeAt: null,
          probeOk: null,
          rxBytes: null,
          txBytes: null,
          error: execError ? `Interface unavailable: ${scrubSecrets(execError, []).slice(0, 256)}` : null,
          lastRecoveryAt,
        };
      }

      const peerCount = dump.peers.length;
      let maxHandshake = 0;
      let totalRx = 0;
      let totalTx = 0;

      for (const p of dump.peers) {
        if (p.latestHandshake > maxHandshake) maxHandshake = p.latestHandshake;
        totalRx += p.transferRx;
        totalTx += p.transferTx;
      }

      // Probe active target if provided (pure readonly: does not mutate state or disk)
      let probeOk: boolean | null = null;
      const target = probeTargetIp || (owner && Object.values(owner.managedPeers)[0]?.address);
      if (target) {
        validatePeerAddress(target, settings.controllerAddressCidr);
        const managedPeer = owner && Object.values(owner.managedPeers).find(peer => peer.address === target);
        if (!managedPeer || !dump.peers.some(peer => peer.publicKey === managedPeer.publicKey)) {
          throw new Error('Probe target is not a verified owned runtime peer');
        }
        if (binaries.pingPath) probeOk = await probePeerActive(target, binaries.pingPath);
      }
      const state: 'healthy' | 'unhealthy' | 'unknown' = probeOk === null ? 'unknown' : probeOk ? 'healthy' : 'unhealthy';

      return {
        state,
        interfacePresent: true,
        peerPresent: peerCount > 0,
        lastHandshakeAt: maxHandshake > 0 ? maxHandshake * 1000 : null,
        probeOk,
        rxBytes: totalRx,
        txBytes: totalTx,
        error: null,
        lastRecoveryAt,
      };
    },

    async recover(probeTargetIp?: string): Promise<void> {
      const binaries = detectBinaries();
      const wgBin = binaries.wgPath;
      if (!wgBin) {
        throw new Error('WireGuard tooling not available for recovery');
      }

      const owner = readOwnership();
      if (!owner) {
        throw new Error('Cannot recover interface: ProxyFleet ownership marker not found');
      }

      const target = probeTargetIp || Object.values(owner.managedPeers)[0]?.address;
      if (!target) {
        return;
      }

      const probeOk = await probePeerActive(target, binaries.pingPath);
      let consecutiveFailures = owner.recovery.consecutiveFailures;
      let lastRecoveryAt = owner.recovery.lastRecoveryAt;

      if (!probeOk) {
        consecutiveFailures += 1;
        const now = Date.now();
        const cooldownElapsed = !lastRecoveryAt || now - lastRecoveryAt >= 300_000;
        if (consecutiveFailures >= 3 && cooldownElapsed) {
          lastRecoveryAt = now;
          owner.recovery = { consecutiveFailures, lastRecoveryAt };
          writeOwnership(owner);

          if (fs.existsSync(confFilePath)) {
            const syncRes = await exec(wgBin, ['syncconf', settings.interfaceName, confFilePath]);
            requireCommandSuccess(syncRes, 'wg syncconf recovery');
            consecutiveFailures = 0;
          }
        }
      } else {
        consecutiveFailures = 0;
      }

      owner.recovery = {
        consecutiveFailures,
        lastRecoveryAt,
      };
      writeOwnership(owner);
    },
  };
}

export async function verifyFleetWireGuardAbsent(
  options?: FleetWireGuardManagerOptions,
  interfaceName = 'proxyfleet'
): Promise<boolean> {
  const isWindows = process.platform === 'win32';
  const resolvedConfigDir =
    options?.configDir ||
    (isWindows
      ? process.env.ProgramData
        ? path.join(process.env.ProgramData, 'WireGuard')
        : path.join(process.cwd(), 'data', 'wireguard')
      : fs.existsSync('/etc/wireguard')
        ? '/etc/wireguard'
        : path.join(process.cwd(), 'data', 'wireguard'));

  for (const filename of [`${interfaceName}.conf`, `${interfaceName}-owner.json`, `${interfaceName}.key`]) {
    const candidate = path.join(resolvedConfigDir, filename);
    if (fs.existsSync(candidate)) return false;
  }

  const exec = options?.commandExecutor || defaultCommandExecutor;
  const binaries = detectBinaries();

  if (isWindows) {
    const scPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'sc.exe');
    const serviceRes = await exec(scPath, ['query', `WireGuardTunnel$${interfaceName}`]);
    if (serviceRes.code === 0) return false;
    const serviceOutput = `${serviceRes.stdout}\n${serviceRes.stderr}`;
    const serviceAbsent = serviceRes.code === 1060 || serviceOutput.includes("1060");
    if (!serviceAbsent) {
      throw new Error(`Windows WireGuard service query failed: ${serviceRes.stderr.trim() || serviceRes.stdout.trim() || `exit code ${serviceRes.code}`}`);
    }
  }

  if (binaries.wgPath) {
    const ifaceRes = await exec(binaries.wgPath, ['show', 'interfaces']);
    if (ifaceRes.code === 0) {
      const names = ifaceRes.stdout.trim().split(/\s+/).filter(Boolean);
      if (names.includes(interfaceName)) return false;
    } else if (!isWindows || ifaceRes.code !== 1) {
      const diagnostic = ifaceRes.stderr.trim() || ifaceRes.stdout.trim() || `exit code ${ifaceRes.code}`;
      throw new Error(`WireGuard interface inspection failed: ${diagnostic}`);
    }
  }

  return true;
}

