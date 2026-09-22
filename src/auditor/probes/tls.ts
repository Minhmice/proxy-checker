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

  let certificateValid = false;
  let possibleMitm = false;
  let spkiSha256: string | undefined;

  const tlsSocket = tls.connect({
    socket: plainSocket,
    servername: host,
    rejectUnauthorized: false,
    timeout: timeoutMs,
  });

  tlsSocket.once("secureConnect", () => {
    try {
      const authError = tlsSocket.ssl?.verifyError?.();
      certificateValid = !authError && tlsSocket.authorized;

      if (options.rejectUnauthorized && authError) {
        certificateValid = false;
      }

      const cert = tlsSocket.getPeerCertificate(true);
      const rawCert = cert && (cert as unknown as { raw?: Buffer }).raw;
      if (rawCert) {
        spkiSha256 = computeSpkiSha256(rawCert);
      }

      const cipher = tlsSocket.getCipher()?.name;
      const protocol = tlsSocket.getProtocol() || undefined;
      const alpn = tlsSocket.alpnProtocol || undefined;

      if (options.expectedSpkiSha256 && spkiSha256) {
        if (spkiSha256.toLowerCase() !== options.expectedSpkiSha256.toLowerCase()) {
          possibleMitm = true;
          certificateValid = false;
        }
      }

      if (options.directCertFingerprint256 && cert.fingerprint256) {
        if (
          cert.fingerprint256.replace(/:/g, "").toLowerCase() !==
          options.directCertFingerprint256.replace(/:/g, "").toLowerCase()
        ) {
          possibleMitm = true;
        }
      }

      resolve({
        secure: true,
        protocol,
        cipher,
        certificateValid,
        alpn: alpn || undefined,
        possibleMitm,
        spkiSha256,
      });
    } catch (err) {
      resolve({
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
    tlsSocket.destroy(new Error(`Timeout after ${timeoutMs}ms during TLS handshake`));
  });

  tlsSocket.once("error", (err) => {
    tlsSocket.destroy();
    plainSocket.destroy();
    resolve({
      secure: false,
      certificateValid: false,
      possibleMitm: false,
      error: err.message,
    });
  });

  return promise;
}
