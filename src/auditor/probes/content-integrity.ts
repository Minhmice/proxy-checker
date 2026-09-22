import crypto from "node:crypto";
import type net from "node:net";
import tls from "node:tls";
import type { ContentIntegrityResult, ParsedProxyInput } from "../types.js";
import { openProxyTunnel, requestThroughProxy } from "../transport/index.js";
import { computeSpkiSha256 } from "./tls.js";

export interface IntegrityOptions {
  endpoint: string;
  expectedBody?: string;
  expectedHmacSha256?: { secret: string; signatureHeader?: string };
  expectedSpkiSha256?: string;
  timeoutMs?: number;
  allowPrivateTargets?: boolean;
  ca?: string | Buffer;
  signal?: AbortSignal;
}

export async function probeContentIntegrity(
  proxy: ParsedProxyInput,
  options: IntegrityOptions
): Promise<ContentIntegrityResult & { spkiValid?: boolean; bodyMatches?: boolean }> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const parsed = new URL(options.endpoint);
  const host = parsed.hostname;
  const isHttps = parsed.protocol === "https:";

  if (!isHttps) {
    throw new Error("Content integrity probe requires HTTPS endpoint");
  }

  const port = parsed.port ? Number(parsed.port) : 443;

  const { socket: rawSocket } = await openProxyTunnel(
    proxy,
    { host, port },
    {
      timeoutMs,
      allowPrivateTargets: options.allowPrivateTargets ?? false,
      targetDomain: host,
      signal: options.signal,
    }
  );

  let appSocket: net.Socket = rawSocket;
  let spkiValid: boolean | undefined = undefined;

  try {
    const { promise: pTls, resolve: resTls, reject: rejTls } = Promise.withResolvers<tls.TLSSocket>();
    const tlsSocket = tls.connect({
      socket: rawSocket,
      servername: host,
      rejectUnauthorized: true,
      ca: options.ca,
      timeout: timeoutMs,
    });

    tlsSocket.once("secureConnect", () => resTls(tlsSocket));
    tlsSocket.once("timeout", () => {
      tlsSocket.destroy();
      rawSocket.destroy();
      rejTls(new Error(`Timeout after ${timeoutMs}ms waiting for TLS handshake`));
    });
    tlsSocket.once("error", (err) => {
      tlsSocket.destroy();
      rawSocket.destroy();
      rejTls(err);
    });

    const secureSocket = await pTls;
    appSocket = secureSocket;

    if (options.expectedSpkiSha256) {
      const cert = secureSocket.getPeerCertificate(true);
      let actualSpki: string | undefined = undefined;
      if (cert && typeof cert === "object" && "raw" in cert && Buffer.isBuffer(cert.raw)) {
        actualSpki = computeSpkiSha256(cert.raw);
      }
      spkiValid = actualSpki?.toLowerCase() === options.expectedSpkiSha256.toLowerCase();
      if (!spkiValid) {
        return {
          intact: false,
          injectedScripts: [],
          modifiedHeaders: [],
          tlsStripping: false,
          spkiValid: false,
          error: "SPKI hash mismatch",
        };
      }
    }

    const res = await requestThroughProxy(appSocket, {
      host,
      path: parsed.pathname + parsed.search,
      method: "GET",
      timeoutMs,
    });

    let bodyMatches = true;
    if (options.expectedBody !== undefined) {
      bodyMatches = res.body === options.expectedBody;
    }

    if (options.expectedHmacSha256) {
      const headerName = (options.expectedHmacSha256.signatureHeader || "x-signature").toLowerCase();
      const sig = res.headers[headerName];
      const hmac = crypto
        .createHmac("sha256", options.expectedHmacSha256.secret)
        .update(res.body)
        .digest("hex");
      if (!sig || sig.toLowerCase() !== hmac.toLowerCase()) {
        bodyMatches = false;
      }
    }

    const injectedScripts: string[] = [];
    const scriptMatches = res.body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi);
    for (const match of scriptMatches) {
      if (match[0]) injectedScripts.push(match[0]);
    }

    const intact = bodyMatches && injectedScripts.length === 0;

    return {
      intact,
      injectedScripts,
      modifiedHeaders: [],
      tlsStripping: false,
      bodyMatches,
      spkiValid,
    };
  } finally {
    appSocket.destroy();
    rawSocket.destroy();
  }
}
