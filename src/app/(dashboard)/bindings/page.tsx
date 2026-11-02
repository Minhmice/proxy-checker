"use client";

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Shuffle,
  RefreshCw,
  RotateCcw,
  Server,
  CheckCheck,
  Search,
  Filter,
  X,
  AlertTriangle,
  Trash2,
  Loader2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { calculateAutoBindPlan, type LoadState } from "@/lib/proxy-binding-state";
import {
  AccountBindingsTable,
  type AntigravityConnection,
} from "@/components/ninerouter/account-bindings-table";
import { ProxyPoolsTable, type ProxyPoolItem } from "@/components/ninerouter/proxy-pools-table";
import { BindingContextBar } from "@/components/ninerouter/binding-context-bar";
import { BindingPickerDialog } from "@/components/ninerouter/binding-picker-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { motion } from "motion/react";
import { toast } from "sonner";
import { resetAntigravityProxies } from "@/lib/api";
import { formatProxyAddress } from "@/lib/utils";

const NODES = [{ id: "server-lan", name: "Raspberry Pi (192.168.1.54)" }];

type FilterType = "all" | "active" | "bound" | "unbound";

export default function BindingsPage() {
  const [selectedNode, setSelectedNode] = useState("server-lan");
  const [connections, setConnections] = useState<AntigravityConnection[]>([]);
  const [pools, setPools] = useState<ProxyPoolItem[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [bindingPoolId, setBindingPoolId] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmDeletePool, setConfirmDeletePool] = useState<ProxyPoolItem | null>(null);
  const [deletingPool, setDeletingPool] = useState(false);
  const [confirmAutoDistribute, setConfirmAutoDistribute] = useState(false);
  const [onlyUnassignedAutoBind, setOnlyUnassignedAutoBind] = useState(true);
  const [distributing, setDistributing] = useState(false);
  const [confirmResetProxies, setConfirmResetProxies] = useState(false);
  const [unbindingMap, setUnbindingMap] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; elapsedMs?: number; error?: string }>
  >({});
  const [testingMap, setTestingMap] = useState<Record<string, boolean>>({});

  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const [resettingProxies, setResettingProxies] = useState(false);

  const loadData = useCallback(async () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;
    const currentGen = ++generationRef.current;
    const targetNode = selectedNode;

    setLoadState("loading");
    setLoadError(null);

    try {
      const [resConns, resPools] = await Promise.all([
        fetch(`/api/ninerouter/nodes/${encodeURIComponent(targetNode)}/connections`, {
          signal: controller.signal,
        }),
        fetch(`/api/ninerouter/nodes/${encodeURIComponent(targetNode)}/proxy-pools`, {
          signal: controller.signal,
        }),
        fetch("/api/antigravity/refresh", {
          method: "POST",
          signal: controller.signal,
        }).catch(() => null),
      ]);

      if (controller.signal.aborted || currentGen !== generationRef.current) {
        return;
      }

      if (!resConns.ok) {
        const errorText = `Failed to load accounts: node returned HTTP ${resConns.status}`;
        setConnections([]);
        setPools([]);
        setLoadState("error");
        setLoadError(errorText);
        toast.error(errorText);
        return;
      }

      if (!resPools.ok) {
        const errorText = `Failed to load proxy pools: node returned HTTP ${resPools.status}`;
        setConnections([]);
        setPools([]);
        setLoadState("error");
        setLoadError(errorText);
        toast.error(errorText);
        return;
      }

      const dataConns = await resConns.json();
      const dataPools = await resPools.json();

      if (controller.signal.aborted || currentGen !== generationRef.current) {
        return;
      }

      setConnections(dataConns.connections || []);
      setPools(dataPools.proxyPools || []);
      setLoadState("ready");
      setLoadError(null);
    } catch (err) {
      if (controller.signal.aborted || currentGen !== generationRef.current) {
        return;
      }
      const msg = (err as Error).message;
      setConnections([]);
      setPools([]);
      setLoadState("error");
      setLoadError(msg);
      toast.error(`Failed to load 9Router node data: ${msg}`);
    }
  }, [selectedNode]);

  useEffect(() => {
    loadData();
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, [loadData]);

  const handleSelectNode = (nodeId: string) => {
    if (selectedNode === nodeId) return;
    setSelectedConnectionId(null);
    setTestResults({});
    setTestingMap({});
    setSelectedNode(nodeId);
  };

  const handleClearFilters = () => {
    setSearchQuery("");
    setActiveFilter("all");
  };

  const isFiltered = searchQuery.trim().length > 0 || activeFilter !== "all";

  const selectedConnection = useMemo(
    () => connections.find((c) => c.id === selectedConnectionId) || null,
    [connections, selectedConnectionId],
  );

  const selectedNodeName = useMemo(
    () => NODES.find((n) => n.id === selectedNode)?.name || selectedNode,
    [selectedNode],
  );

  const poolMap = useMemo(() => {
    const map: Record<string, { name: string; url: string; index?: number }> = {};
    pools.forEach((p, idx) => {
      map[p.id] = { name: p.name, url: p.proxyUrl, index: idx + 1 };
    });
    return map;
  }, [pools]);

  // Set of pool IDs that are currently bound to any connection
  const boundPoolIdSet = useMemo(() => {
    const set = new Set<string>();
    connections.forEach((c) => {
      if (c.providerSpecificData?.proxyPoolId) {
        set.add(c.providerSpecificData.proxyPoolId);
      }
    });
    return set;
  }, [connections]);

  // Filtered connections based on search query & filter pills
  const filteredConnections = useMemo(() => {
    return connections.filter((conn) => {
      const query = searchQuery.trim().toLowerCase();
      const matchesSearch =
        !query ||
        (conn.email && conn.email.toLowerCase().includes(query)) ||
        (conn.name && conn.name.toLowerCase().includes(query)) ||
        conn.id.toLowerCase().includes(query);

      if (!matchesSearch) return false;

      if (activeFilter === "active") {
        return conn.isActive !== false;
      }
      if (activeFilter === "bound") {
        return Boolean(conn.providerSpecificData?.proxyPoolId);
      }
      if (activeFilter === "unbound") {
        return !conn.providerSpecificData?.proxyPoolId;
      }
      return true;
    });
  }, [connections, searchQuery, activeFilter]);

  // Filtered pools based on search query & filter pills
  const filteredPools = useMemo(() => {
    return pools.filter((pool) => {
      const query = searchQuery.trim().toLowerCase();
      const matchesSearch =
        !query ||
        (pool.name && pool.name.toLowerCase().includes(query)) ||
        (pool.proxyUrl && pool.proxyUrl.toLowerCase().includes(query)) ||
        pool.id.toLowerCase().includes(query);

      if (!matchesSearch) return false;

      if (activeFilter === "active") {
        return pool.isActive;
      }
      if (activeFilter === "bound") {
        return boundPoolIdSet.has(pool.id);
      }
      if (activeFilter === "unbound") {
        return !boundPoolIdSet.has(pool.id);
      }
      return true;
    });
  }, [pools, boundPoolIdSet, searchQuery, activeFilter]);

  const handleToggleConnection = async (id: string, nextActive: boolean) => {
    try {
      const res = await fetch(
        `/api/ninerouter/nodes/${encodeURIComponent(selectedNode)}/connections/${encodeURIComponent(id)}/bind-pool`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive: nextActive }),
        },
      );
      if (res.ok) {
        setConnections((prev) =>
          prev.map((c) => (c.id === id ? { ...c, isActive: nextActive } : c)),
        );
        toast.success(`Account ${nextActive ? "activated" : "deactivated"}`);
      } else {
        const data = await res.json().catch(() => null);
        const errorMsg =
          data && typeof data === "object" && "error" in data && typeof data.error === "string"
            ? data.error
            : "Failed to update account status";
        toast.error(errorMsg);
      }
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const handleTogglePool = async (poolId: string, nextActive: boolean) => {
    try {
      const res = await fetch(
        `/api/ninerouter/nodes/${encodeURIComponent(selectedNode)}/proxy-pools/${encodeURIComponent(poolId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive: nextActive }),
        },
      );
      if (res.ok) {
        setPools((prev) => prev.map((p) => (p.id === poolId ? { ...p, isActive: nextActive } : p)));
        toast.success(`Proxy pool ${nextActive ? "activated" : "deactivated"}`);
      } else {
        const data = await res.json().catch(() => null);
        const errorMsg =
          data && typeof data === "object" && "error" in data && typeof data.error === "string"
            ? data.error
            : "Failed to update pool status";
        toast.error(errorMsg);
      }
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const handleBindPool = async (poolId: string) => {
    if (!selectedConnectionId) {
      toast.error("Please select an Antigravity account on the left first");
      return;
    }
    const targetConnId = selectedConnectionId;
    setBindingPoolId(poolId);

    try {
      const res = await fetch(
        `/api/ninerouter/nodes/${encodeURIComponent(selectedNode)}/connections/${encodeURIComponent(targetConnId)}/bind-pool`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ poolId }),
        },
      );

      if (res.ok) {
        setConnections((prev) =>
          prev.map((c) =>
            c.id === targetConnId
              ? {
                  ...c,
                  providerSpecificData: {
                    ...c.providerSpecificData,
                    proxyPoolId: poolId,
                  },
                }
              : c,
          ),
        );
        toast.success("Proxy pool bound to account successfully");
      } else {
        const data = await res.json().catch(() => null);
        const errorMsg =
          data && typeof data === "object" && "error" in data && typeof data.error === "string"
            ? data.error
            : "Failed to bind proxy pool";
        toast.error(errorMsg);
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBindingPoolId(null);
    }
  };

  const handleBindPoolToConnection = async (connId: string, poolId: string) => {
    try {
      const res = await fetch(
        `/api/ninerouter/nodes/${encodeURIComponent(selectedNode)}/connections/${encodeURIComponent(connId)}/bind-pool`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ poolId }),
        },
      );
      if (res.ok) {
        setConnections((prev) =>
          prev.map((c) =>
            c.id === connId
              ? {
                  ...c,
                  providerSpecificData: {
                    ...c.providerSpecificData,
                    proxyPoolId: poolId,
                  },
                }
              : c,
          ),
        );
        toast.success("Proxy pool assignment restored");
      }
    } catch {
      toast.error("Failed to restore proxy pool");
    }
  };

  const handleUnbind = async (connectionId: string) => {
    if (unbindingMap[connectionId]) return;
    setUnbindingMap((prev) => ({ ...prev, [connectionId]: true }));
    const targetConn = connections.find((c) => c.id === connectionId);
    const prevPoolId = targetConn?.providerSpecificData?.proxyPoolId;

    try {
      const res = await fetch(
        `/api/ninerouter/nodes/${encodeURIComponent(selectedNode)}/connections/${encodeURIComponent(connectionId)}/bind-pool`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ poolId: null }),
        },
      );

      if (res.ok) {
        setConnections((prev) =>
          prev.map((c) =>
            c.id === connectionId
              ? {
                  ...c,
                  providerSpecificData: {
                    ...c.providerSpecificData,
                    proxyPoolId: undefined,
                  },
                }
              : c,
          ),
        );
        toast.success("Proxy unbound from account", {
          action: prevPoolId
            ? {
                label: "Undo",
                onClick: () => handleBindPoolToConnection(connectionId, prevPoolId),
              }
            : undefined,
        });
      } else {
        toast.error("Failed to unbind proxy");
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setUnbindingMap((prev) => ({ ...prev, [connectionId]: false }));
    }
  };

  const handleTestPool = async (poolId: string) => {
    setTestingMap((prev) => ({ ...prev, [poolId]: true }));
    try {
      const res = await fetch(
        `/api/ninerouter/nodes/${encodeURIComponent(selectedNode)}/proxy-pools/${encodeURIComponent(poolId)}/test`,
        { method: "POST" },
      );
      const data = await res.json();
      setTestResults((prev) => ({ ...prev, [poolId]: data }));
      if (data.ok) {
        toast.success(`Pool responded in ${data.elapsedMs}ms`);
      } else {
        toast.error(`Pool test failed: ${data.error || "Timeout"}`);
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setTestingMap((prev) => ({ ...prev, [poolId]: false }));
    }
  };

  const handleConfirmDeletePool = async () => {
    if (!confirmDeletePool || deletingPool) return;
    setDeletingPool(true);
    const poolId = confirmDeletePool.id;
    try {
      const res = await fetch(
        `/api/ninerouter/nodes/${encodeURIComponent(selectedNode)}/proxy-pools/${encodeURIComponent(poolId)}`,
        { method: "DELETE" },
      );
      if (res.ok) {
        setPools((prev) => prev.filter((p) => p.id !== poolId));
        setConnections((prev) =>
          prev.map((c) =>
            c.providerSpecificData?.proxyPoolId === poolId
              ? {
                  ...c,
                  providerSpecificData: {
                    ...c.providerSpecificData,
                    proxyPoolId: undefined,
                  },
                }
              : c,
          ),
        );
        toast.success(`Proxy pool "${confirmDeletePool.name}" deleted`);
        setConfirmDeletePool(null);
      } else {
        toast.error("Failed to delete proxy pool");
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setDeletingPool(false);
    }
  };

  const autoBindPlan = useMemo(() => {
    return calculateAutoBindPlan(connections, pools, {
      onlyUnassigned: onlyUnassignedAutoBind,
    });
  }, [connections, pools, onlyUnassignedAutoBind]);

  const eligibleAccountsCount = useMemo(() => {
    return onlyUnassignedAutoBind
      ? connections.filter((c) => !c.providerSpecificData?.proxyPoolId).length
      : connections.length;
  }, [connections, onlyUnassignedAutoBind]);

  const availablePoolsCount = useMemo(() => {
    const activePools = pools.filter((p) => p.isActive !== false);
    return onlyUnassignedAutoBind
      ? activePools.filter((p) => !boundPoolIdSet.has(p.id)).length
      : activePools.length;
  }, [pools, onlyUnassignedAutoBind, boundPoolIdSet]);

  const handleExecuteAutoDistribute = async () => {
    if (distributing || autoBindPlan.assignments.length === 0) return;
    setDistributing(true);
    toast.info(`Assigning ${autoBindPlan.assignments.length} proxy pool(s)...`);

    let successCount = 0;
    let failCount = 0;

    for (const assignment of autoBindPlan.assignments) {
      try {
        const res = await fetch(
          `/api/ninerouter/nodes/${encodeURIComponent(selectedNode)}/connections/${encodeURIComponent(assignment.connectionId)}/bind-pool`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ poolId: assignment.poolId }),
          },
        );
        if (res.ok) {
          successCount++;
        } else {
          failCount++;
        }
      } catch {
        failCount++;
      }
    }

    await loadData();
    setDistributing(false);
    setConfirmAutoDistribute(false);

    if (failCount === 0) {
      toast.success(`Successfully assigned ${successCount} proxy pool(s)`);
    } else {
      toast.warning(`Auto-distribution completed: ${successCount} succeeded, ${failCount} failed`);
    }
  };

  const handleResetProxies = async () => {
    if (resettingProxies) return;
    setResettingProxies(true);
    try {
      toast.info("Checking accounts for 403 Forbidden / invalid proxies and resetting...");
      const res = await resetAntigravityProxies();
      if (res.ok) {
        toast.success(
          res.reassignedCount && res.reassignedCount > 0
            ? `Re-assigned ${res.reassignedCount} account(s) (${res.forbiddenAccounts || 0} forbidden) to clean proxies`
            : "All accounts verified: no forbidden or broken proxies found",
        );
      } else {
        toast.error(res.error || "Failed to reset proxies");
      }
      await loadData();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setResettingProxies(false);
    }
  };

  return (
    <div className="space-y-5 pb-12">
      {/* Top Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#23232C] pb-4">
        <div>
          <h1 className="text-xl md:text-2xl font-extrabold tracking-tight text-zinc-100 flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-lg bg-[#FF5B22]/15 text-[#FF5B22] border border-[#FF5B22]/30 shadow-[0_0_12px_rgba(255,91,34,0.2)]">
              <Shuffle className="size-5" />
            </span>
            Bindings
          </h1>
          <p className="text-xs text-[#9E9EA8] mt-1">
            Map Antigravity OAuth accounts to dedicated 9Router proxy pools side-by-side with
            instant one-click binding and auto-distribution.
          </p>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          {/* Node selector buttons */}
          <div className="flex items-center bg-[#131318] border border-[#23232C] rounded-xl p-1">
            {NODES.map((n) => (
              <Button
                key={n.id}
                size="sm"
                variant="ghost"
                onClick={() => handleSelectNode(n.id)}
                className={`h-7 px-3 text-xs font-semibold rounded-lg transition-all gap-1.5 ${
                  selectedNode === n.id
                    ? "bg-[#FF5B22] text-black font-extrabold shadow-sm shadow-[#FF5B22]/25"
                    : "text-zinc-300 hover:text-zinc-100 hover:bg-white/[0.04]"
                }`}
              >
                <Server className="size-3" />
                {n.name}
              </Button>
            ))}
          </div>

          {/* Flame Orange Action Button */}
          <Button
            size="sm"
            onClick={() => setConfirmAutoDistribute(true)}
            disabled={loadState === "loading" || distributing}
            className="h-9 px-3.5 bg-gradient-to-r from-[#FF5B22] to-[#FF3D00] hover:brightness-110 text-black font-extrabold shadow-sm shadow-[#FF5B22]/25 border-0 gap-1.5 text-xs cursor-pointer"
          >
            <CheckCheck className="size-3.5 stroke-[2.5]" />
            Auto Bind
          </Button>
          {/* Reset Proxies Button */}
          <Button
            size="sm"
            onClick={() => setConfirmResetProxies(true)}
            disabled={resettingProxies || loadState === "loading"}
            className="h-9 border-[#FF5B22]/40 bg-[#131318] text-[#FF5B22] hover:bg-[#FF5B22]/10 hover:border-[#FF5B22] gap-1.5 text-xs font-semibold transition-all"
          >
            <RotateCcw className={`size-3.5 ${resettingProxies ? "animate-spin" : ""}`} />
            Reset Proxies
          </Button>

          {/* Refresh Button */}
          <Button
            size="sm"
            variant="outline"
            onClick={loadData}
            disabled={loadState === "loading"}
            className="h-9 border-[#23232C] bg-[#131318] text-zinc-100 hover:text-[#FF5B22] hover:border-[#FF5B22]/40 gap-1.5 text-xs font-semibold transition-all disabled:opacity-90 disabled:text-zinc-200"
          >
            <RefreshCw
              className={`size-3.5 ${loadState === "loading" ? "animate-spin text-[#FF5B22]" : ""}`}
            />
            Refresh
          </Button>
        </div>
      </div>

      {/* Search Bar & Filter Pills */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 p-2 rounded-xl border border-[#23232C] bg-[#131318]">
        {/* Search Input */}
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-[#9E9EA8]" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search accounts or proxy pools..."
            className="h-8 pl-8 pr-8 text-xs bg-[#1C1C24] border-[#23232C] text-zinc-100 placeholder:text-[#9E9EA8] focus-visible:ring-1 focus-visible:ring-[#FF5B22] rounded-lg"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#9E9EA8] hover:text-zinc-200 cursor-pointer"
            >
              <X className="size-3" />
            </button>
          )}
        </div>

        {/* Filter Pills */}
        <div className="flex items-center gap-1.5 self-end sm:self-auto">
          <span className="text-[11px] text-[#9E9EA8] mr-1 flex items-center gap-1">
            <Filter className="size-3" />
            Filter:
          </span>
          {(
            [
              { id: "all", label: "All" },
              { id: "active", label: "Active" },
              { id: "bound", label: "Bound" },
              { id: "unbound", label: "Unbound" },
            ] as const
          ).map((pill) => (
            <button
              type="button"
              key={pill.id}
              onClick={() => setActiveFilter(pill.id)}
              className={`h-7 px-3 text-xs font-medium rounded-lg transition-all border ${
                activeFilter === pill.id
                  ? "bg-[#FF5B22] text-zinc-950 border-transparent shadow-sm shadow-[#FF5B22]/25 font-bold"
                  : "bg-[#1C1C24] text-zinc-300 border-[#23232C] hover:text-white hover:border-zinc-700"
              }`}
            >
              {pill.label}
            </button>
          ))}
        </div>
      </div>

      {/* Active Binding Context Bar */}
      <BindingContextBar
        account={selectedConnection}
        nodeName={selectedNodeName}
        poolMap={poolMap}
        onChangePool={() => setIsPickerOpen(true)}
        onDeselect={() => setSelectedConnectionId(null)}
        isBusy={Boolean(bindingPoolId)}
      />

      {/* Candidate Binding Picker Dialog */}
      <BindingPickerDialog
        open={isPickerOpen}
        onOpenChange={setIsPickerOpen}
        account={selectedConnection}
        pools={pools}
        currentPoolId={selectedConnection?.providerSpecificData?.proxyPoolId}
        busyPoolId={bindingPoolId}
        onBind={handleBindPool}
      />

      {/* Side-by-Side 2 Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        {/* Left Column: Account Bindings */}
        <AccountBindingsTable
          connections={filteredConnections}
          selectedConnectionId={selectedConnectionId}
          onSelectConnection={setSelectedConnectionId}
          onToggleActive={handleToggleConnection}
          onUnbind={handleUnbind}
          poolMap={poolMap}
          loadState={loadState}
          loadError={loadError}
          onRetry={loadData}
          isFiltered={isFiltered}
          onClearFilter={handleClearFilters}
          unbindingMap={unbindingMap}
        />
        {/* Right Column: Proxy Pools */}
        <ProxyPoolsTable
          pools={filteredPools}
          selectedConnectionId={selectedConnectionId}
          onAssignToSelected={handleBindPool}
          onToggleActive={handleTogglePool}
          onTestPool={handleTestPool}
          onDeletePool={(poolId) => {
            const target = pools.find((p) => p.id === poolId);
            if (target) setConfirmDeletePool(target);
          }}
          testResults={testResults}
          testingMap={testingMap}
          loadState={loadState}
          loadError={loadError}
          onRetry={loadData}
          isFiltered={isFiltered}
          onClearFilter={handleClearFilters}
        />
      </div>

      {/* Delete Pool Confirmation Dialog */}
      <Dialog
        open={Boolean(confirmDeletePool)}
        onOpenChange={(open) => !open && !deletingPool && setConfirmDeletePool(null)}
      >
        <DialogContent className="max-w-md bg-[#131318] border-[#23232C] text-zinc-100 p-6 rounded-2xl shadow-2xl">
          <DialogHeader className="space-y-1.5 pb-2 border-b border-[#23232C]">
            <DialogTitle className="text-base font-bold text-rose-400 flex items-center gap-2">
              <Trash2 className="size-4" />
              <span>Confirm Proxy Pool Deletion</span>
            </DialogTitle>
            <DialogDescription className="text-xs text-[#9E9EA8]">
              Are you sure you want to delete this proxy pool from 9Router?
            </DialogDescription>
          </DialogHeader>

          {confirmDeletePool && (
            <div className="space-y-3 my-2 text-xs">
              <div className="p-3 rounded-lg bg-[#0F0F13] border border-[#23232C] font-mono space-y-1">
                <div className="font-semibold text-zinc-100">
                  {confirmDeletePool.name || "Proxy Pool"}
                </div>
                <div className="text-[11px] text-[#9E9EA8] truncate">
                  {formatProxyAddress(confirmDeletePool.proxyUrl)}
                </div>
              </div>

              {(() => {
                const affectedConns = connections.filter(
                  (c) => c.providerSpecificData?.proxyPoolId === confirmDeletePool.id,
                );
                if (affectedConns.length > 0) {
                  return (
                    <div className="p-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-300 text-xs flex items-start gap-2">
                      <AlertTriangle className="size-4 shrink-0 mt-0.5" />
                      <div>
                        <strong>Warning:</strong> {affectedConns.length} Antigravity account(s)
                        currently bound to this pool will be detached and fallback to direct
                        routing.
                      </div>
                    </div>
                  );
                }
                return null;
              })()}
            </div>
          )}

          <DialogFooter className="pt-2 border-t border-[#23232C] flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConfirmDeletePool(null)}
              disabled={deletingPool}
              className="h-8 text-xs border-[#23232C] bg-[#1C1C24] text-zinc-300 hover:text-white cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleConfirmDeletePool}
              disabled={deletingPool}
              className="h-8 text-xs bg-rose-600 hover:bg-rose-700 text-white font-semibold cursor-pointer gap-1"
            >
              {deletingPool ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Trash2 className="size-3" />
              )}
              <span>Delete Pool</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Auto Bind Preview & Confirmation Dialog */}
      <Dialog
        open={confirmAutoDistribute}
        onOpenChange={(open) => !open && !distributing && setConfirmAutoDistribute(false)}
      >
        <DialogContent className="max-w-lg bg-[#131318] border-[#23232C] text-zinc-100 p-6 rounded-2xl shadow-2xl">
          <DialogHeader className="space-y-1.5 pb-2 border-b border-[#23232C]">
            <DialogTitle className="text-base font-bold text-zinc-100 flex items-center gap-2">
              <CheckCheck className="size-4 text-[#FF5B22]" />
              <span>Auto-Distribute Proxies Preview</span>
            </DialogTitle>
            <DialogDescription className="text-xs text-[#9E9EA8]">
              Automate 1:1 disjoint proxy assignments across accounts on{" "}
              <strong className="text-zinc-200">{selectedNodeName}</strong>.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 my-2 text-xs">
            {/* Preservation Toggle */}
            <div className="p-3 rounded-xl bg-[#0F0F13] border border-[#23232C] flex items-center justify-between gap-3">
              <div>
                <span className="font-semibold text-zinc-200 block">Preserve Healthy Bindings</span>
                <span className="text-[11px] text-[#9E9EA8]">
                  Only assign unassigned accounts (recommended)
                </span>
              </div>
              <input
                type="checkbox"
                id="preserve-healthy-toggle"
                checked={onlyUnassignedAutoBind}
                onChange={(e) => setOnlyUnassignedAutoBind(e.target.checked)}
                className="size-4 accent-[#FF5B22] rounded cursor-pointer"
              />
            </div>

            {/* Plan Metrics */}
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="p-2.5 rounded-lg bg-[#0F0F13] border border-[#23232C]">
                <div className="text-[10px] text-[#9E9EA8] uppercase">Eligible Accounts</div>
                <div className="text-sm font-bold text-zinc-100 mt-0.5">
                  {eligibleAccountsCount}
                </div>
              </div>
              <div className="p-2.5 rounded-lg bg-[#0F0F13] border border-[#23232C]">
                <div className="text-[10px] text-[#9E9EA8] uppercase">Available Pools</div>
                <div className="text-sm font-bold text-zinc-100 mt-0.5">{availablePoolsCount}</div>
              </div>
              <div className="p-2.5 rounded-lg bg-[#0F0F13] border border-[#23232C]">
                <div className="text-[10px] text-[#9E9EA8] uppercase">New Bindings</div>
                <div className="text-sm font-bold text-[#FF5B22] mt-0.5">
                  {autoBindPlan.assignments.length}
                </div>
              </div>
            </div>

            {/* Assignment Preview List */}
            <div>
              <div className="font-semibold text-zinc-200 mb-1.5 flex items-center justify-between">
                <span>Proposed Assignments:</span>
                <span className="text-[11px] text-[#9E9EA8]">
                  {autoBindPlan.assignments.length} planned
                </span>
              </div>

              {autoBindPlan.assignments.length === 0 ? (
                <div className="p-4 rounded-xl bg-[#0F0F13] border border-[#23232C] text-center text-[#9E9EA8]">
                  No changes needed. All eligible accounts already have active proxy assignments.
                </div>
              ) : (
                <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1 scrollbar-thin">
                  {autoBindPlan.assignments.map((asgn) => {
                    const conn = connections.find((c) => c.id === asgn.connectionId);
                    const pool = pools.find((p) => p.id === asgn.poolId);
                    return (
                      <div
                        key={asgn.connectionId}
                        className="flex items-center justify-between p-2 rounded-lg bg-[#0F0F13] border border-[#23232C] text-xs font-mono"
                      >
                        <span className="text-zinc-200 truncate max-w-[180px]">
                          {conn?.name || conn?.email || asgn.connectionId}
                        </span>
                        <span className="text-[#9E9EA8] px-2">&rarr;</span>
                        <span className="text-[#FF5B22] truncate max-w-[180px] font-semibold">
                          {pool?.name || asgn.poolId}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <DialogFooter className="pt-2 border-t border-[#23232C] flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConfirmAutoDistribute(false)}
              disabled={distributing}
              className="h-8 text-xs border-[#23232C] bg-[#1C1C24] text-zinc-300 hover:text-white cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleExecuteAutoDistribute}
              disabled={distributing || autoBindPlan.assignments.length === 0}
              className="h-8 px-3.5 text-xs font-extrabold bg-[#FF5B22] hover:bg-[#FF3D00] text-black shadow-sm shadow-[#FF5B22]/25 border-0 gap-1.5 cursor-pointer"
            >
              {distributing ? (
                <Loader2 className="size-3 animate-spin mr-1" />
              ) : (
                <CheckCheck className="size-3 mr-1" />
              )}
              <span>Execute Distribution</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset Proxies Confirmation Dialog */}
      <Dialog
        open={confirmResetProxies}
        onOpenChange={(open) => !open && !resettingProxies && setConfirmResetProxies(false)}
      >
        <DialogContent className="max-w-md bg-[#131318] border-[#23232C] text-zinc-100 p-6 rounded-2xl shadow-2xl">
          <DialogHeader className="space-y-1.5 pb-2 border-b border-[#23232C]">
            <DialogTitle className="text-base font-bold text-[#FF5B22] flex items-center gap-2">
              <RotateCcw className="size-4" />
              <span>Global Proxy Diagnostic & Reset</span>
            </DialogTitle>
            <DialogDescription className="text-xs text-[#9E9EA8]">
              Audit all Antigravity accounts for 403 Forbidden or broken proxies and automatically
              reassign them to clean proxies.
            </DialogDescription>
          </DialogHeader>

          <div className="p-3 rounded-lg bg-[#0F0F13] border border-[#23232C] text-xs text-[#9E9EA8] space-y-1.5 my-2">
            <p>&bull; Scans active Antigravity account quotas and transport health.</p>
            <p>
              &bull; Automatically replaces forbidden proxies with verified available standby
              proxies.
            </p>
            <p className="text-amber-400 font-semibold">
              &bull; Scope: Global across all active nodes and connected accounts.
            </p>
          </div>

          <DialogFooter className="pt-2 border-t border-[#23232C] flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConfirmResetProxies(false)}
              disabled={resettingProxies}
              className="h-8 text-xs border-[#23232C] bg-[#1C1C24] text-zinc-300 hover:text-white cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={async () => {
                setConfirmResetProxies(false);
                await handleResetProxies();
              }}
              disabled={resettingProxies}
              className="h-8 px-3.5 text-xs font-semibold border border-[#FF5B22]/40 bg-[#131318] text-[#FF5B22] hover:bg-[#FF5B22]/10 hover:border-[#FF5B22] gap-1.5 cursor-pointer"
            >
              {resettingProxies ? (
                <RotateCcw className="size-3 animate-spin mr-1" />
              ) : (
                <RotateCcw className="size-3 mr-1" />
              )}
              <span>Run Diagnostic & Reset</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
