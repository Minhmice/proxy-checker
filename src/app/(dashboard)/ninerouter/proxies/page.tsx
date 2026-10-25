"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Shuffle, RefreshCw, Server, CheckCheck, Search, Filter, X } from "lucide-react";
import {
  AccountBindingsTable,
  type AntigravityConnection,
} from "@/components/ninerouter/account-bindings-table";
import { ProxyPoolsTable, type ProxyPoolItem } from "@/components/ninerouter/proxy-pools-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { motion } from "motion/react";
import { toast } from "sonner";

const NODES = [
  { id: "server-lan", name: "Master Node (192.168.1.54)" },
  { id: "server-vpn", name: "Tailscale Node (100.73.175.42)" },
];

type FilterType = "all" | "active" | "bound" | "unbound";

export default function NineRouterProxiesPage() {
  const [selectedNode, setSelectedNode] = useState("server-lan");
  const [connections, setConnections] = useState<AntigravityConnection[]>([]);
  const [pools, setPools] = useState<ProxyPoolItem[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; elapsedMs?: number; error?: string }>
  >({});
  const [testingMap, setTestingMap] = useState<Record<string, boolean>>({});

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [resConns, resPools] = await Promise.all([
        fetch(`/api/ninerouter/nodes/${encodeURIComponent(selectedNode)}/connections`),
        fetch(`/api/ninerouter/nodes/${encodeURIComponent(selectedNode)}/proxy-pools`),
      ]);

      if (resConns.ok) {
        const dataConns = await resConns.json();
        setConnections(dataConns.connections || []);
      }

      if (resPools.ok) {
        const dataPools = await resPools.json();
        setPools(dataPools.proxyPools || []);
      }
    } catch (err) {
      toast.error(`Failed to load 9Router node data: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [selectedNode]);

  useEffect(() => {
    loadData();
  }, [loadData]);

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

  const handleToggleConnection = async (id: string, current: boolean) => {
    try {
      const res = await fetch(
        `/api/ninerouter/nodes/${encodeURIComponent(selectedNode)}/connections/${encodeURIComponent(id)}/bind-pool`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive: !current }),
        },
      );
      if (res.ok) {
        setConnections((prev) => prev.map((c) => (c.id === id ? { ...c, isActive: !current } : c)));
        toast.success("Account status updated");
      }
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const handleTogglePool = async (poolId: string, current: boolean) => {
    try {
      const res = await fetch(
        `/api/ninerouter/nodes/${encodeURIComponent(selectedNode)}/proxy-pools/${encodeURIComponent(poolId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive: !current }),
        },
      );
      if (res.ok) {
        setPools((prev) => prev.map((p) => (p.id === poolId ? { ...p, isActive: !current } : p)));
        toast.success("Pool status updated");
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

    try {
      const res = await fetch(
        `/api/ninerouter/nodes/${encodeURIComponent(selectedNode)}/connections/${encodeURIComponent(selectedConnectionId)}/bind-pool`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ poolId }),
        },
      );

      if (res.ok) {
        setConnections((prev) =>
          prev.map((c) =>
            c.id === selectedConnectionId
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
        toast.error("Failed to bind proxy pool");
      }
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const handleUnbind = async (connectionId: string) => {
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
        toast.success("Proxy unbound from account");
      } else {
        toast.error("Failed to unbind proxy");
      }
    } catch (err) {
      toast.error((err as Error).message);
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

  const handleDeletePool = async (poolId: string) => {
    try {
      const res = await fetch(
        `/api/ninerouter/nodes/${encodeURIComponent(selectedNode)}/proxy-pools/${encodeURIComponent(poolId)}`,
        { method: "DELETE" },
      );
      if (res.ok) {
        setPools((prev) => prev.filter((p) => p.id !== poolId));
        toast.success("Proxy pool deleted");
      }
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const handleAutoDistribute = async () => {
    const activePools = pools.filter((p) => p.isActive);
    if (activePools.length === 0) {
      toast.error("No active proxy pools available for distribution");
      return;
    }

    toast.info("Distributing proxy pools across Antigravity accounts...");
    for (let i = 0; i < connections.length; i++) {
      const conn = connections[i];
      const pool = activePools[i % activePools.length];
      await fetch(
        `/api/ninerouter/nodes/${encodeURIComponent(selectedNode)}/connections/${encodeURIComponent(conn.id)}/bind-pool`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ poolId: pool.id }),
        },
      );
    }
    await loadData();
    toast.success("Proxy pools distributed evenly!");
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="space-y-5 pb-12"
    >
      {/* Top Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#23232C] pb-4">
        <div>
          <h1 className="text-xl md:text-2xl font-extrabold tracking-tight text-zinc-100 flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-lg bg-[#FF5B22]/15 text-[#FF5B22] border border-[#FF5B22]/30 shadow-[0_0_12px_rgba(255,91,34,0.2)]">
              <Shuffle className="size-5" />
            </span>
            9Router Proxies & Account Bindings
          </h1>
          <p className="text-xs text-[#9E9EA8] mt-1">
            Map Antigravity OAuth accounts to dedicated 9Router proxy pools side-by-side with
            instant one-click binding.
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
                onClick={() => setSelectedNode(n.id)}
                className={`h-7 px-3 text-xs font-semibold rounded-lg transition-all gap-1.5 ${
                  selectedNode === n.id
                    ? "bg-[#FF5B22] text-white font-bold shadow-sm shadow-[#FF5B22]/25"
                    : "text-[#9E9EA8] hover:text-zinc-100 hover:bg-white/[0.04]"
                }`}
              >
                <Server className="size-3" />
                {n.name.split(" ")[0]}
              </Button>
            ))}
          </div>

          {/* Flame Orange Action Button */}
          <Button
            size="sm"
            onClick={handleAutoDistribute}
            className="h-9 px-3.5 bg-gradient-to-r from-[#FF5B22] to-[#FF3D00] hover:brightness-110 text-white shadow-sm shadow-[#FF5B22]/25 border-0 gap-1.5 text-xs font-semibold"
          >
            <CheckCheck className="size-3.5 stroke-[2.5]" />
            Auto Bind
          </Button>

          {/* Refresh Button */}
          <Button
            size="sm"
            variant="outline"
            onClick={loadData}
            disabled={loading}
            className="h-9 border-[#23232C] bg-[#131318] text-zinc-300 hover:text-[#FF5B22] hover:border-[#FF5B22]/40 gap-1.5 text-xs font-semibold transition-all"
          >
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin text-[#FF5B22]" : ""}`} />
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
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#9E9EA8] hover:text-zinc-200"
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
              onClick={() => setActiveFilter(pill.id)}
              className={`h-7 px-3 text-xs font-medium rounded-lg transition-all border ${
                activeFilter === pill.id
                  ? "bg-[#FF5B22] text-white border-transparent shadow-sm shadow-[#FF5B22]/25 font-semibold"
                  : "bg-[#1C1C24] text-[#9E9EA8] border-[#23232C] hover:text-zinc-100 hover:border-zinc-700"
              }`}
            >
              {pill.label}
            </button>
          ))}
        </div>
      </div>

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
          loading={loading}
        />

        {/* Right Column: Proxy Pools */}
        <ProxyPoolsTable
          pools={filteredPools}
          selectedConnectionId={selectedConnectionId}
          onAssignToSelected={handleBindPool}
          onToggleActive={handleTogglePool}
          onTestPool={handleTestPool}
          onDeletePool={handleDeletePool}
          testResults={testResults}
          testingMap={testingMap}
          loading={loading}
        />
      </div>
    </motion.div>
  );
}
