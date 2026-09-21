"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { MetricCard } from "@/components/metric-card";
import { ProxyHealthBadge } from "@/components/proxy-health-badge";
import { useAuth } from "@/components/auth-provider";
import { fetchMetrics, fetchPools, fetchStatus, formatTime, syncPools } from "@/lib/api";
import type { MetricsSnapshot, PoolRecord, PoolStatus } from "@/lib/types";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const TrafficChart = dynamic(() => import("@/components/traffic-chart").then((module) => module.TrafficChart), {
  ssr: false,
  loading: () => <div className="chart-card chart-card--loading" aria-busy="true"><div className="skeleton" /></div>,
});

export default function OverviewPage() {
  const { password } = useAuth();
  const [status, setStatus] = useState<PoolStatus | null>(null);
  const [metrics, setMetrics] = useState<MetricsSnapshot[]>([]);
  const [pools, setPools] = useState<PoolRecord[]>([]);
  const [selectedPoolId, setSelectedPoolId] = useState<string | null>(null);
  const [hours, setHours] = useState(24);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!password) {
      setLoading(false);
      return;
    }
    try {
      const [statusData, metricsData, poolsData] = await Promise.all([
        fetchStatus(password, signal),
        fetchMetrics(password, hours, signal),
        fetchPools(password, "active", signal),
      ]);
      setStatus(statusData);
      setMetrics(metricsData);
      setPools(poolsData);
      setSelectedPoolId((current) => poolsData.some((pool) => pool.id === current) ? current : poolsData[0]?.id ?? null);
      setError("");
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [password, hours]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    if (!password) return;
    const timer = setInterval(() => load(controller.signal), 15000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [password, load]);

  async function handleSync() {
    if (!password) return;
    setNotice("");
    try {
      await syncPools(password);
      setNotice("Sync started. Ranking the fastest proxies and updating 9Router…");
      window.setTimeout(() => load(), 1500);
    } catch (err) {
      setNotice((err as Error).message);
    }
  }

  const sparkActive = useMemo(() => metrics.map((m) => m.active), [metrics]);
  const sparkReserve = useMemo(() => metrics.map((m) => m.reserve), [metrics]);
  const sparkDead = useMemo(() => metrics.map((m) => m.dead), [metrics]);
  const selectedPool = pools.find((pool) => pool.id === selectedPoolId) ?? null;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p>Monitor your proxy pool health and sync status</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn--secondary" disabled={!password || status?.running} onClick={handleSync}>
            Sync &amp; rank top 50
          </button>
          <button type="button" className="btn btn--primary" disabled={!password} onClick={() => load()}>
            Refresh
          </button>
        </div>
      </div>

      {error && <div className="banner banner--error" role="alert">{error}</div>}
      {notice && <div className="banner banner--notice" role="status" aria-live="polite">{notice}</div>}
      {!status?.configured && password && (
        <div className="banner banner--warn">Set NINEROUTER_PASSWORD in .env (9Router dashboard login password) to sync pools.</div>
      )}

      {loading ? (
        <div className="metrics-row">
          {[1, 2, 3].map((i) => (
            <div key={i} className="metric-card">
              <div className="skeleton" style={{ width: "60%" }} />
              <div className="skeleton" style={{ width: "40%", marginTop: 12, height: 28 }} />
            </div>
          ))}
        </div>
      ) : (
        <div className="metrics-row">
          <MetricCard
            label="Active Proxies"
            value={status?.stats.active ?? 0}
            sub={`Top ${status?.activeLimit ?? 50} on 9Router`}
            delta={sparkActive.length > 1 ? `${sparkActive.at(-1)! - sparkActive.at(-2)! >= 0 ? "+" : ""}${sparkActive.at(-1)! - sparkActive.at(-2)!}` : undefined}
            sparkData={sparkActive}
            sparkColor="oklch(0.62 0.19 255)"
          />
          <MetricCard
            label="Reserve Proxies"
            value={status?.stats.reserve ?? 0}
            sub="Online, slower"
            sparkData={sparkReserve}
            sparkColor="oklch(0.58 0.22 295)"
          />
          <MetricCard
            label="Dead Proxies"
            value={status?.stats.dead ?? 0}
            sub="Hidden from routing"
            sparkData={sparkDead}
            sparkColor="oklch(0.72 0.14 195)"
          />
        </div>
      )}

      <TrafficChart snapshots={metrics} hours={hours} onHoursChange={setHours} />

      <section className="dashboard-proxies" aria-labelledby="dashboard-proxies-title">
        <div className="dashboard-proxies__header">
          <div>
            <h2 id="dashboard-proxies-title">Active proxies</h2>
            <p>Choose a route to inspect current health.</p>
          </div>
          <Link href="/proxies" className="btn btn--secondary">View all</Link>
        </div>
        {loading && pools.length === 0 ? (
          <div className="dashboard-proxies__empty"><div className="skeleton" style={{ width: "100%", height: 80 }} /></div>
        ) : pools.length === 0 ? (
          <p className="dashboard-proxies__empty">No active proxies yet. Run a sync to build a routed pool.</p>
        ) : (
          <div className="dashboard-proxies__body">
            <div className="dashboard-proxy-table-wrap">
              <table className="dashboard-proxy-table">
                <thead><tr><th>Name</th><th>Latency</th><th>Exit IP</th><th>Health</th></tr></thead>
                <tbody>
                  {pools.slice(0, 8).map((pool) => (
                    <tr key={pool.id} className={pool.id === selectedPool?.id ? "is-selected" : ""}>
                      <td><button type="button" onClick={() => setSelectedPoolId(pool.id)} aria-pressed={pool.id === selectedPool?.id}><span>{pool.name}</span><small className="mono">{pool.proxyUrl}</small></button></td>
                      <td>{pool.latency_ms == null ? "—" : `${pool.latency_ms} ms`}</td>
                      <td className="mono">{pool.exit_ip || "—"}</td>
                      <td><ProxyHealthBadge pool={pool} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {selectedPool && (
              <aside className="dashboard-proxy-detail" aria-live="polite">
                <span className="dashboard-proxy-detail__label">Selected route</span>
                <strong>{selectedPool.name}</strong>
                <span className="mono dashboard-proxy-detail__url">{selectedPool.proxyUrl}</span>
                <dl>
                  <div><dt>Latency</dt><dd>{selectedPool.latency_ms == null ? "Not measured" : `${selectedPool.latency_ms} ms`}</dd></div>
                  <div><dt>Exit IP</dt><dd className="mono">{selectedPool.exit_ip || "Unavailable"}</dd></div>
                  <div><dt>Checks</dt><dd>{selectedPool.successes} passed · {selectedPool.failures} failed</dd></div>
                </dl>
                {selectedPool.last_error && <p className="dashboard-proxy-detail__error">{selectedPool.last_error}</p>}
              </aside>
            )}
          </div>
        )}
      </section>

      <div className="bottom-row">
        <div className="info-card">
          <h3>Pool routing</h3>
          <ul>
            <li>Active proxies handle current traffic</li>
            <li>Reserve proxies are healthy but slower</li>
            <li>Dead proxies stay out of routing</li>
            <li>Ranking refreshes every {status?.syncIntervalMinutes ?? 60} minutes</li>
          </ul>
          <Link href="/proxies" className="btn btn--secondary">
            Review proxy pool
          </Link>
        </div>
        <div className="info-card">
          <h3>Latest sync</h3>
          <p style={{ color: "var(--muted)", fontSize: "0.9rem", margin: "0 0 12px" }}>
            {status?.running ? "Sync in progress…" : formatTime(status?.lastSyncAt ?? null)}
          </p>
          {status?.lastError && <div className="banner banner--error" role="alert">{status.lastError}</div>}
          <button type="button" className="btn btn--primary" disabled={!password || status?.running} onClick={handleSync}>
            Run Sync Now
          </button>
        </div>
      </div>
    </>
  );
}
