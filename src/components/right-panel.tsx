"use client";

import Link from "next/link";
import { Activity, AlertTriangle, CheckCircle2, Clock3, Gauge, Play, RefreshCw, ShieldAlert, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "./auth-provider";
import { fetchMetrics, fetchPools, fetchStatus, formatTime, syncPools } from "@/lib/api";
import type { ActivityEntry, MetricsSnapshot, PoolRecord, PoolStatus } from "@/lib/types";

function TrendLine({ trend, positive }: { trend: { direction: "up" | "down"; value: number } | null; positive: "up" | "down" }) {
  if (!trend) return null;
  const isPositive = trend.direction === positive;
  return <span className={`ops-trend ops-trend--${isPositive ? "good" : "bad"}`} aria-label={`${trend.direction} ${trend.value}`}>
    <span aria-hidden="true">{trend.direction === "up" ? "↗" : "↘"}</span> {trend.value}
  </span>;
}

export function RightPanel() {
  const { password } = useAuth();
  const [status, setStatus] = useState<PoolStatus | null>(null);
  const [pools, setPools] = useState<PoolRecord[]>([]);
  const [metrics, setMetrics] = useState<MetricsSnapshot[]>([]);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!password) return;
    setLoading(true);
    try {
      const [statusData, poolData, metricData] = await Promise.all([
        fetchStatus(password, signal),
        fetchPools(password, undefined, signal),
        fetchMetrics(password, 24, signal),
      ]);
      setStatus(statusData);
      setPools(poolData);
      setMetrics(metricData);
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      setNotice((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [password]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    if (!password) return;
    const intervalMs = status?.running ? 3000 : 15000;
    const timer = setInterval(() => load(controller.signal), intervalMs);
    return () => { controller.abort(); clearInterval(timer); };
  }, [load, password, status?.running]);

  async function handleSync() {
    if (!password) return;
    try {
      await syncPools(password);
      setNotice("Sync started");
      setTimeout(load, 1500);
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  const attention = useMemo(() => {
    const items: Array<{ label: string; detail: string; href: string; tone: "warning" | "error" }> = [];
    if (status?.stats.dead) {
      items.push({
        label: `${status.stats.dead} dead proxies`,
        detail: "Review failed routes",
        href: "/proxies",
        tone: "error",
      });
    }
    if (status?.lastError) {
      items.push({
        label: "Sync reported an error",
        detail: status.lastError,
        href: "/proxies",
        tone: "warning",
      });
    }
    if (status && !status.configured) {
      items.push({
        label: "9Router not configured",
        detail: "Open Settings to add credentials",
        href: "/settings",
        tone: "warning",
      });
    }
    return items;
  }, [status]);

  const latest = metrics.at(-1);
  const previous = metrics.at(-2);
  const trend = (current?: number, prior?: number) => {
    if (current == null || prior == null || current === prior) return null;
    return { direction: current > prior ? "up" : "down", value: Math.abs(current - prior) } as const;
  };
  const activity = status?.activity ?? [];
  const progress = status?.syncProgress;
  const progressLabel = useMemo(() => {
    if (!status?.running || !progress) return null;
    if (progress.phase === "login") return "Logging into 9Router…";
    if (progress.phase === "fetch") return progress.remoteTotal
      ? `Fetched ${progress.remoteTotal} pools from 9Router`
      : "Fetching proxy pools…";
    if (progress.phase === "check" && progress.total > 0) {
      return `Health-checking ${progress.checked}/${progress.total} proxies…`;
    }
    if (progress.phase === "rank") return "Ranking proxies by latency…";
    if (progress.phase === "activate") return "Updating active pools on 9Router…";
    if (progress.phase === "done") return "Finishing sync…";
    return "Sync in progress…";
  }, [progress, status?.running]);

  function formatLogTime(at: number) {
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function activityDotClass(level: ActivityEntry["level"]) {
    if (level === "error") return "status-dot--error";
    if (level === "warn") return "status-dot--warn";
    if (level === "success") return "status-dot--ok";
    return "status-dot--running";
  }

  return (
    <aside className="right-panel operations-rail" aria-label="Operations rail">
      <section className="right-card ops-card">
        <div className="ops-card-heading">
          <div>
            <span className="ops-kicker">Fleet health</span>
            <h2>Pool status</h2>
          </div>
          <span className={`ops-health-dot ${status && !status.lastError ? "ops-health-dot--good" : "ops-health-dot--warn"}`} />
        </div>
        <div className="ops-health-grid">
          <div>
            <strong className="ops-number ops-number--green">{status?.stats.active ?? "—"}</strong>
            <TrendLine trend={trend(latest?.active, previous?.active)} positive="up" />
            <span>Active</span>
          </div>
          <div>
            <strong className="ops-number ops-number--blue">{status?.stats.reserve ?? "—"}</strong>
            <span>Reserve</span>
          </div>
          <div>
            <strong className="ops-number ops-number--red">{status?.stats.dead ?? "—"}</strong>
            <TrendLine trend={trend(latest?.dead, previous?.dead)} positive="down" />
            <span>Dead</span>
          </div>
          <div>
            <strong className="ops-number">{latest?.avgLatencyMs ?? "—"}<small>{latest?.avgLatencyMs ? " ms" : ""}</small></strong>
            <span>Avg latency</span>
          </div>
        </div>
      </section>

      <section className="right-card ops-card">
        <div className="ops-card-heading">
          <div>
            <span className="ops-kicker">Scheduler</span>
            <h2>Sync status</h2>
          </div>
          <RefreshCw size={16} className={status?.running ? "ops-spin" : ""} aria-hidden />
        </div>
        <div className="ops-status-line">
          <span className={`status-dot ${status?.running ? "status-dot--running" : status?.lastError ? "status-dot--error" : "status-dot--ok"}`} />
          <strong>{status?.running ? "Sync running" : status?.lastError ? "Needs attention" : "Healthy"}</strong>
        </div>
        <div className="ops-meta-list">
          <span><Clock3 size={14} /> Last sync <b>{status?.lastSyncAt ? formatTime(status.lastSyncAt) : "Never"}</b></span>
          <span><Activity size={14} /> Next sync <b>{status?.syncIntervalMinutes ?? 60} min interval</b></span>
        </div>
        <button type="button" className="btn btn--primary btn--full" disabled={!password || status?.running} onClick={handleSync}>
          <Play size={14} fill="currentColor" /> Sync now
        </button>
      </section>

      <section className="right-card ops-card">
        <div className="ops-card-heading">
          <div>
            <span className="ops-kicker">Attention needed</span>
            <h2>{attention.length ? `${attention.length} items` : "All clear"}</h2>
          </div>
          {attention.length ? <ShieldAlert size={16} className="text-warning" /> : <CheckCircle2 size={16} className="text-success" />}
        </div>
        {attention.length ? (
          <ul className="ops-alert-list">
            {attention.map((item) => (
              <li key={item.label}>
                <Link href={item.href} className="ops-alert-item">
                  <AlertTriangle size={14} className={item.tone === "error" ? "text-error" : "text-warning"} />
                  <span><strong>{item.label}</strong><small>{item.detail}</small></span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ops-muted">No failed routes or pending configuration.</p>
        )}
      </section>

      <section className="right-card ops-card">
        <div className="ops-card-heading">
          <div>
            <span className="ops-kicker">Shortcuts</span>
            <h2>Quick actions</h2>
          </div>
          <Zap size={16} className="text-primary" />
        </div>
        <div className="ops-action-list">
          <Link href="/proxies" className="ops-action"><Gauge size={15} /> Review proxy pool <span>→</span></Link>
          <button type="button" className="ops-action" onClick={handleSync} disabled={!password || status?.running}><RefreshCw size={15} /> Run full sync <span>→</span></button>
        </div>
      </section>

      <section className="right-card ops-card ops-activity-card">
        <div className="ops-card-heading">
          <div>
            <span className="ops-kicker">Recent activity</span>
            <h2>System log</h2>
          </div>
          {status?.running && <RefreshCw size={14} className="ops-spin text-primary" aria-hidden />}
        </div>
        {progressLabel && (
          <div className="ops-activity-item ops-activity-item--progress">
            <span className="status-dot status-dot--running" />
            <span>{progressLabel}</span>
          </div>
        )}
        {activity.length > 0 ? (
          <ul className="ops-activity-list" aria-live="polite">
            {activity.map((entry) => (
              <li key={entry.id} className={`ops-activity-item ops-activity-item--${entry.level}`}>
                <span className={`status-dot ${activityDotClass(entry.level)}`} />
                <span className="ops-activity-text">
                  <time dateTime={new Date(entry.at).toISOString()}>{formatLogTime(entry.at)}</time>
                  <span>{entry.message}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="ops-activity-item">
            <span className="status-dot status-dot--ok" />
            <span>{status?.lastSyncAt ? `Last sync ${formatTime(status.lastSyncAt)}` : "No sync recorded yet"}</span>
          </div>
        )}
        {loading && !status?.running && (
          <div className="ops-activity-item">
            <span className="status-dot status-dot--running" />
            <span>Refreshing live data…</span>
          </div>
        )}
        {notice && <div className="ops-notice" role="status" aria-live="polite">{notice}</div>}
      </section>
    </aside>
  );
}
