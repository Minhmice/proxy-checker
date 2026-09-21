"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpDown,
  ArrowDown,
  ArrowUp,
  MoreVertical,
  Play,
  Pencil,
  Power,
  RotateCcw,
  Trash2,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth-provider";
import { ProxyHealthBadge } from "@/components/proxy-health-badge";
import { SyncProgressStrip } from "@/components/sync-progress-strip";
import {
  fetchPools,
  fetchStatus,
  formatTime,
  removePool,
  renamePool,
  restorePool,
  syncPools,
  testPools,
  togglePool,
} from "@/lib/api";
import type { PoolRecord, PoolStatus } from "@/lib/types";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type ProxiesTab = "active" | "reserve" | "removed";

function rowClass(pool: PoolRecord): string {
  const test = pool.testState ?? "idle";
  if (test === "checking") return "pool-row pool-row--checking";
  if (test === "queued" || pool.healthStatus === "pending") return "pool-row pool-row--pending";
  if (test === "retrying") return "pool-row pool-row--checking";
  if (pool.remoteState === "revived") return "pool-row pool-row--revived";
  if (pool.remoteState === "delete_failed") return "pool-row pool-row--resolved-dead";
  if (pool.status === "usable") return "pool-row pool-row--resolved-ok";
  if (pool.status === "dead") return "pool-row pool-row--resolved-dead";
  return "pool-row";
}

function countCodePoints(str: string): number {
  return Array.from(str).length;
}

export default function ProxiesPage() {
  const { password } = useAuth();
  const [tab, setTab] = useState<ProxiesTab>("active");
  const [pools, setPools] = useState<PoolRecord[]>([]);
  const [status, setStatus] = useState<PoolStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sort, setSort] = useState<{ key: "latency" | "status" | "checked"; direction: "asc" | "desc" }>({
    key: "latency",
    direction: "asc",
  });

  // Track previous pools to surface automatic server-side deletion toast
  const prevPoolsRef = useRef<Map<string, PoolRecord>>(new Map());

  // Action dialog states
  const [renameTarget, setRenameTarget] = useState<PoolRecord | null>(null);
  const [renameInput, setRenameInput] = useState("");
  const [renameError, setRenameError] = useState("");
  const [renameSubmitting, setRenameSubmitting] = useState(false);

  const [restoreTarget, setRestoreTarget] = useState<PoolRecord | null>(null);
  const [restoreSubmitting, setRestoreSubmitting] = useState(false);

  const [removeTarget, setRemoveTarget] = useState<PoolRecord | null>(null);
  const [removeSubmitting, setRemoveSubmitting] = useState(false);

  const syncing = status?.running ?? false;
  const anyItemTesting = useMemo(
    () => pools.some((p) => p.testState === "queued" || p.testState === "checking" || p.testState === "retrying"),
    [pools]
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!password) {
        setLoading(false);
        return;
      }
      try {
        const statusData = await fetchStatus(password, signal);
        // Fetch complete registry snapshot so transitions across tabs are always observable
        const allPoolsData = await fetchPools(password, "all", signal);

        // Detect automatic transition: linked -> removed on server side across all records
        const prevMap = prevPoolsRef.current;
        if (prevMap.size > 0) {
          for (const current of allPoolsData) {
            const before = prevMap.get(current.localId);
            if (before && before.remoteState === "linked" && current.remoteState === "removed") {
              toast.info("Removed from 9Router; kept locally for recovery");
            }
          }
        }
        const nextMap = new Map<string, PoolRecord>();
        for (const p of allPoolsData) nextMap.set(p.localId, p);
        prevPoolsRef.current = nextMap;

        setStatus(statusData);
        setPools(allPoolsData);
        setError("");
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [password, tab]
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    if (!password) return;
    const intervalMs = syncing || anyItemTesting ? 1200 : 15000;
    const timer = setInterval(() => load(controller.signal), intervalMs);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [password, load, syncing, anyItemTesting]);

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

  async function handleTestSingle(pool: PoolRecord) {
    if (!password) return;
    try {
      await testPools(password, [pool.localId]);
      toast.success(`Queued check for ${pool.name}`);
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function handleTestBatch() {
    if (!password || !selectedIds.length) return;
    try {
      const res = await testPools(password, selectedIds);
      toast.success(`Queued checks for ${res.accepted.length} proxy pool(s)`);
      if (res.busy.length > 0) {
        toast.message(`${res.busy.length} proxy pool(s) already in progress`);
      }
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function handleToggle(pool: PoolRecord) {
    if (!password || pool.testState === "checking" || pool.testState === "retrying") return;
    try {
      await togglePool(password, pool.localId, !pool.isActiveOnRouter);
      toast.success(pool.isActiveOnRouter ? "Deactivated on 9Router" : "Activated on 9Router");
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  // Rename modal logic
  function openRename(pool: PoolRecord) {
    setRenameTarget(pool);
    setRenameInput(pool.name);
    setRenameError("");
  }

  async function submitRename() {
    if (!password || !renameTarget) return;
    const trimmed = renameInput.trim();
    if (!trimmed) {
      setRenameError("Name cannot be empty");
      return;
    }
    if (countCodePoints(trimmed) > 100) {
      setRenameError("Name cannot exceed 100 characters");
      return;
    }
    setRenameSubmitting(true);
    setRenameError("");
    try {
      await renamePool(password, renameTarget.localId, trimmed);
      toast.success("Proxy pool renamed");
      setRenameTarget(null);
      await load();
    } catch (err) {
      setRenameError((err as Error).message);
    } finally {
      setRenameSubmitting(false);
    }
  }

  // Restore modal logic
  function openRestore(pool: PoolRecord) {
    setRestoreTarget(pool);
  }

  async function submitRestore() {
    if (!password || !restoreTarget) return;
    setRestoreSubmitting(true);
    try {
      await restorePool(password, restoreTarget.localId);
      toast.success("Proxy pool restored to Reserve (inactive)");
      setRestoreTarget(null);
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRestoreSubmitting(false);
    }
  }

  // Remove modal logic
  function openRemove(pool: PoolRecord) {
    setRemoveTarget(pool);
  }

  async function submitRemove(explicitTarget?: PoolRecord) {
    const target = explicitTarget ?? removeTarget;
    if (!password || !target) return;
    setRemoveSubmitting(true);
    try {
      await removePool(password, target.localId);
      toast.success("Removed from 9Router; kept locally for recovery");
      setRemoveTarget(null);
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRemoveSubmitting(false);
    }
  }

  async function handleRetryRemoval(pool: PoolRecord) {
    await submitRemove(pool);
  }

  const visiblePools = useMemo(() => {
    if (syncing) return pools;
    return pools.filter((p) => p.tier === tab);
  }, [pools, syncing, tab]);

  const sortedPools = useMemo(() => {
    return [...visiblePools].sort((a, b) => {
      let result = 0;
      if (sort.key === "latency") {
        const left = a.latency_ms ?? Number.MAX_SAFE_INTEGER;
        const right = b.latency_ms ?? Number.MAX_SAFE_INTEGER;
        result = left - right;
      } else if (sort.key === "status") {
        result = a.status.localeCompare(b.status);
      } else if (sort.key === "checked") {
        result = (a.checked_at || 0) - (b.checked_at || 0);
      }
      return sort.direction === "asc" ? result : -result;
    });
  }, [visiblePools, sort]);

  function changeSort(key: typeof sort.key) {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "asc" }
    );
  }

  function SortButton({ label, sortKey }: { label: string; sortKey: typeof sort.key }) {
    const active = sort.key === sortKey;
    const Icon = active ? (sort.direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
    return (
      <button
        type="button"
        className={`pool-sort ${active ? "pool-sort--active" : ""}`}
        onClick={() => changeSort(sortKey)}
      >
        {label}
        <Icon size={13} aria-hidden />
      </button>
    );
  }

  const selectablePools = visiblePools.filter(
    (pool) => pool.testState !== "checking" && pool.testState !== "retrying"
  );
  const allSelected =
    selectablePools.length > 0 &&
    selectablePools.every((pool) => selectedIds.includes(pool.localId));

  function toggleSelected(localId: string) {
    setSelectedIds((current) =>
      current.includes(localId) ? current.filter((id) => id !== localId) : [...current, localId]
    );
  }

  function toggleAll() {
    setSelectedIds(allSelected ? [] : selectablePools.map((pool) => pool.localId));
  }

  const subtitle = syncing
    ? `${pools.length} proxies loaded · health check in progress`
    : `${visiblePools.length} ${tab} pools shown${selectedIds.length ? ` · ${selectedIds.length} selected` : ""}`;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Proxies</h1>
          <p>{subtitle}</p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn--secondary"
            disabled={!password || syncing}
            onClick={handleSync}
          >
            Sync &amp; rank
          </button>
          <button type="button" className="btn btn--primary" disabled={!password} onClick={() => load()}>
            Refresh
          </button>
        </div>
      </div>

      <SyncProgressStrip status={status} />

      {error && (
        <div className="banner banner--error" role="alert">
          {error}
        </div>
      )}

      {!syncing && (
        <div className="filter-pills" style={{ marginBottom: 16 }} role="tablist" aria-label="Proxy tier">
          <button
            type="button"
            className={`filter-pill ${tab === "active" ? "filter-pill--active" : ""}`}
            role="tab"
            aria-selected={tab === "active"}
            onClick={() => {
              setTab("active");
              setSelectedIds([]);
            }}
          >
            Active
          </button>
          <button
            type="button"
            className={`filter-pill ${tab === "reserve" ? "filter-pill--active" : ""}`}
            role="tab"
            aria-selected={tab === "reserve"}
            onClick={() => {
              setTab("reserve");
              setSelectedIds([]);
            }}
          >
            Reserve
          </button>
          <button
            type="button"
            className={`filter-pill ${tab === "removed" ? "filter-pill--active" : ""}`}
            role="tab"
            aria-selected={tab === "removed"}
            onClick={() => {
              setTab("removed");
              setSelectedIds([]);
            }}
          >
            Removed
          </button>
        </div>
      )}

      {syncing && (
        <p className="sync-hint" role="status">
          Showing all proxies while health checks run. Tabs return when sync finishes.
        </p>
      )}

      {selectedIds.length > 0 && (
        <div className="pool-selection-bar" role="status">
          <strong>{selectedIds.length} selected</strong>
          <span>Run diagnostics on selected proxies.</span>
          <div className="pool-selection-actions">
            <button
              type="button"
              className="btn btn--secondary"
              onClick={handleTestBatch}
              disabled={syncing}
            >
              <Play size={13} aria-hidden />
              Test selected
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setSelectedIds([])}
            >
              Clear
            </button>
          </div>
        </div>
      )}

      <div className="pool-table-wrap">
        {loading && pools.length === 0 ? (
          <div className="table-empty">
            <div className="skeleton" style={{ width: "100%", height: 40, marginBottom: 8 }} />
            <div className="skeleton" style={{ width: "100%", height: 40 }} />
          </div>
        ) : visiblePools.length === 0 ? (
          <p className="table-empty">
            {tab === "removed"
              ? "No removed proxies found. Dead proxies removed from 9Router are retained here."
              : `No ${tab} proxies yet. Add authorized proxy endpoints, then run a sync.`}
          </p>
        ) : (
          <Table className="pool-table">
            <TableHeader>
              <TableRow>
                <TableHead className="pool-check-cell">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    disabled={!selectablePools.length}
                    aria-label="Select all available proxies"
                  />
                </TableHead>
                <TableHead>
                  <SortButton label="Proxy" sortKey="status" />
                </TableHead>
                <TableHead>
                  <SortButton label="Latency" sortKey="latency" />
                </TableHead>
                <TableHead>Uptime</TableHead>
                <TableHead>
                  <SortButton label="Last checked" sortKey="checked" />
                </TableHead>
                <TableHead>
                  <SortButton label="Health" sortKey="status" />
                </TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedPools.map((pool, index) => {
                const isTesting =
                  pool.testState === "checking" || pool.testState === "retrying";
                const isQueued =
                  pool.testState === "queued" || pool.healthStatus === "pending";
                const isSelected = selectedIds.includes(pool.localId);

                return (
                  <TableRow
                    key={pool.localId}
                    data-state={isSelected ? "selected" : undefined}
                    className={rowClass(pool)}
                    style={{ "--i": index } as React.CSSProperties}
                  >
                    <TableCell data-label="Select" className="pool-check-cell">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelected(pool.localId)}
                        disabled={isTesting}
                        aria-label={`Select ${pool.name}`}
                      />
                    </TableCell>

                    <TableCell data-label="Proxy" className="proxy-endpoint-cell">
                      <div className="proxy-identity">
                        <strong className="proxy-identity__name">{pool.name}</strong>
                        <span className="mono proxy-identity__endpoint">{pool.proxyUrl}</span>
                      </div>
                    </TableCell>

                    <TableCell
                      data-label="Latency"
                      className={isTesting ? "latency-cell latency-cell--live" : ""}
                    >
                      {isTesting ? (
                        <span className="latency-live">
                          <span className="metric-value-loader" aria-hidden />
                          <span className="sr-only">Measuring latency</span>
                        </span>
                      ) : pool.latency_ms != null ? (
                        <span
                          key={`latency-${pool.localId}-${pool.latency_ms}`}
                          className="metric-number--changed"
                        >
                          {pool.latency_ms} ms
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>

                    <TableCell
                      data-label="Uptime"
                      className={isTesting ? "metric-cell--live" : ""}
                    >
                      {isTesting ? (
                        <span className="metric-value-loader" aria-label="Measuring uptime" />
                      ) : (
                        <span
                          key={`uptime-${pool.localId}-${pool.successes}-${pool.failures}`}
                          className="metric-number--changed"
                        >
                          {pool.successes + pool.failures > 0
                            ? `${Math.round((pool.successes / (pool.successes + pool.failures)) * 100)}%`
                            : "—"}
                        </span>
                      )}
                    </TableCell>

                    <TableCell data-label="Last checked" className="text-muted">
                      {pool.checked_at ? formatTime(pool.checked_at) : "Never"}
                    </TableCell>

                    <TableCell data-label="Health">
                      <ProxyHealthBadge pool={pool} />
                    </TableCell>

                    <TableCell data-label="Action" className="pool-action-cell">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className="btn-icon"
                            aria-label={`Actions for ${pool.name}`}
                            disabled={isTesting}
                          >
                            <MoreVertical size={16} aria-hidden />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="pool-menu-content">
                          <DropdownMenuItem
                            onClick={() => handleTestSingle(pool)}
                            disabled={isTesting || isQueued}
                          >
                            <Play size={14} aria-hidden />
                            <span>Test now</span>
                          </DropdownMenuItem>

                          <DropdownMenuItem onClick={() => openRename(pool)} disabled={isTesting}>
                            <Pencil size={14} aria-hidden />
                            <span>Rename</span>
                          </DropdownMenuItem>

                          {pool.remoteState === "linked" && (
                            <DropdownMenuItem
                              onClick={() => handleToggle(pool)}
                              disabled={isTesting || isQueued}
                            >
                              <Power size={14} aria-hidden />
                              <span>{pool.isActiveOnRouter ? "Deactivate" : "Activate"}</span>
                            </DropdownMenuItem>
                          )}

                          {pool.remoteState === "revived" && (
                            <DropdownMenuItem onClick={() => openRestore(pool)} disabled={isTesting}>
                              <RotateCcw size={14} aria-hidden />
                              <span>Restore proxy</span>
                            </DropdownMenuItem>
                          )}

                          {pool.remoteState === "delete_failed" && (
                            <DropdownMenuItem
                              onClick={() => handleRetryRemoval(pool)}
                              disabled={isTesting}
                              className="text-error"
                            >
                              <RotateCcw size={14} aria-hidden />
                              <span>Retry removal</span>
                            </DropdownMenuItem>
                          )}

                          {pool.remoteState === "linked" && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => openRemove(pool)}
                                disabled={isTesting}
                                className="text-error"
                              >
                                <Trash2 size={14} aria-hidden />
                                <span>Remove</span>
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Rename Dialog */}
      <Dialog open={!!renameTarget} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename proxy pool</DialogTitle>
            <DialogDescription>
              Update the human-readable name for this proxy endpoint.
            </DialogDescription>
          </DialogHeader>
          <div className="dialog-field-body">
            <label htmlFor="rename-input" className="dialog-field-label">
              Pool name
            </label>
            <Input
              id="rename-input"
              value={renameInput}
              onChange={(e) => {
                setRenameInput(e.target.value);
                if (renameError) setRenameError("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitRename();
                }
              }}
              disabled={renameSubmitting}
              autoFocus
            />
            {renameError && (
              <p className="dialog-field-error" role="alert">
                {renameError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              onClick={() => setRenameTarget(null)}
              disabled={renameSubmitting}
            >
              Cancel
            </Button>
            <Button type="button" onClick={submitRename} disabled={renameSubmitting}>
              {renameSubmitting ? "Saving…" : "Save name"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Restore Dialog */}
      <Dialog open={!!restoreTarget} onOpenChange={(open) => !open && setRestoreTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore proxy pool</DialogTitle>
            <DialogDescription>
              Restore this revived proxy back to the active inventory.
            </DialogDescription>
          </DialogHeader>
          {restoreTarget && (
            <div className="dialog-confirm-content">
              <div className="dialog-kv">
                <span className="dialog-kv__label">Proxy name</span>
                <strong>{restoreTarget.name}</strong>
              </div>
              <div className="dialog-kv">
                <span className="dialog-kv__label">Endpoint</span>
                <span className="mono">{restoreTarget.proxyUrl}</span>
              </div>
              <div className="dialog-note banner--notice">
                <AlertTriangle size={14} aria-hidden />
                <span>Restoration starts inactive in the Reserve tier.</span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              onClick={() => setRestoreTarget(null)}
              disabled={restoreSubmitting}
            >
              Cancel
            </Button>
            <Button type="button" onClick={submitRestore} disabled={restoreSubmitting}>
              {restoreSubmitting ? "Restoring…" : "Confirm restore"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manual Remove Confirmation Dialog */}
      <Dialog open={!!removeTarget} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove proxy from 9Router</DialogTitle>
            <DialogDescription>
              This will remove the proxy route from 9Router. It will be kept locally in the Removed tab for recovery.
            </DialogDescription>
          </DialogHeader>
          {removeTarget && (
            <div className="dialog-confirm-content">
              <div className="dialog-kv">
                <span className="dialog-kv__label">Proxy name</span>
                <strong>{removeTarget.name}</strong>
              </div>
              <div className="dialog-kv">
                <span className="dialog-kv__label">Endpoint</span>
                <span className="mono">{removeTarget.proxyUrl}</span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              onClick={() => setRemoveTarget(null)}
              disabled={removeSubmitting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              type="button"
              onClick={() => submitRemove()}
              disabled={removeSubmitting}
            >
              {removeSubmitting ? "Removing…" : "Remove proxy"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
