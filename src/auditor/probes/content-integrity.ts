import crypto from "node:crypto";
import type { ContentIntegrityResult, ParsedProxyInput } from "../types.js";
import { openProxyTunnel, requestThroughProxy } from "../transport/index.js";
import { probeTlsIntegrity } from "./tls.js";

export interface IntegrityOptions {
  endpoint: string;
  expectedBody?: string;
  expectedHmacSha256?: { secret: string; signatureHeader?: string };
  expectedSpkiSha256?: string;
  timeoutMs?: number;
  allowPrivateTargets?: boolean;
}

export async function probeContentIntegrity(
  proxy: ParsedProxyInput,
  options: IntegrityOptions
): Promise<ContentIntegrityResult & { spkiValid?: boolean; bodyMatches?: boolean }> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const parsed = new URL(options.endpoint);
  const host = parsed.hostname;
  const isHttps = parsed.protocol === "https:";
  const port = parsed.port ? Number(parsed.port) : isHttps ? 443 : 80;

  let spkiValid: boolean | undefined = undefined;

  if (isHttps && options.expectedSpkiSha256) {
    const tlsResult = await probeTlsIntegrity(proxy, {
      endpoint: options.endpoint,
      timeoutMs,
      allowPrivateTargets: options.allowPrivateTargets,
      expectedSpkiSha256: options.expectedSpkiSha256,
    });
    spkiValid = tlsResult.spkiSha256?.toLowerCase() === options.expectedSpkiSha256.toLowerCase();
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

  const { socket } = await openProxyTunnel(
    proxy,
    { host, port },
    {
      timeoutMs,
      allowPrivateTargets: options.allowPrivateTargets ?? false,
      targetDomain: host,
    }
  );

  try {
    const res = await requestThroughProxy(socket, {
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
    socket.destroy();
  }
}
