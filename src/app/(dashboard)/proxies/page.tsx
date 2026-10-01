"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Globe,
  Loader2,
  MoreVertical,
  Plus,
  Play,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trash2,
  Upload,
  Wifi,
  XCircle,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth-provider";
import {
  checkProxyValidity,
  downloadProxyExport,
  fetchUnifiedProxies,
  syncPools,
} from "@/lib/api";
import { importIntelligenceProxies } from "@/lib/proxy-intelligence-api";
import { isAbortError } from "@/lib/request-lifecycle";
import type {
  UnifiedProxyItem,
  UnifiedProxyCounts,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
import { ProxyDetailDrawer } from "@/components/proxy-detail-drawer";

export default function ProxiesPage() {
  const { password } = useAuth();

  // Filters & Pagination
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [protocolFilter, setProtocolFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 50;

  // Data
  const [items, setItems] = useState<UnifiedProxyItem[]>([]);
  const [counts, setCounts] = useState<UnifiedProxyCounts>({
    all: 0,
    working: 0,
    regressed: 0,
    dead: 0,
  });
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  // In-flight actions
  const [syncing, setSyncing] = useState(false);
  const [checkingKey, setCheckingKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Drawer
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [inspectProxy, setInspectProxy] = useState<UnifiedProxyItem | null>(null);

  // New Proxy Dialog
  const [newProxyOpen, setNewProxyOpen] = useState(false);
  const [newProxyText, setNewProxyText] = useState("");
  const [addingProxy, setAddingProxy] = useState(false);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  // Load Proxies
  const loadProxies = useCallback(async (signal?: AbortSignal) => {
    if (!password) return;
    setLoading(true);
    try {
      const res = await fetchUnifiedProxies(
        password,
        {
          status: statusFilter,
          search: debouncedSearch.trim() || undefined,
          protocol: protocolFilter !== "all" ? protocolFilter : undefined,
          page,
          pageSize,
        },
        signal
      );
      if (signal?.aborted) return;
      setItems(res.items);
      setCounts(res.counts);
      setTotal(res.total);
    } catch (err) {
      if (!signal?.aborted && !isAbortError(err)) {
        toast.error((err as Error).message);
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, [password, statusFilter, debouncedSearch, protocolFilter, page, pageSize]);

  useEffect(() => {
    const controller = new AbortController();
    void loadProxies(controller.signal);
    return () => {
      controller.abort();
    };
  }, [loadProxies]);

  // Sync 9Router
  const handleSync9Router = async () => {
    if (!password || syncing) return;
    setSyncing(true);
    try {
      await syncPools(password);
      toast.success("9Router sync initiated");
      const { promise: delayPromise, resolve: delayResolve } = Promise.withResolvers<void>();
      setTimeout(delayResolve, 1200);
      await delayPromise;
      void loadProxies();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  // Import File
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !password) return;
    const text = await file.text();
    try {
      const res = await importIntelligenceProxies(password, {
        source: file.name,
        content: text,
      });
      toast.success(`Imported ${res.inserted} proxies (${res.invalid} invalid) from ${res.source}`);
      void loadProxies();
    } catch (err) {
      toast.error((err as Error).message);
    }
    e.target.value = "";
  };

  // Export File
  const handleExport = async () => {
    if (!password) return;
    try {
      const { blob, filename } = await downloadProxyExport(password, "txt", false);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`Exported proxies to ${filename}`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  // Add Single Proxy
  const handleAddProxy = async () => {
    if (!newProxyText.trim() || !password || addingProxy) return;
    setAddingProxy(true);
    try {
      const res = await importIntelligenceProxies(password, {
        source: "manual-entry",
        content: newProxyText.trim(),
      });
      if (res.inserted > 0) {
        toast.success(`Added proxy successfully`);
        setNewProxyText("");
        setNewProxyOpen(false);
        void loadProxies();
      } else {
        toast.error(`Invalid proxy format. Use protocol://host:port or host:port`);
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setAddingProxy(false);
    }
  };

  // Check Single Proxy
  const handleCheckSingle = async (proxy: UnifiedProxyItem) => {
    if (!password || checkingKey) return;
    setCheckingKey(proxy.key);
    try {
      const res = await checkProxyValidity(password, proxy.key);
      toast.success(`Check completed: ${res.proxy.status.toUpperCase()}`);
      setItems((prev) => prev.map((item) => (item.key === proxy.key ? res.proxy : item)));
      if (inspectProxy?.key === proxy.key) {
        setInspectProxy(res.proxy);
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setCheckingKey(null);
    }
  };

  // Copy Endpoint
  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(text);
    setTimeout(() => setCopiedKey(null), 1500);
    toast.success(`Copied ${text}`);
  };

  // Open Drawer
  const handleOpenDetail = (proxy: UnifiedProxyItem) => {
    setInspectProxy(proxy);
    setDrawerOpen(true);
  };

  const totalPages = Math.ceil(total / pageSize) || 1;

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border/40 pb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Proxies</h1>
            <Badge variant="secondary" className="font-mono text-xs">
              {counts.all}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Manage proxy fleet, test connectivity, and sync with 9Router.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs gap-1.5"
            disabled={syncing}
            onClick={handleSync9Router}
          >
            <RotateCcw className={`h-3.5 w-3.5 ${syncing ? "animate-spin text-primary" : ""}`} />
            <span>Sync 9Router</span>
          </Button>

          <label className="inline-flex items-center gap-1.5 h-8 px-3 text-xs font-medium rounded-md border border-input bg-background hover:bg-accent cursor-pointer">
            <Upload className="h-3.5 w-3.5 text-muted-foreground" />
            <span>Import</span>
            <input type="file" accept=".txt" onChange={handleFileUpload} className="hidden" />
          </label>

          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs gap-1.5"
            onClick={handleExport}
          >
            <Download className="h-3.5 w-3.5 text-muted-foreground" />
            <span>Export</span>
          </Button>

          <Button
            size="sm"
            className="h-8 text-xs gap-1.5"
            onClick={() => setNewProxyOpen(true)}
          >
            <Plus className="h-3.5 w-3.5" />
            <span>New proxy</span>
          </Button>
        </div>
      </div>

      {/* Filter Bar with Status Pills */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-card p-3 rounded-lg border border-border/50">
        {/* Status Pills */}
        <div className="flex flex-wrap items-center gap-2">
          {/* All */}
          <button
            type="button"
            onClick={() => {
              setStatusFilter("all");
              setPage(1);
            }}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              statusFilter === "all"
                ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                : "bg-muted/50 text-muted-foreground hover:bg-muted"
            }`}
          >
            <span>All</span>
            <span className="font-mono text-[11px] opacity-80">{counts.all}</span>
          </button>

          {/* Working */}
          <button
            type="button"
            onClick={() => {
              setStatusFilter("working");
              setPage(1);
            }}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              statusFilter === "working"
                ? "bg-emerald-600 text-white font-semibold shadow-xs"
                : "bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/20"
            }`}
          >
            <CheckCircle2 className="h-3 w-3" />
            <span>Working</span>
            <span className="font-mono text-[11px] opacity-90">{counts.working}</span>
          </button>

          {/* Regressed (Formerly working, now dead) */}
          <button
            type="button"
            onClick={() => {
              setStatusFilter("regressed");
              setPage(1);
            }}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              statusFilter === "regressed"
                ? "bg-amber-600 text-white font-semibold shadow-xs"
                : "bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 border border-amber-500/20"
            }`}
          >
            <AlertTriangle className="h-3 w-3" />
            <span>Regressed</span>
            <span className="font-mono text-[11px] opacity-90">{counts.regressed}</span>
          </button>

          {/* Dead */}
          <button
            type="button"
            onClick={() => {
              setStatusFilter("dead");
              setPage(1);
            }}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              statusFilter === "dead"
                ? "bg-rose-600 text-white font-semibold shadow-xs"
                : "bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 border border-rose-500/20"
            }`}
          >
            <XCircle className="h-3 w-3" />
            <span>Dead</span>
            <span className="font-mono text-[11px] opacity-90">{counts.dead}</span>
          </button>
        </div>

        {/* Search & Protocol */}
        <div className="flex items-center gap-2.5">
          <div className="relative w-56 sm:w-64">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search host, port, IP, ISP..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 text-xs h-8"
            />
          </div>

          <select
            value={protocolFilter}
            onChange={(e) => {
              setProtocolFilter(e.target.value);
              setPage(1);
            }}
            className="h-8 px-2.5 text-xs rounded-md border border-input bg-background text-foreground"
          >
            <option value="all">All Protocols</option>
            <option value="socks5">SOCKS5</option>
            <option value="http">HTTP</option>
          </select>
        </div>
      </div>

      {/* DonutBrowser 7-Column Table */}
      <div className="rounded-lg border border-border/50 bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-muted/50 border-b border-border text-muted-foreground uppercase text-[10px]">
              <tr>
                <th className="p-3">Name</th>
                <th className="p-3">Protocol</th>
                <th className="p-3">Host : port</th>
                <th className="p-3">UDP</th>
                <th className="p-3">Status</th>
                <th className="p-3">Sync</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40 font-mono">
              {loading ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-muted-foreground font-sans">
                    <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2 text-primary" />
                    Loading proxies...
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-muted-foreground font-sans">
                    No proxies found matching current filters.
                  </td>
                </tr>
              ) : (
                items.map((p) => {
                  const isRowChecking = checkingKey === p.key;
                  return (
                    <tr
                      key={p.key}
                      className="hover:bg-muted/30 transition-colors group cursor-pointer"
                      onClick={() => handleOpenDetail(p)}
                    >
                      {/* Name */}
                      <td className="p-3 font-semibold text-foreground truncate max-w-[180px]">
                        {p.name}
                      </td>

                      {/* Protocol */}
                      <td className="p-3 uppercase">
                        <Badge variant="outline" className="text-[10px] font-mono tracking-wider">
                          {p.protocol}
                        </Badge>
                      </td>

                      {/* Host : port */}
                      <td className="p-3 text-muted-foreground" onClick={(e) => e.stopPropagation()}>
                        <div className="inline-flex items-center gap-1.5">
                          <span>
                            {p.host}:{p.port}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleCopy(`${p.host}:${p.port}`)}
                            className="p-1 hover:text-foreground opacity-60 hover:opacity-100 transition-opacity"
                            title="Copy host:port"
                          >
                            {copiedKey === `${p.host}:${p.port}` ? (
                              <Check className="h-3 w-3 text-emerald-400" />
                            ) : (
                              <Copy className="h-3 w-3" />
                            )}
                          </button>
                        </div>
                      </td>

                      {/* UDP */}
                      <td className="p-3">
                        <Badge
                          variant={p.udp === "Yes" ? "default" : "secondary"}
                          className={p.udp === "Yes" ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px]" : "text-[10px]"}
                        >
                          {p.udp}
                        </Badge>
                      </td>

                      {/* Status */}
                      <td className="p-3">
                        {p.status === "working" && (
                          <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px] gap-1">
                            <span className="size-1.5 rounded-full bg-emerald-400" />
                            Working
                          </Badge>
                        )}
                        {p.status === "regressed" && (
                          <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30 text-[10px] gap-1">
                            <span className="size-1.5 rounded-full bg-amber-400" />
                            Regressed
                          </Badge>
                        )}
                        {p.status === "dead" && (
                          <Badge className="bg-rose-500/15 text-rose-400 border-rose-500/30 text-[10px] gap-1">
                            <span className="size-1.5 rounded-full bg-rose-400" />
                            Dead
                          </Badge>
                        )}
                      </td>

                      {/* Sync */}
                      <td className="p-3">
                        {p.sync === "active" && (
                          <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px]">
                            Active
                          </Badge>
                        )}
                        {p.sync === "reserve" && (
                          <Badge variant="secondary" className="text-[10px]">
                            Reserve
                          </Badge>
                        )}
                        {p.sync === "unsynced" && (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="p-3 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1 font-sans">
                          {/* Quick Check */}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            disabled={isRowChecking}
                            onClick={() => handleCheckSingle(p)}
                            title="Check validity"
                          >
                            {isRowChecking ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                            ) : (
                              <RotateCcw className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground" />
                            )}
                          </Button>

                          {/* Open Detail Drawer */}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            onClick={() => handleOpenDetail(p)}
                            title="View Connection Test & History"
                          >
                            <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Bar */}
        <div className="flex items-center justify-between p-3 border-t border-border/40 text-xs text-muted-foreground font-sans">
          <div>
            Showing {items.length > 0 ? (page - 1) * pageSize + 1 : 0} to{" "}
            {Math.min(page * pageSize, total)} of {total} proxies
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="text-xs font-medium text-foreground">
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {/* DonutBrowser Detail & Evidence Drawer */}
      <ProxyDetailDrawer
        proxy={inspectProxy}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        onProxyUpdated={(updated) => {
          setItems((prev) => prev.map((item) => (item.key === updated.key ? updated : item)));
          setInspectProxy(updated);
        }}
      />

      {/* New Proxy Dialog */}
      <Dialog open={newProxyOpen} onOpenChange={setNewProxyOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-bold">Add New Proxy</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Enter proxy string in format: <code className="font-mono text-foreground">protocol://username:password@host:port</code> or <code className="font-mono text-foreground">host:port</code>
            </DialogDescription>
          </DialogHeader>

          <div className="py-2">
            <Input
              placeholder="e.g. socks5://100.71.252.27:10001"
              value={newProxyText}
              onChange={(e) => setNewProxyText(e.target.value)}
              className="font-mono text-xs"
              autoFocus
            />
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setNewProxyOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!newProxyText.trim() || addingProxy}
              onClick={handleAddProxy}
            >
              {addingProxy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
              Add Proxy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
