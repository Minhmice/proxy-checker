import type { ProxyIntelligenceDb } from "../server/proxy-intelligence-db.js";
import {
  auditRouterGooglePool,
  getSafetyCapabilities,
  listPools,
  type NineRouterRequestOverrides,
} from "../server/nine-router-client.js";
import type { TransportObservation } from "../server/antigravity-observation.js";

export function recordGoogleTransportObservation(
  db: ProxyIntelligenceDb,
  row: TransportObservation,
) {
  if (
    !row.routerUrl ||
    !row.proxyPoolId ||
    !Number.isSafeInteger(row.poolRevision) ||
    !Number.isFinite(row.checkedAt) ||
    row.expiresAt <= row.checkedAt
  )
    throw new Error("Invalid Google transport observation");
  const endpoint = new URL(row.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search)
    throw new Error("Unsafe observation endpoint");
  db.run(
    `INSERT INTO google_transport_observations VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(router_url,proxy_pool_id,endpoint,pool_revision) DO UPDATE SET
    status=excluded.status,http_status=excluded.http_status,error_code=excluded.error_code,
    checked_at=excluded.checked_at,expires_at=excluded.expires_at
    WHERE excluded.checked_at>=google_transport_observations.checked_at`,
    [
      row.routerUrl,
      row.proxyPoolId,
      row.endpoint,
      row.poolRevision,
      row.status,
      row.httpStatus,
      row.errorCode,
      row.checkedAt,
      row.expiresAt,
    ],
  );
}
export function getGoogleTransportObservations(
  db: ProxyIntelligenceDb,
  routerUrl: string,
  poolId: string,
  poolRevision: number,
): TransportObservation[] {
  return db
    .all<{
      router_url: string;
      proxy_pool_id: string;
      endpoint: string;
      pool_revision: number;
      status: TransportObservation["status"];
      http_status: number | null;
      error_code: string | null;
      checked_at: number;
      expires_at: number;
    }>(
      "SELECT * FROM google_transport_observations WHERE router_url=? AND proxy_pool_id=? AND pool_revision=?",
      [routerUrl, poolId, poolRevision],
    )
    .map((r) => ({
      routerUrl: r.router_url,
      proxyPoolId: r.proxy_pool_id,
      endpoint: r.endpoint,
      poolRevision: r.pool_revision,
      status: r.status,
      httpStatus: r.http_status,
      errorCode: r.error_code,
      checkedAt: r.checked_at,
      expiresAt: r.expires_at,
    }));
}
export async function auditRouterGooglePools(
  db: ProxyIntelligenceDb,
  targets: NineRouterRequestOverrides[],
) {
  const results = [];
  for (const target of targets) {
    try {
      const caps = await getSafetyCapabilities(target);
      if (caps.protocolVersion !== 1 || !caps.nodeLocalAudit) {
        results.push({ routerUrl: target.url, status: "unsupported" });
        continue;
      }
      const pools = (await listPools(target)).filter((p) => p.isActive);
      for (let i = 0; i < pools.length; i += 4)
        await Promise.all(
          pools.slice(i, i + 4).map(async (p) => {
            const existing = getGoogleTransportObservations(
              db,
              target.url || "",
              p.id,
              p.poolRevision || 1,
            );
            if (existing.length && existing.every((o) => o.expiresAt > Date.now())) return;
            const result = await auditRouterGooglePool(p.id, p.poolRevision || 1, target);
            for (const row of result.observations) recordGoogleTransportObservation(db, row);
          }),
        );
      results.push({ routerUrl: target.url, status: "audited" });
    } catch {
      results.push({ routerUrl: target.url, status: "unavailable" });
    }
  }
  return results;
}
