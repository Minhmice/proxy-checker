import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateFleetWireGuardSettings,
  validateBase64Key,
  validatePeerAddress,
  scrubSecrets,
  generateWireGuardKeyPair,
  derivePublicKey,
  parseWgShowDump,
  createFleetWireGuardManager,
  type CommandExecutor,
  type FleetWireGuardSettings,
  type RemovalPeer,
} from '../src/proxyfleet/wireguard.js';

describe('FleetWireGuardSettings validation', () => {
  const validSettings: FleetWireGuardSettings = {
    interfaceName: 'proxyfleet',
    controllerAddressCidr: '10.77.0.1/24',
    publicEndpoint: 'vpn.example.com:51820',
    listenPort: 51820,
    mtu: 1420,
  };

  it('accepts valid default settings', () => {
    const res = validateFleetWireGuardSettings(validSettings);
    assert.equal(res.interfaceName, 'proxyfleet');
    assert.equal(res.controllerAddressCidr, '10.77.0.1/24');
    assert.equal(res.publicEndpoint, 'vpn.example.com:51820');
    assert.equal(res.listenPort, 51820);
    assert.equal(res.mtu, 1420);
  });

  it('rejects non-proxyfleet interface names', () => {
    assert.throws(() => validateFleetWireGuardSettings({ ...validSettings, interfaceName: 'proxyfleet-0' }), /must be exactly 'proxyfleet'/);
    assert.throws(() => validateFleetWireGuardSettings({ ...validSettings, interfaceName: 'wg0' }), /must be exactly 'proxyfleet'/);
    assert.throws(() => validateFleetWireGuardSettings({ ...validSettings, interfaceName: 'eth0' }), /must be exactly 'proxyfleet'/);
    assert.throws(() => validateFleetWireGuardSettings({ ...validSettings, interfaceName: 'tun0' }), /must be exactly 'proxyfleet'/);
  });

  it('rejects CIDRs other than 10.77.0.1/24', () => {
    assert.throws(() => validateFleetWireGuardSettings({ ...validSettings, controllerAddressCidr: '10.77.0.11/24' }), /must be exactly '10\.77\.0\.1\/24'/);
    assert.throws(() => validateFleetWireGuardSettings({ ...validSettings, controllerAddressCidr: '192.168.1.1/24' }), /must be exactly '10\.77\.0\.1\/24'/);
    assert.throws(() => validateFleetWireGuardSettings({ ...validSettings, controllerAddressCidr: '10.77.0.0/24' }), /must be exactly '10\.77\.0\.1\/24'/);
    assert.throws(() => validateFleetWireGuardSettings({ ...validSettings, controllerAddressCidr: '10.77.0.255/24' }), /must be exactly '10\.77\.0\.1\/24'/);
  });

  it('accepts IPv4, hostname, and bracketed IPv6 endpoints', () => {
    const ipv4 = validateFleetWireGuardSettings({ ...validSettings, publicEndpoint: '1.2.3.4:51820' });
    assert.equal(ipv4.publicEndpoint, '1.2.3.4:51820');

    const ipv6 = validateFleetWireGuardSettings({ ...validSettings, publicEndpoint: '[2001:db8::1]:51820' });
    assert.equal(ipv6.publicEndpoint, '[2001:db8::1]:51820');
  });

  it('rejects invalid endpoints and ports', () => {
    assert.throws(() => validateFleetWireGuardSettings({ ...validSettings, publicEndpoint: 'invalid-no-port' }), /'host:port' format/);
    assert.throws(() => validateFleetWireGuardSettings({ ...validSettings, publicEndpoint: '[invalid-ipv6]:51820' }), /IPv6 address is invalid/);
    assert.throws(() => validateFleetWireGuardSettings({ ...validSettings, publicEndpoint: '2001:db8::1:51820' }), /enclosed in brackets/);
    assert.throws(() => validateFleetWireGuardSettings({ ...validSettings, publicEndpoint: 'example.com:99999' }), /port must be between 1 and 65535/);
    assert.throws(() => validateFleetWireGuardSettings({ ...validSettings, listenPort: 0 }), /listenPort must be between 1 and 65535/);
    assert.throws(() => validateFleetWireGuardSettings({ ...validSettings, listenPort: 70000 }), /listenPort must be between 1 and 65535/);
  });

  it('validates MTU range', () => {
    const nullMtu = validateFleetWireGuardSettings({ ...validSettings, mtu: null });
    assert.equal(nullMtu.mtu, null);

    assert.throws(() => validateFleetWireGuardSettings({ ...validSettings, mtu: 1000 }), /mtu must be between 1280 and 9000/);
    assert.throws(() => validateFleetWireGuardSettings({ ...validSettings, mtu: 9500 }), /mtu must be between 1280 and 9000/);
  });
});

describe('WireGuard key handling and cryptography', () => {
  it('validates base64 key strings', () => {
    const pair = generateWireGuardKeyPair();
    assert.doesNotThrow(() => validateBase64Key(pair.publicKey));
    assert.doesNotThrow(() => validateBase64Key(pair.privateKey));

    assert.throws(() => validateBase64Key('short-key'), /44-character/);
    assert.throws(() => validateBase64Key('A'.repeat(42) + 'B='));
  });

  it('derives matching public key from private key', () => {
    const pair = generateWireGuardKeyPair();
    const derived = derivePublicKey(pair.privateKey);
    assert.equal(derived, pair.publicKey);
  });
});

describe('Peer address validation', () => {
  it('accepts valid /32 overlay address', () => {
    assert.doesNotThrow(() => validatePeerAddress('10.77.0.2', '10.77.0.1/24'));
    assert.doesNotThrow(() => validatePeerAddress('10.77.0.2/32', '10.77.0.1/24'));
  });

  it('rejects collision with controller address', () => {
    assert.throws(() => validatePeerAddress('10.77.0.1', '10.77.0.1/24'), /collides with controller/);
  });

  it('rejects addresses outside 10.77.0.0/24 subnet', () => {
    assert.throws(() => validatePeerAddress('10.77.1.5', '10.77.0.1/24'), /10\.77\.0\.0\/24 subnet/);
    assert.throws(() => validatePeerAddress('10.77.0.0', '10.77.0.1/24'), /host byte must be between 1 and 254/);
    assert.throws(() => validatePeerAddress('10.77.0.255', '10.77.0.1/24'), /host byte must be between 1 and 254/);
  });
});

describe('Dump parser and secret scrubber', () => {
  it('scrubs private keys from logs and messages', () => {
    const secret = 'n/+19WHXa0SO1yPeH+EfMNAwRo4N3jBnCPCzkwlOZYo=';
    const text = `Error connecting with private key ${secret} at runtime`;
    const scrubbed = scrubSecrets(text, [secret]);
    assert.equal(scrubbed.includes(secret), false);
    assert.equal(scrubbed.includes('[REDACTED]'), true);
  });

  it('parses wg show dump output', () => {
    const sampleDump = [
      'cGFzc3dvcmQ=\tMa9wvp4+3PU2J3xVg6MamMo0htgnY5njyN+KqwmZvRg=\t51820\toff',
      'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=\t(none)\t198.51.100.2:51820\t10.77.0.2/32\t1713300100\t1024\t2048\t25',
      'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=\t(none)\t(none)\t10.77.0.3/32\t0\t0\t0\toff',
    ].join('\n');

    const parsed = parseWgShowDump(sampleDump);
    assert.equal(parsed.listenPort, 51820);
    assert.equal(parsed.peers.length, 2);

    assert.equal(parsed.peers[0].publicKey, 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=');
    assert.equal(parsed.peers[0].latestHandshake, 1713300100);
    assert.equal(parsed.peers[0].transferRx, 1024);
    assert.equal(parsed.peers[0].transferTx, 2048);

    assert.equal(parsed.peers[1].latestHandshake, 0);
  });
});

describe('FleetWireGuardManager isolated operations', () => {
  function createTempConfigDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'proxyfleet-wg-test-'));
  }

  const sampleSettings: FleetWireGuardSettings = {
    interfaceName: 'proxyfleet',
    controllerAddressCidr: '10.77.0.1/24',
    publicEndpoint: '127.0.0.1:51820',
    listenPort: 51820,
    mtu: null,
  };
  const peerKey1 = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
  const peerKey2 = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=';
  const peerKey3 = 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=';
  const peerKey4 = 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=';
  const peerKey5 = 'BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=';

  const isolatedExecutor: CommandExecutor = async (file, args) => {
    if (file.toLowerCase().endsWith('whoami.exe')) return { stdout: 'USER,"S-1-5-21-1000-2000-3000-1001"\n', stderr: '', code: 0 };
    if (args[0] === 'link' && args[1] === 'show') return { stdout: '', stderr: 'interface absent', code: 1 };
    if (args[0] === 'show' && args[1] === 'proxyfleet' && args[2] === 'dump') return { stdout: 'priv\tPUB=\t51820\toff\n', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };

  function createManager(configDir: string, executor: CommandExecutor = isolatedExecutor, serviceExists = false) {
    const commandExecutor: CommandExecutor = async (file, args, options) => {
      if (file.toLowerCase().endsWith('whoami.exe')) return { stdout: 'USER,"S-1-5-21-1000-2000-3000-1001"\n', stderr: '', code: 0 };
      if (args[0] === 'query') return serviceExists ? { stdout: 'SERVICE_RUNNING', stderr: '', code: 0 } : { stdout: '', stderr: '1060: service does not exist', code: 1060 };
      if (args[0]?.endsWith('icacls.exe')) return { stdout: 'Successfully processed', stderr: '', code: 0 };
      return executor(file, args, options);
    };
    return createFleetWireGuardManager(sampleSettings, { configDir, commandExecutor });
  }

  it('preflight throws when setup required and rejects foreign configuration', async () => {
    const tempDir = createTempConfigDir();

    const manager = createManager(tempDir);
    // Fresh directory: preflight requires explicit setup
    await assert.rejects(
      async () => await manager.preflight(),
      /WireGuard setup required/
    );

    // Foreign unowned conf file
    const confPath = path.join(tempDir, 'proxyfleet.conf');
    fs.writeFileSync(confPath, '[Interface]\nPrivateKey = fake\n');

    await assert.rejects(
      async () => await manager.preflight(),
      /Foreign configuration detected/
    );
  });

  it('preflight succeeds in readonly mode after setup', async () => {
    const tempDir = createTempConfigDir();
    const mockExecutor: CommandExecutor = async (_file, args) => {
      if (args.includes('show') && args.includes('dump')) {
        return {
          stdout: 'priv\tMa9wvp4+3PU2J3xVg6MamMo0htgnY5njyN+KqwmZvRg=\t51820\toff\n',
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '', stderr: '', code: 0 };
    };

    const manager = createManager(tempDir, mockExecutor);

    await manager.setup();
    const res = await manager.preflight();
    assert.ok(res.publicKey);
    assert.equal(res.observation.state, 'unknown');
  });

  it('setup persists ownership metadata, creates config file, and invokes provisioning', async () => {
    const tempDir = createTempConfigDir();
    const executedCommands: Array<{ file: string; args: string[] }> = [];

    const mockExecutor: CommandExecutor = async (file, args) => {
      executedCommands.push({ file, args });
      if (args.includes('show') && args.includes('dump')) {
        return {
          stdout: 'priv\tMa9wvp4+3PU2J3xVg6MamMo0htgnY5njyN+KqwmZvRg=\t51820\toff\n',
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '', stderr: '', code: 0 };
    };

    const manager = createManager(tempDir, mockExecutor);

    const setupResult = await manager.setup();
    assert.ok(setupResult.publicKey);
    assert.equal(setupResult.observation.state, 'unknown');

    const ownerFile = path.join(tempDir, 'proxyfleet-owner.json');
    assert.ok(fs.existsSync(ownerFile));
    const ownerData = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    assert.equal(ownerData.owner, 'proxyfleet-controller');
    assert.equal(ownerData.interfaceName, 'proxyfleet');
    assert.equal(ownerData.controllerAddressCidr, '10.77.0.1/24');

    const confFile = path.join(tempDir, 'proxyfleet.conf');
    assert.ok(fs.existsSync(confFile));
  });

  it('reconcilePeers rejects duplicate peers and applies active diff', async () => {
    const tempDir = createTempConfigDir();
    const mockExecutor: CommandExecutor = async (_file, args) => {
      if (args.includes('show') && args.includes('dump')) {
        return {
          stdout: `priv\tPUB=\t51820\toff\n${peerKey3}\t(none)\t(none)\t10.77.0.99/32\t0\t0\t0\toff\n`,
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '', stderr: '', code: 0 };
    };

    const manager = createManager(tempDir, mockExecutor);

    await manager.setup();

    const peerA = {
      nodeId: 'node-a',
      publicKey: peerKey4,
      address: '10.77.0.2',
    };
    const peerB = {
      nodeId: 'node-b',
      publicKey: peerKey5,
      address: '10.77.0.3',
    };

    // Duplicate key rejection
    await assert.rejects(
      async () => await manager.reconcilePeers([peerA, { ...peerB, publicKey: peerA.publicKey }]),
      /Duplicate peer public key/
    );

    // Duplicate address rejection
    await assert.rejects(
      async () => await manager.reconcilePeers([peerA, { ...peerB, address: peerA.address }]),
      /Duplicate peer address/
    );

    // Successful reconciliation
    await manager.reconcilePeers([peerA, peerB]);

    const ownerData = JSON.parse(fs.readFileSync(path.join(tempDir, 'proxyfleet-owner.json'), 'utf8'));
    assert.equal(Object.keys(ownerData.managedPeers).length, 2);
    assert.equal(ownerData.managedPeers['node-a'].address, '10.77.0.2');
  });

  it('reconcilePeers rejects invalid nodeId format', async () => {
    const tempDir = createTempConfigDir();
    const manager = createManager(tempDir);
    await manager.setup();

    await assert.rejects(
      async () => await manager.reconcilePeers([{
        nodeId: 'bad\nnewline',
        publicKey: peerKey4,
        address: '10.77.0.2',
      }]),
      /letters, digits, underscore, or hyphen/
    );
  });

  it('reconcilePeers removes stale runtime peers from previous ownership after restart', async () => {
    const tempDir = createTempConfigDir();
    const oldKey = generateWireGuardKeyPair().publicKey;
    const commands: string[][] = [];
    let runtimePeers = [`${oldKey}\t(none)\t(none)\t10.77.0.2/32\t0\t0\t0\toff`];
    const executor: CommandExecutor = async (_file, args) => {
      commands.push(args);
      if (args.includes('dump')) return { stdout: ['priv\tPUB=\t51820\toff', ...runtimePeers].join('\n') + '\n', stderr: '', code: 0 };
      if (args.includes('remove')) runtimePeers = [];
      return { stdout: '', stderr: '', code: 0 };
    };
    const manager = createManager(tempDir, executor);
    await manager.setup();
    const ownerPath = path.join(tempDir, 'proxyfleet-owner.json');
    const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    owner.managedPeers['old-node'] = { nodeId: 'old-node', publicKey: oldKey, address: '10.77.0.2' };
    fs.writeFileSync(ownerPath, JSON.stringify(owner));
    const restartedManager = createManager(tempDir, executor);

    await restartedManager.reconcilePeers([]);

    assert.equal(runtimePeers.length, 0);
    assert.ok(commands.some((args) => args.includes('remove') && args.includes(oldKey)));
    assert.deepEqual(JSON.parse(fs.readFileSync(ownerPath, 'utf8')).managedPeers, {});
  });

  it('setup rejects foreign live interface or service before writing files', async () => {
    const tempDir = createTempConfigDir();
    const mockExecutor: CommandExecutor = async (_file, args) => {
      if (args[0] === 'query' || args[0] === 'show') {
        return { stdout: 'SERVICE_RUNNING', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    };

    const manager = createManager(tempDir, mockExecutor, true);

    await assert.rejects(
      async () => await manager.setup(),
      /Foreign.*detected without ProxyFleet ownership/
    );
  });

  it('removePeer handles clean absent peer and active peer removal', async () => {
    const tempDir = createTempConfigDir();
    let runtimePeers: string[] = [];

    const mockExecutor: CommandExecutor = async (_file, args) => {
      if (args.includes('show') && args.includes('dump')) {
        return {
          stdout: ['priv\tPUB=\t51820\toff', ...runtimePeers].join('\n') + '\n',
          stderr: '',
          code: 0,
        };
      }
      if (args.includes('set') && args.includes('allowed-ips')) {
        runtimePeers = [`${peerKey1}\t(none)\t(none)\t10.77.0.2/32\t0\t0\t0\toff`];
      }
      if (args.includes('set') && args.includes('remove')) {
        runtimePeers = [];
        return { stdout: '', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    };

    const manager = createManager(tempDir, mockExecutor);

    await manager.setup();
    await manager.reconcilePeers([
      {
        nodeId: 'node-1',
        publicKey: peerKey1,
        address: '10.77.0.2',
      },
    ]);

    // Clean success for non-existent peer
    const nonExistent: RemovalPeer = {
      nodeId: 'node-unknown',
      nodeName: 'ghost',
      wireguardIp: '10.77.0.99',
      publicKey: peerKey2,
    };
    await assert.doesNotReject(async () => await manager.removePeer(nonExistent));

    // Remove active peer
    const targetPeer: RemovalPeer = {
      nodeId: 'node-1',
      nodeName: 'target',
      wireguardIp: '10.77.0.2',
      publicKey: peerKey1,
    };
    await manager.removePeer(targetPeer);

    const ownerData = JSON.parse(fs.readFileSync(path.join(tempDir, 'proxyfleet-owner.json'), 'utf8'));
    assert.equal(ownerData.managedPeers['node-1'], undefined);
  });

  it('removePeer rejects conflicting publicKey or IP for existing nodeId', async () => {
    const tempDir = createTempConfigDir();
    const mockExecutor: CommandExecutor = async (_file, args) => {
      if (args.includes('show') && args.includes('dump')) {
        return { stdout: 'priv\tPUB=\t51820\toff\n', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    };

    const manager = createManager(tempDir, mockExecutor);

    await manager.setup();
    await manager.reconcilePeers([{
      nodeId: 'node-1',
      publicKey: peerKey1,
      address: '10.77.0.2',
    }]);

    await assert.rejects(
      async () => await manager.removePeer({
        nodeId: 'node-1',
        nodeName: 'target',
        wireguardIp: '10.77.0.3', // Mismatched IP
        publicKey: peerKey1,
      }),
      /Removal conflict/
    );
  });

  it('observe is strictly readonly and recover triggers syncconf cooldown', async () => {
    const tempDir = createTempConfigDir();
    let syncConfCalled = 0;
    let peerConfigured = false;

    const mockExecutor: CommandExecutor = async (file, args) => {
      if (args.includes('show') && args.includes('dump')) {
        return {
          stdout: `priv\tPUB=\t51820\toff\n${peerConfigured ? `${peerKey1}\t(none)\t(none)\t10.77.0.2/32\t0\t0\t0\toff\n` : ''}`,
          stderr: '',
          code: 0,
        };
      }
      if (args.includes('set') && args.includes('allowed-ips')) peerConfigured = true;
      if (args.includes('syncconf')) {
        syncConfCalled++;
        return { stdout: '', stderr: '', code: 0 };
      }
      if (file.includes('ping')) {
        // simulate failed probe
        return { stdout: '', stderr: 'Destination Host Unreachable', code: 1 };
      }
      return { stdout: '', stderr: '', code: 0 };
    };

    const manager = createManager(tempDir, mockExecutor);

    await manager.setup();
    await manager.reconcilePeers([
      {
        nodeId: 'node-1',
        publicKey: peerKey1,
        address: '10.77.0.2',
      },
    ]);

    // observe() is strictly readonly: does not call syncconf or mutate owner failure count
    const obsReadonly = await manager.observe('10.77.0.2');
    assert.equal(obsReadonly.probeOk, false);
    assert.equal(syncConfCalled, 0);

    // Scheduled maintenance recover() calls:
    await manager.recover('10.77.0.2'); // fail 1
    assert.equal(syncConfCalled, 0);

    await manager.recover('10.77.0.2'); // fail 2
    assert.equal(syncConfCalled, 0);

    await manager.recover('10.77.0.2'); // fail 3 -> triggers syncconf
    assert.equal(syncConfCalled, 1);

    const obsAfter = await manager.observe('10.77.0.2');
    assert.ok(obsAfter.lastRecoveryAt);
  });
});
