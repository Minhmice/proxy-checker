
export interface ProxyAuditOptions {
  timeoutMs?: number;
  attempts?: number;
  baseline?: boolean;
  reputation?: boolean;
  browser?: boolean;
  allowPrivateTargets?: boolean;
  signal?: AbortSignal;
  endpoints?: readonly string[];
  headerEndpoint?: string;
  tlsEndpoint?: string;
  controlEndpoint?: string;
  controlSpkiSha256?: string;
  controlExpectedBody?: string;
  controlHmacKey?: string;
  ca?: string | Buffer;
  providerKeys?: {
    ipinfo?: string;
    ipqs?: string;
    abuseipdb?: string;
  };
  cachePath?: string;
  concurrency?: number;
}

export interface BrowserAuditOptions {
  timeoutMs?: number;
  allowPrivateTargets?: boolean;
  signal?: AbortSignal;
  expectedExitIp?: string;
  baselinePublicIp?: string;
  stunServers?: readonly string[];
  endpoint?: string;
  endpoints?: readonly string[];
}

export * from "./types.js";
export { checkProxy } from "./api.js";
export { auditProxyInBrowser } from "./browser/api.js";
