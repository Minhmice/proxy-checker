export type GoogleTransportStatus =
  | "unknown"
  | "tls_untrusted"
  | "proxy_unreachable"
  | "google_endpoint_reachable"
  | "google_endpoint_denied"
  | "passed";
export type AntigravityQuotaStatus =
  | "known"
  | "unknown"
  | "auth_expired"
  | "account_forbidden"
  | "transport_failed";
export interface ObservationRoute {
  routerUrl: string;
  accountId: string;
  proxyPoolId: string | null;
  bindingRevision: number;
  poolRevision: number | null;
}
export interface QuotaObservation extends ObservationRoute {
  status: AntigravityQuotaStatus;
  sessionPercentage: number | null;
  observedAt: number | null;
  fresh: boolean;
  stale: boolean;
  httpStatus: number | null;
  message: string | null;
  error: string | null;
}
export interface TransportObservation {
  routerUrl: string;
  proxyPoolId: string;
  endpoint: string;
  poolRevision: number;
  status: GoogleTransportStatus;
  httpStatus: number | null;
  errorCode: string | null;
  checkedAt: number;
  expiresAt: number;
}

export function classifyQuotaResponse(
  raw: Record<string, unknown>,
  route: ObservationRoute,
): QuotaObservation {
  const metadata =
    raw.observation && typeof raw.observation === "object"
      ? (raw.observation as Record<string, unknown>)
      : {};
  const quotas =
    raw.quotas && typeof raw.quotas === "object"
      ? (raw.quotas as Record<string, Record<string, unknown>>)
      : {};
  const session = quotas.gemini_session || quotas["gemini-session"];
  const value = session?.remainingPercentage;
  const sessionPercentage =
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
      ? value
      : null;
  const message = typeof raw.message === "string" ? raw.message : null;
  const error = typeof raw.error === "string" ? raw.error : null;
  const httpStatus = typeof metadata.httpStatus === "number" ? metadata.httpStatus : null;
  let status: AntigravityQuotaStatus = "unknown";
  if (metadata.transportError) status = "transport_failed";
  else if (httpStatus === 401) status = "auth_expired";
  else if (metadata.status === "account_forbidden" && httpStatus === 403 && metadata.reasonCode)
    status = "account_forbidden";
  else if (sessionPercentage !== null && !message && !error) status = "known";
  const observedAt = typeof metadata.observedAt === "number" ? metadata.observedAt : null;
  const fresh = status === "known" && metadata.fresh === true && raw.stale !== true;
  return {
    ...route,
    status,
    sessionPercentage: status === "known" ? sessionPercentage : null,
    observedAt,
    fresh,
    stale: !fresh,
    httpStatus,
    message,
    error,
  };
}

export function proxyEndpointKey(value: string): string {
  const url = new URL(value.includes("://") ? value : `http://${value}`);
  const protocol = url.protocol === "socks5h:" ? "socks5:" : url.protocol.toLowerCase();
  const defaults: Record<string, string> = { "http:": "80", "https:": "443", "socks5:": "1080" };
  if (!defaults[protocol]) throw new Error("Unsupported proxy protocol");
  return `${protocol}//${url.hostname.toLowerCase()}:${url.port || defaults[protocol]}`;
}
