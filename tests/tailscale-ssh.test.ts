import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Server as SshServer } from "ssh2";
import {
  inspectSshHostKey,
  createTailscaleSshClient,
  type SshTarget,
  type SshCredentials,
} from "../src/proxyfleet/tailscale-ssh.js";

// Generate transient RSA key for mock SSH server
const { privateKey: serverPrivKey, publicKey: serverPubKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const serverKeyPem = serverPrivKey.export({ type: "pkcs1", format: "pem" }).toString();

function startMockSshServer(port: number, options: {
  validUser: string;
  validPass: string;
  publicIpOutput?: string;
  hostnameOutput?: string;
  unameOutput?: string;
}) {
  const server = new SshServer({ hostKeys: [serverKeyPem] }, (client) => {
    client
      .on("authentication", (ctx) => {
        if (
          ctx.method === "password" &&
          ctx.username === options.validUser &&
          ctx.password === options.validPass
        ) {
          ctx.accept();
        } else {
          ctx.reject(["password"]);
        }
      })
      .on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          session.on("exec", (acceptExec, _rejectExec, info) => {
            const stream = acceptExec();
            const cmd = info.command;

            if (cmd.includes("curl") && cmd.includes("api.ipify.org")) {
              stream.write(options.publicIpOutput || "1.1.1.1\n");
              stream.exit(0);
              stream.end();
            } else if (cmd.includes("uname -m")) {
              stream.write(options.unameOutput || "x86_64\n");
              stream.exit(0);
              stream.end();
            } else if (cmd.includes("hostname")) {
              stream.write(options.hostnameOutput || "mock-vps\n");
              stream.exit(0);
              stream.end();
            } else {
              stream.write("OK\n");
              stream.exit(0);
              stream.end();
            }
          });
        });
      });
  });

  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

test("inspectSshHostKey discovers host fingerprint without sending password", async () => {
  const mockPort = 22240;
  const srv = await startMockSshServer(mockPort, {
    validUser: "testuser",
    validPass: "testpass",
  });

  try {
    const target: SshTarget = { host: "127.0.0.1", port: mockPort };
    const res = await inspectSshHostKey(target);
    assert.ok(res.fingerprint.startsWith("SHA256:"));
    assert.equal(res.keyType, "ssh-rsa");
  } finally {
    await srv.close();
  }
});

test("createTailscaleSshClient verifies pinned fingerprint and rejects mismatch before authentication", async () => {
  const mockPort = 22241;
  const srv = await startMockSshServer(mockPort, {
    validUser: "testuser",
    validPass: "testpass",
  });

  try {
    const target: SshTarget = { host: "127.0.0.1", port: mockPort };
    const validInfo = await inspectSshHostKey(target);

    // Mismatched fingerprint must abort
    const badCreds: SshCredentials = {
      username: "testuser",
      password: "testpass",
      hostKeyFingerprint: "SHA256:wrongfingerprint1234567890=",
    };
    const badClient = createTailscaleSshClient(target, badCreds);
    await assert.rejects(async () => {
      await badClient.execute("echo test");
    }, /fingerprint mismatch/i);

    // Pinned fingerprint succeeds
    const goodCreds: SshCredentials = {
      username: "testuser",
      password: "testpass",
      hostKeyFingerprint: validInfo.fingerprint,
    };
    const goodClient = createTailscaleSshClient(target, goodCreds);
    const output = await goodClient.execute("echo test");
    assert.ok(output.includes("OK"));
  } finally {
    await srv.close();
  }
});

test("readRemotePublicIp discovers public IP from remote worker and sanitizes output", async () => {
  const mockPort = 22242;
  const srv = await startMockSshServer(mockPort, {
    validUser: "testuser",
    validPass: "testpass",
    publicIpOutput: " 1.1.1.1 \n",
  });

  try {
    const target: SshTarget = { host: "127.0.0.1", port: mockPort };
    const hostInfo = await inspectSshHostKey(target);
    const client = createTailscaleSshClient(target, {
      username: "testuser",
      password: "testpass",
      hostKeyFingerprint: hostInfo.fingerprint,
    });

    const ip = await client.readPublicIp();
    assert.equal(ip, "1.1.1.1");
  } finally {
    await srv.close();
  }
});
