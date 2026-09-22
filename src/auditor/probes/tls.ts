import tls from "node:tls";
import crypto from "node:crypto";
import type { ParsedProxyInput, TlsResult } from "../types.js";
import { openProxyTunnel } from "../transport/index.js";

export interface TlsProbeOptions {
  endpoint: string;
  timeoutMs?: number;
  allowPrivateTargets?: boolean;
  rejectUnauthorized?: boolean;
  expectedSpkiSha256?: string;
  directCertFingerprint256?: string;
  ca?: string | Buffer;
}

export function computeSpkiSha256(rawCert: Buffer): string {
  const x509 = new crypto.X509Certificate(rawCert);
  const spkiDer = x509.publicKey.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(spkiDer).digest("hex");
}

export async function probeTlsIntegrity(
  proxy: ParsedProxyInput,
  options: TlsProbeOptions
): Promise<TlsResult & { possibleMitm: boolean; spkiSha256?: string }> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const parsed = new URL(options.endpoint);
  const host = parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : 443;

  const { socket: plainSocket } = await openProxyTunnel(
    proxy,
    { host, port },
    {
      timeoutMs,
      allowPrivateTargets: options.allowPrivateTargets ?? false,
      targetDomain: host,
    }
  );

  const { promise, resolve } = Promise.withResolvers<
    TlsResult & { possibleMitm: boolean; spkiSha256?: string }
  >();

  let settled = false;
  const finish = (result: TlsResult & { possibleMitm: boolean; spkiSha256?: string }) => {
    if (settled) return;
    settled = true;
    resolve(result);
  };

  const tlsSocket = tls.connect({
    socket: plainSocket,
    servername: host,
    rejectUnauthorized: options.rejectUnauthorized ?? true,
    ca: options.ca,
    timeout: timeoutMs,
  });

  tlsSocket.once("secureConnect", () => {
    try {
      const cert = tlsSocket.getPeerCertificate(true);
      let spkiSha256: string | undefined = undefined;
      if (cert && typeof cert === "object" && "raw" in cert && Buffer.isBuffer(cert.raw)) {
        spkiSha256 = computeSpkiSha256(cert.raw);
      }

      const cipher = tlsSocket.getCipher()?.name;
      const protocol = tlsSocket.getProtocol() || undefined;
      const alpn = tlsSocket.alpnProtocol || undefined;

      let possibleMitm = false;
      let certificateValid = true;

      if (options.expectedSpkiSha256 && spkiSha256) {
        if (spkiSha256.toLowerCase() !== options.expectedSpkiSha256.toLowerCase()) {
          possibleMitm = true;
          certificateValid = false;
        }
      }

      if (options.directCertFingerprint256 && cert && "fingerprint256" in cert && typeof cert.fingerprint256 === "string") {
        if (
          cert.fingerprint256.replace(/:/g, "").toLowerCase() !==
          options.directCertFingerprint256.replace(/:/g, "").toLowerCase()
        ) {
          possibleMitm = true;
        }
      }

      finish({
        secure: true,
        protocol,
        cipher,
        certificateValid,
        alpn: alpn || undefined,
        possibleMitm,
        spkiSha256,
      });
    } catch (err) {
      finish({
        secure: false,
        certificateValid: false,
        possibleMitm: true,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      tlsSocket.destroy();
      plainSocket.destroy();
    }
  });

  tlsSocket.once("timeout", () => {
    tlsSocket.destroy();
    plainSocket.destroy();
    finish({
      secure: false,
      certificateValid: false,
      possibleMitm: false,
      error: `Timeout after ${timeoutMs}ms during TLS handshake`,
    });
  });

  tlsSocket.once("error", (err: Error & { code?: string }) => {
    tlsSocket.destroy();
    plainSocket.destroy();
    finish({
      secure: false,
      certificateValid: false,
      possibleMitm: false,
      error: err.message,
    });
  });

  return promise;
}
