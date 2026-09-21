"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpDown, ArrowDown, ArrowUp, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth-provider";
import { ProxyHealthBadge } from "@/components/proxy-health-badge";
import { SyncProgressStrip } from "@/components/sync-progress-strip";
import { fetchPools, fetchStatus, syncPools, togglePool } from "@/lib/api";
import type { PoolRecord, PoolStatus } from "@/lib/types";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function rowClass(pool: PoolRecord): string {
  const health = pool.healthStatus ?? "done";
  if (health === "checking") return "pool-row pool-row--checking";
  if (health === "pending") return "pool-row pool-row--pending";
  if (health === "done" && pool.status === "usable") return "pool-row pool-row--resolved-ok";
  if (health === "done" && pool.status === "dead") return "pool-row pool-row--resolved-dead";
  return "pool-row";
}

export default function ProxiesPage() {
  const { password } = useAuth();
  const [tab, setTab] = useState<"active" | "reserve">("active");
  const [pools, setPools] = useState<PoolRecord[]>([]);
  const [status, setStatus] = useState<PoolStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sort, setSort] = useState<{ key: "latency" | "status"; direction: "asc" | "desc" }>({ key: "latency", direction: "asc" });
  const [refreshingIds, setRefreshingIds] = useState<string[]>([]);

  const syncing = status?.running ?? false;

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!password) {
      setLoading(false);
      return;
    }
    try {
      const statusData = await fetchStatus(password, signal);
      const tier = statusData.running ? "all" : tab === "reserve" ? "reserve" : "active";
      const poolsData = await fetchPools(password, tier, signal);
      setStatus(statusData);
      setPools(poolsData);
      setError("");
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [password, tab]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    if (!password) return;
    const intervalMs = syncing ? 1200 : 15000;
    const timer = setInterval(() => load(controller.signal), intervalMs);
    return () => { controller.abort(); clearInterval(timer); };
  }, [password, load, syncing]);

  async function handleSync() {
    if (!password) return;
    try {
      await syncPools(password);
      toast.message("Sync started — proxies appear first, then health checks run");
      setTimeout(load, 400);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function handleRefresh(pool: PoolRecord) {
    if (!password || refreshingIds.includes(pool.id) || syncing) return;
    setRefreshingIds((current) => [...current, pool.id]);
    try {
      await load();
      toast.success(`Refreshed ${pool.name}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRefreshingIds((current) => current.filter((id) => id !== pool.id));
    }
  }

  async function handleToggle(pool: PoolRecord) {
    if (!password || pool.healthStatus === "pending" || pool.healthStatus === "checking") return;
    try {
      await togglePool(password, pool.id, !pool.isActiveOnRouter);
      toast.success(pool.isActiveOnRouter ? "Deactivated on 9Router" : "Activated on 9Router");
      load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  const visibleCount = useMemo(() => {
    if (syncing) return pools.length;
    return pools.filter((pool) => pool.tier === tab).length;
  }, [pools, syncing, tab]);

  const sortedPools = useMemo(() => [...pools].sort((a, b) => {
    const values: Record<typeof sort.key, [string | number, string | number]> = {
      latency: [a.latency_ms ?? Number.MAX_SAFE_INTEGER, b.latency_ms ?? Number.MAX_SAFE_INTEGER],
      status: [a.status, b.status],
    };
    const [left, right] = values[sort.key];
    const result = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
    return sort.direction === "asc" ? result : -result;
  }), [pools, sort]);

  function changeSort(key: typeof sort.key) {
    setSort((current) => current.key === key ? { key, direction: current.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" });
  }

  function SortButton({ label, sortKey }: { label: string; sortKey: typeof sort.key }) {
    const active = sort.key === sortKey;
    const Icon = active ? sort.direction === "asc" ? ArrowUp : ArrowDown : ArrowUpDown;
    return <button type="button" className={`pool-sort ${active ? "pool-sort--active" : ""}`} onClick={() => changeSort(sortKey)}>{label}<Icon size={13} aria-hidden /></button>;
  }

  const selectablePools = pools.filter((pool) => pool.healthStatus !== "pending" && pool.healthStatus !== "checking");
  const allSelected = selectablePools.length > 0 && selectablePools.every((pool) => selectedIds.includes(pool.id));

  function toggleSelected(id: string) {
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  function toggleAll() {
    setSelectedIds(allSelected ? [] : selectablePools.map((pool) => pool.id));
  }

  const subtitle = syncing
    ? `${pools.length} proxies loaded · health check in progress`
    : `${visibleCount} ${tab} pools shown${selectedIds.length ? ` · ${selectedIds.length} selected` : ""}`;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Proxies</h1>
          <p>{subtitle}</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn--secondary" disabled={!password || syncing} onClick={handleSync}>
            Sync &amp; rank
          </button>
          <button type="button" className="btn btn--primary" disabled={!password} onClick={() => load()}>
            Refresh
          </button>
        </div>
      </div>

      <SyncProgressStrip status={status} />

      {error && <div className="banner banner--error" role="alert">{error}</div>}
      {!syncing && (
        <div className="filter-pills" style={{ marginBottom: 16 }} role="tablist" aria-label="Proxy status">
          <button
            type="button"
            className={`filter-pill ${tab === "active" ? "filter-pill--active" : ""}`}
            role="tab"
            aria-selected={tab === "active"}
            onClick={() => setTab("active")}
          >
            Active
          </button>
          <button
            type="button"
            className={`filter-pill ${tab === "reserve" ? "filter-pill--active" : ""}`}
            role="tab"
            aria-selected={tab === "reserve"}
            onClick={() => setTab("reserve")}
          >
            Reserve
          </button>
        </div>
      )}

      {syncing && (
        <p className="sync-hint" role="status">
          Showing all proxies while health checks run. Tabs return when sync finishes.
        </p>
      )}

      {selectedIds.length > 0 && <div className="pool-selection-bar" role="status"><strong>{selectedIds.length} selected</strong><span>Choose Activate or Deactivate per row.</span><button type="button" className="btn btn--ghost" onClick={() => setSelectedIds([])}>Clear selection</button></div>}

      <div className="pool-table-wrap">
        {loading && pools.length === 0 ? (
          <div className="table-empty">
            <div className="skeleton" style={{ width: "100%", height: 40, marginBottom: 8 }} />
            <div className="skeleton" style={{ width: "100%", height: 40 }} />
          </div>
        ) : pools.length === 0 ? (
          <p className="table-empty">
            No {tab} proxies yet. Add authorized proxy endpoints, then run a sync.
          </p>
        ) : (
          <Table className="pool-table">
            <TableHeader>
              <TableRow>
                <TableHead className="pool-check-cell"><input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={!selectablePools.length} aria-label="Select all available proxies" /></TableHead>
                <TableHead><SortButton label="Proxy" sortKey="status" /></TableHead>
                <TableHead><SortButton label="Latency" sortKey="latency" /></TableHead>
                <TableHead>Uptime</TableHead>
                <TableHead>Speed</TableHead>
                <TableHead><SortButton label="Health" sortKey="status" /></TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedPools.map((pool, index) => {
                const checking = pool.healthStatus === "checking";
                const pending = pool.healthStatus === "pending";
                return (
                  <TableRow
                    key={pool.id}
                    data-state={selectedIds.includes(pool.id) ? "selected" : undefined}
                    className={rowClass(pool)}
                    style={{ "--i": index } as React.CSSProperties}
                  >
                    <TableCell data-label="Select" className="pool-check-cell"><input type="checkbox" checked={selectedIds.includes(pool.id)} onChange={() => toggleSelected(pool.id)} disabled={pending || checking} aria-label={`Select ${pool.name}`} /></TableCell>
                    <TableCell data-label="Proxy URL" className="mono proxy-endpoint"><span>{pool.proxyUrl}</span></TableCell>
                    <TableCell data-label="Latency" className={checking ? "latency-cell latency-cell--live" : ""}>
                      {checking ? (
                        <span className="latency-live">
                          <span className="metric-value-loader" aria-hidden />
                          <span className="sr-only">Measuring latency</span>
                        </span>
                      ) : pool.latency_ms != null ? (
                        <span key={`latency-${pool.id}-${pool.latency_ms}`} className="metric-number--changed">{pool.latency_ms} ms</span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell data-label="Uptime" className={checking ? "metric-cell--live" : ""}>
                      {checking ? <span className="metric-value-loader" aria-label="Measuring uptime" /> : <span key={`uptime-${pool.id}-${pool.successes}-${pool.failures}`} className="metric-number--changed">{pool.successes + pool.failures > 0 ? `${Math.round((pool.successes / (pool.successes + pool.failures)) * 100)}%` : "—"}</span>}
                    </TableCell>
                    <TableCell data-label="Speed" className={checking ? "metric-cell--live" : ""}>
                      {checking ? <span className="metric-value-loader" aria-label="Measuring speed" /> : <span key={`speed-${pool.id}-${pool.latency_ms}`} className="metric-number--changed">{pool.latency_ms != null ? `${Math.max(0.1, Number((1000 / pool.latency_ms).toFixed(1))).toFixed(1)} Mbps` : "—"}</span>}
                    </TableCell>
                    <TableCell data-label="Health">
                      <ProxyHealthBadge pool={pool} />
                    </TableCell>
                    <TableCell data-label="Action">
                      <button
                        type="button"
                        className={pool.isActiveOnRouter ? "btn btn--secondary" : "btn btn--primary"}
                        disabled={pending || checking}
                        onClick={() => handleToggle(pool)}
                      >
                        {pending || checking ? "Wait…" : pool.isActiveOnRouter ? "Deactivate" : "Activate"}
                      </button>
                      <button type="button" className="pool-refresh-action" disabled={pending || checking || syncing || refreshingIds.includes(pool.id)} onClick={() => handleRefresh(pool)} aria-label={`Refresh ${pool.name}`}>
                        <RefreshCw size={14} className={refreshingIds.includes(pool.id) ? "ops-spin" : ""} aria-hidden />
                      </button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </>
  );
}
