"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createColumnHelper,
  useTable,
  type ColumnFiltersState,
  type ColumnVisibilityState,
  type PaginationState,
  type SortingState,
} from "@tanstack/react-table";
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
  Search,
  SlidersHorizontal,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
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
  syncPools,
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
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
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
import { Checkbox } from "@/components/ui/checkbox";
import { tableConfigFeatures, type ProxiesTableFeatures } from "./data-table-features";

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

const columnHelper = createColumnHelper<ProxiesTableFeatures, PoolRecord>();

export default function ProxiesPage() {
  const { password } = useAuth();
  const [tab, setTab] = useState<ProxiesTab>("active");
  const [pools, setPools] = useState<PoolRecord[]>([]);
  const [status, setStatus] = useState<PoolStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // TanStack table state
  const [sorting, setSorting] = useState<SortingState>([
    { id: "latency_ms", desc: false },
  ]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityState>({});
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  });

  // Track previous pools to surface automatic server-side deletion toast
  const prevPoolsRef = useRef<Map<string, PoolRecord>>(new Map());
  const hasLoadedInitialRef = useRef(false);

  // Action dialog states
  const [renameTarget, setRenameTarget] = useState<PoolRecord | null>(null);
  const [renameInput, setRenameInput] = useState("");
  const [renameError, setRenameError] = useState("");
  const [renameSubmitting, setRenameSubmitting] = useState(false);


  const [removeTarget, setRemoveTarget] = useState<PoolRecord | null>(null);
  const [removeSubmitting, setRemoveSubmitting] = useState(false);

  const syncing = status?.running ?? false;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!password) {
        setLoading(false);
        return;
      }
      try {
        const statusData = await fetchStatus(password, signal);
        const allPoolsData = await fetchPools(password, "all", signal);

        const prevMap = prevPoolsRef.current;
        if (hasLoadedInitialRef.current) {
          for (const current of allPoolsData) {
            const before = prevMap.get(current.localId);
            const wasLinked = before && before.remoteState === "linked";
            const isNewlyObservedRemoved = !before && current.remoteState === "removed";
            if ((wasLinked || isNewlyObservedRemoved) && current.remoteState === "removed") {
              toast.info("Removed from 9Router; kept locally for recovery");
            }
          }
        }
        hasLoadedInitialRef.current = true;
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
    [password]
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    if (!password) return;
    const intervalMs = syncing ? 1200 : 15000;
    const timer = setInterval(() => load(controller.signal), intervalMs);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [password, load, syncing]);

  async function handleSync() {
    if (!password) return;
    try {
      await syncPools(password);
      toast.message("Sync started — 9Router health check in progress");
      setTimeout(load, 400);
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

  // Selection rule: "Toàn bộ tab" (All available in current tab scope)
  const selectablePools = useMemo(
    () => visiblePools.filter((pool) => pool.testState !== "checking" && pool.testState !== "retrying"),
    [visiblePools]
  );

  const allSelectedInTab =
    selectablePools.length > 0 && selectablePools.every((p) => selectedIds.includes(p.localId));
  const someSelectedInTab =
    selectablePools.some((p) => selectedIds.includes(p.localId)) && !allSelectedInTab;

  function toggleAllInTab() {
    if (allSelectedInTab) {
      const selectableIdSet = new Set(selectablePools.map((p) => p.localId));
      setSelectedIds((curr) => curr.filter((id) => !selectableIdSet.has(id)));
    } else {
      const combined = new Set([...selectedIds, ...selectablePools.map((p) => p.localId)]);
      setSelectedIds(Array.from(combined));
    }
  }

  function toggleOne(localId: string) {
    setSelectedIds((curr) =>
      curr.includes(localId) ? curr.filter((id) => id !== localId) : [...curr, localId]
    );
  }

  // Column definitions with TanStack Table
  const columns = useMemo(() => {
    return columnHelper.columns([
      columnHelper.display({
        id: "select",
        header: () => (
          <div className="flex items-center justify-center">
            <Checkbox
              checked={allSelectedInTab ? true : someSelectedInTab ? "indeterminate" : false}
              onCheckedChange={toggleAllInTab}
              disabled={!selectablePools.length}
              aria-label="Select all proxies in tab"
            />
          </div>
        ),
        cell: ({ row }) => {
          const pool = row.original;
          const isTesting = pool.testState === "checking" || pool.testState === "retrying";
          const isSelected = selectedIds.includes(pool.localId);
          return (
            <div className="flex items-center justify-center">
              <Checkbox
                checked={isSelected}
                onCheckedChange={() => toggleOne(pool.localId)}
                disabled={isTesting}
                aria-label={`Select ${pool.name}`}
              />
            </div>
          );
        },
        enableSorting: false,
        enableHiding: false,
      }),

      columnHelper.accessor("name", {
        id: "proxy",
        header: ({ column }) => {
          const isSorted = column.getIsSorted();
          const Icon = isSorted === "asc" ? ArrowUp : isSorted === "desc" ? ArrowDown : ArrowUpDown;
          return (
            <button
              type="button"
              className={`pool-sort ${isSorted ? "pool-sort--active" : ""}`}
              onClick={() => column.toggleSorting(isSorted === "asc")}
            >
              Proxy
              <Icon size={13} aria-hidden />
            </button>
          );
        },
        cell: ({ row }) => {
          const pool = row.original;
          return (
            <div className="proxy-identity">
              <strong className="proxy-identity__name">{pool.name}</strong>
              <span className="mono proxy-identity__endpoint">{pool.proxyUrl}</span>
            </div>
          );
        },
      }),

      columnHelper.accessor((row) => row.latency_ms ?? Number.MAX_SAFE_INTEGER, {
        id: "latency_ms",
        header: ({ column }) => {
          const isSorted = column.getIsSorted();
          const Icon = isSorted === "asc" ? ArrowUp : isSorted === "desc" ? ArrowDown : ArrowUpDown;
          return (
            <button
              type="button"
              className={`pool-sort ${isSorted ? "pool-sort--active" : ""}`}
              onClick={() => column.toggleSorting(isSorted === "asc")}
            >
              Latency
              <Icon size={13} aria-hidden />
            </button>
          );
        },
        cell: ({ row }) => {
          const pool = row.original;
          const isTesting = pool.testState === "checking" || pool.testState === "retrying";
          if (isTesting) {
            return (
              <span className="latency-live">
                <span className="metric-value-loader" aria-hidden />
                <span className="sr-only">Measuring latency</span>
              </span>
            );
          }
          return pool.latency_ms != null ? (
            <span key={`latency-${pool.localId}-${pool.latency_ms}`} className="metric-number--changed">
              {pool.latency_ms} ms
            </span>
          ) : (
            "—"
          );
        },
      }),

      columnHelper.accessor((row) => {
        const total = row.successes + row.failures;
        return total > 0 ? row.successes / total : -1;
      }, {
        id: "uptime",
        header: ({ column }) => {
          const isSorted = column.getIsSorted();
          const Icon = isSorted === "asc" ? ArrowUp : isSorted === "desc" ? ArrowDown : ArrowUpDown;
          return (
            <button
              type="button"
              className={`pool-sort ${isSorted ? "pool-sort--active" : ""}`}
              onClick={() => column.toggleSorting(isSorted === "asc")}
            >
              Uptime
              <Icon size={13} aria-hidden />
            </button>
          );
        },
        cell: ({ row }) => {
          const pool = row.original;
          const isTesting = pool.testState === "checking" || pool.testState === "retrying";
          if (isTesting) {
            return <span className="metric-value-loader" aria-label="Measuring uptime" />;
          }
          const total = pool.successes + pool.failures;
          return (
            <span key={`uptime-${pool.localId}-${total}`} className="metric-number--changed">
              {total > 0 ? `${Math.round((pool.successes / total) * 100)}%` : "—"}
            </span>
          );
        },
      }),

      columnHelper.accessor((row) => row.checked_at || 0, {
        id: "checked_at",
        header: ({ column }) => {
          const isSorted = column.getIsSorted();
          const Icon = isSorted === "asc" ? ArrowUp : isSorted === "desc" ? ArrowDown : ArrowUpDown;
          return (
            <button
              type="button"
              className={`pool-sort ${isSorted ? "pool-sort--active" : ""}`}
              onClick={() => column.toggleSorting(isSorted === "asc")}
            >
              Last checked
              <Icon size={13} aria-hidden />
            </button>
          );
        },
        cell: ({ row }) => {
          const pool = row.original;
          return pool.checked_at ? formatTime(pool.checked_at) : "Never";
        },
      }),

      columnHelper.accessor("status", {
        id: "health",
        header: ({ column }) => {
          const isSorted = column.getIsSorted();
          const Icon = isSorted === "asc" ? ArrowUp : isSorted === "desc" ? ArrowDown : ArrowUpDown;
          return (
            <button
              type="button"
              className={`pool-sort ${isSorted ? "pool-sort--active" : ""}`}
              onClick={() => column.toggleSorting(isSorted === "asc")}
            >
              Health
              <Icon size={13} aria-hidden />
            </button>
          );
        },
        cell: ({ row }) => <ProxyHealthBadge pool={row.original} />,
      }),

      columnHelper.display({
        id: "actions",
        header: () => <div className="text-right pr-2">Action</div>,
        cell: ({ row }) => {
          const pool = row.original;
          const isTesting = pool.testState === "checking" || pool.testState === "retrying";
          const isQueued = pool.testState === "queued" || pool.healthStatus === "pending";

          return (
            <div className="flex justify-end">
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
                <DropdownMenuContent align="end" className="pool-menu-content w-48">
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
            </div>
          );
        },
        enableSorting: false,
        enableHiding: false,
      }),
    ]);
  }, [allSelectedInTab, someSelectedInTab, selectablePools, selectedIds]);

  // Global search filtering across name, proxyUrl and status
  const tableData = useMemo(() => {
    if (!globalFilter.trim()) return visiblePools;
    const q = globalFilter.trim().toLowerCase();
    return visiblePools.filter((p) => {
      return (
        p.name.toLowerCase().includes(q) ||
        p.proxyUrl.toLowerCase().includes(q) ||
        p.status.toLowerCase().includes(q)
      );
    });
  }, [visiblePools, globalFilter]);

  const table = useTable({
    features: tableConfigFeatures,
    data: tableData,
    columns,
    state: {
      sorting,
      columnVisibility,
      pagination,
    },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onPaginationChange: setPagination,
  });

  const pageRows = table.getRowModel().rows;
  const totalCount = visiblePools.length;
  const filteredCount = tableData.length;
  const selectedCount = selectedIds.length;

  const subtitle = syncing
    ? `${pools.length} proxies loaded · health check in progress`
    : `${totalCount} ${tab} pools shown${selectedCount ? ` · ${selectedCount} selected` : ""}`;

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
              setPagination((prev) => ({ ...prev, pageIndex: 0 }));
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
              setPagination((prev) => ({ ...prev, pageIndex: 0 }));
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
              setPagination((prev) => ({ ...prev, pageIndex: 0 }));
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

      {/* Control bar: Search, Columns toggle, Selection summary */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search proxy name, URL or IP..."
            value={globalFilter}
            onChange={(e) => {
              setGlobalFilter(e.target.value);
              setPagination((prev) => ({ ...prev, pageIndex: 0 }));
            }}
            className="pl-9 bg-card/40 border-border/80 text-xs sm:text-sm h-9"
          />
        </div>

        <div className="flex items-center gap-2 self-end sm:self-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-9 gap-1.5 text-xs">
                <SlidersHorizontal className="size-3.5" />
                <span>Columns</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel className="text-xs">Toggle columns</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {table
                .getAllColumns()
                .filter((column) => column.getCanHide())
                .map((column) => {
                  const headerTitle =
                    column.id === "latency_ms"
                      ? "Latency"
                      : column.id === "checked_at"
                      ? "Last checked"
                      : column.id.charAt(0).toUpperCase() + column.id.slice(1);
                  return (
                    <DropdownMenuCheckboxItem
                      key={column.id}
                      className="capitalize text-xs"
                      checked={column.getIsVisible()}
                      onCheckedChange={(value) => column.toggleVisibility(!!value)}
                    >
                      {headerTitle}
                    </DropdownMenuCheckboxItem>
                  );
                })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>


      {/* Main Table Wrap */}
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
        ) : filteredCount === 0 ? (
          <p className="table-empty">
            No proxies match &quot;{globalFilter}&quot;. Try adjusting your search query.
          </p>
        ) : (
          <Table className="pool-table">
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    const isSelect = header.id === "select";
                    const isAction = header.id === "actions";
                    return (
                      <TableHead
                        key={header.id}
                        className={isSelect ? "pool-check-cell" : isAction ? "pool-action-cell" : ""}
                      >
                        {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {pageRows.map((row, index) => {
                const pool = row.original;
                const isSelected = selectedIds.includes(pool.localId);
                const isTesting = pool.testState === "checking" || pool.testState === "retrying";
                const isQueued = pool.testState === "queued" || pool.healthStatus === "pending";

                return (
                  <ContextMenu key={pool.localId}>
                    <ContextMenuTrigger asChild>
                      <TableRow
                        data-state={isSelected ? "selected" : undefined}
                        className={rowClass(pool)}
                        style={{ "--i": index } as React.CSSProperties}
                      >
                        {row.getVisibleCells().map((cell) => {
                          const isSelect = cell.column.id === "select";
                          const isAction = cell.column.id === "actions";
                          const isLatency = cell.column.id === "latency_ms";
                          const isUptime = cell.column.id === "uptime";
                          const isChecked = cell.column.id === "checked_at";

                          return (
                            <TableCell
                              key={cell.id}
                              data-label={
                                isSelect
                                  ? "Select"
                                  : isAction
                                  ? "Action"
                                  : isLatency
                                  ? "Latency"
                                  : isUptime
                                  ? "Uptime"
                                  : isChecked
                                  ? "Last checked"
                                  : cell.column.id === "proxy"
                                  ? "Proxy"
                                  : cell.column.id === "health"
                                  ? "Health"
                                  : cell.column.id
                              }
                              className={
                                isSelect
                                  ? "pool-check-cell"
                                  : isAction
                                  ? "pool-action-cell"
                                  : isLatency && isTesting
                                  ? "latency-cell latency-cell--live"
                                  : isUptime && isTesting
                                  ? "metric-cell--live"
                                  : isChecked
                                  ? "pool-last-checked-cell"
                                  : ""
                              }
                            >
                              <table.FlexRender cell={cell} />
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    </ContextMenuTrigger>

                    {/* Right-click Context Menu */}
                    <ContextMenuContent className="w-52">
                      <ContextMenuLabel className="text-xs font-semibold flex items-center justify-between">
                        <span className="truncate max-w-[140px]">{pool.name}</span>
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {pool.latency_ms != null ? `${pool.latency_ms}ms` : ""}
                        </span>
                      </ContextMenuLabel>
                      <ContextMenuSeparator />

                      <ContextMenuItem onClick={() => openRename(pool)} disabled={isTesting}>
                        <Pencil size={14} aria-hidden />
                        <span>Rename</span>
                      </ContextMenuItem>

                      {pool.remoteState === "linked" && (
                        <ContextMenuItem
                          onClick={() => handleToggle(pool)}
                          disabled={isTesting || isQueued}
                        >
                          <Power size={14} aria-hidden />
                          <span>{pool.isActiveOnRouter ? "Deactivate" : "Activate"}</span>
                        </ContextMenuItem>
                      )}


                      {pool.remoteState === "delete_failed" && (
                        <ContextMenuItem
                          onClick={() => handleRetryRemoval(pool)}
                          disabled={isTesting}
                          variant="destructive"
                        >
                          <RotateCcw size={14} aria-hidden />
                          <span>Retry removal</span>
                        </ContextMenuItem>
                      )}

                      {pool.remoteState === "linked" && (
                        <>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            onClick={() => openRemove(pool)}
                            disabled={isTesting}
                            variant="destructive"
                          >
                            <Trash2 size={14} aria-hidden />
                            <span>Remove</span>
                          </ContextMenuItem>
                        </>
                      )}
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Pagination Controls */}
      {filteredCount > 0 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 py-3 px-1 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <span>
              Showing {pagination.pageIndex * pagination.pageSize + 1} to{" "}
              {Math.min((pagination.pageIndex + 1) * pagination.pageSize, filteredCount)} of{" "}
              {filteredCount} {filteredCount < totalCount ? `(filtered from ${totalCount})` : "proxies"}
            </span>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span>Rows per page</span>
              <select
                aria-label="Rows per page"
                value={table.state.pagination.pageSize}
                onChange={(e) => {
                  table.setPageSize(Number(e.target.value));
                }}
                className="h-8 rounded-md border border-border bg-card px-2 py-0.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {[10, 20, 50].map((pageSize) => (
                  <option key={pageSize} value={pageSize}>
                    {pageSize}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                onClick={() => table.setPageIndex(0)}
                disabled={!table.getCanPreviousPage()}
                aria-label="Go to first page"
              >
                <ChevronsLeft className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
                aria-label="Go to previous page"
              >
                <ChevronLeft className="size-4" />
              </Button>
              <span className="px-2 font-medium text-foreground">
                Page {table.state.pagination.pageIndex + 1} of {Math.max(1, table.getPageCount())}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
                aria-label="Go to next page"
              >
                <ChevronRight className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                onClick={() => table.setPageIndex(table.getPageCount() - 1)}
                disabled={!table.getCanNextPage()}
                aria-label="Go to last page"
              >
                <ChevronsRight className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      )}

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
