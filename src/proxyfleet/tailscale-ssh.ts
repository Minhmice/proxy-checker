import { Client } from "ssh2";
import crypto from "node:crypto";
import { validatePublicIpv4 } from "./public-ip-gate.js";

export interface SshTarget {
  host: string;
  port?: number;
}

export interface SshCredentials {
  username: string;
  password: string;
  hostKeyFingerprint: string;
}

export interface HostKeyInfo {
  fingerprint: string;
  keyType: string;
}

export function computeSha256Fingerprint(keyBuffer: Buffer): string {
  const hash = crypto.createHash("sha256").update(keyBuffer).digest("base64");
  return `SHA256:${hash}`;
}

export function inspectSshHostKey(
  target: SshTarget,
  timeoutMs = 10_000
): Promise<HostKeyInfo> {
  const { promise, resolve, reject } = Promise.withResolvers<HostKeyInfo>();
  const client = new Client();
  let discovered = false;

  const timer = setTimeout(() => {
    client.destroy();
    if (!discovered) reject(new Error("SSH host key inspection timed out"));
  }, timeoutMs);

  client
    .on("error", (err: Error) => {
      clearTimeout(timer);
      if (!discovered) reject(err);
    })
    .on("close", () => {
      clearTimeout(timer);
      if (!discovered) reject(new Error("Connection closed before host key inspection completed"));
    })
    .connect({
      host: target.host,
      port: target.port || 22,
      username: "probe",
      readyTimeout: timeoutMs,
      hostVerifier: (keyBuffer: Buffer) => {
        discovered = true;
        clearTimeout(timer);
        const fingerprint = computeSha256Fingerprint(keyBuffer);
        // Identify key type if available
        let keyType = "unknown";
        if (keyBuffer.length >= 4) {
          const typeLen = keyBuffer.readUInt32BE(0);
          if (typeLen > 0 && typeLen <= 64 && keyBuffer.length >= 4 + typeLen) {
            keyType = keyBuffer.subarray(4, 4 + typeLen).toString("utf8");
          }
        }
        client.destroy();
        resolve({ fingerprint, keyType });
        return false; // abort handshake immediately without authenticating
      },
    });

  return promise;
}

export interface TailscaleSshClient {
  execute(command: string, timeoutMs?: number): Promise<string>;
  readPublicIp(timeoutMs?: number): Promise<string>;
}

export function createTailscaleSshClient(
  target: SshTarget,
  credentials: SshCredentials
): TailscaleSshClient {
  const host = target.host;
  const port = target.port || 22;

  function connectClient(timeoutMs = 15_000): Promise<Client> {
    const { promise, resolve, reject } = Promise.withResolvers<Client>();
    const client = new Client();
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        client.destroy();
        reject(new Error(`SSH connection to ${host}:${port} timed out`));
      }
    }, timeoutMs);

    client
      .on("ready", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(client);
        }
      })
      .on("error", (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      })
      .on("close", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("SSH connection closed"));
        }
      })
      .connect({
        host,
        port,
        username: credentials.username,
        password: credentials.password,
        readyTimeout: timeoutMs,
        hostVerifier: (keyBuffer: Buffer) => {
          const actualFingerprint = computeSha256Fingerprint(keyBuffer);
          const expected = credentials.hostKeyFingerprint.trim();
          if (actualFingerprint !== expected) {
            client.destroy();
            const err = new Error(
              `SSH host key fingerprint mismatch! Expected: ${expected}, Got: ${actualFingerprint}`
            );
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(err);
            }
            return false;
          }
          return true;
        },
      });

    return promise;
  }

  return {
    async execute(command: string, timeoutMs = 30_000): Promise<string> {
      const client = await connectClient(timeoutMs);
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          client.destroy();
          reject(new Error("SSH command execution timed out"));
        }
      }, timeoutMs);

      client.exec(command, (err, stream) => {
        if (err) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            client.end();
            reject(err);
          }
          return;
        }

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let totalSize = 0;

        stream
          .on("data", (chunk: Buffer) => {
            totalSize += chunk.length;
            if (totalSize > 2 * 1024 * 1024) {
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                client.destroy();
                reject(new Error("SSH output exceeded 2MB limit"));
              }
              return;
            }
            stdoutChunks.push(chunk);
          })
          .stderr.on("data", (chunk: Buffer) => {
            stderrChunks.push(chunk);
          });

        stream.on("close", (code: number) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            client.end();
            const stdout = Buffer.concat(stdoutChunks).toString("utf8");
            const stderr = Buffer.concat(stderrChunks).toString("utf8");
            if (code !== 0) {
              const diag = (stderr.trim() || stdout.trim() || `exit code ${code}`).slice(0, 500);
              reject(new Error(`Command failed: ${diag}`));
            } else {
              resolve(stdout);
            }
          }
        });
      });

      return promise;
    },

    async readPublicIp(timeoutMs = 15_000): Promise<string> {
      // Fixed curl command executed on remote worker via https://api.ipify.org
      const cmd = "curl -4 --noproxy '*' --proto '=https' --fail --silent --show-error --connect-timeout 5 --max-time 10 --max-filesize 1024 https://api.ipify.org";
      const raw = await this.execute(cmd, timeoutMs);
      const trimmed = raw.trim();
      return validatePublicIpv4(trimmed);
    },
  };
}
