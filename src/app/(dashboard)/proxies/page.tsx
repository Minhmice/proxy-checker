"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2, RefreshCw, Zap } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth-provider";
import {
  checkProxyValidity,
  downloadProxyExport,
  fetchUnifiedProxies,
  setProxyPin,
  unlinkProxyFromRouter,
  pushProxyToRouter,
  hardDeleteProxy,
  triggerUnifiedSync,
  triggerOptimizeAccountsBySpeed,
} from "@/lib/api";
import { importIntelligenceProxies } from "@/lib/proxy-intelligence-api";
import { isAbortError } from "@/lib/request-lifecycle";
import type { UnifiedProxyItem, UnifiedProxyCounts } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ProxyDetailDrawer } from "@/components/proxy-detail-drawer";
import { ProxySummary } from "@/components/proxies/proxy-summary";
import { ProxyToolbar } from "@/components/proxies/proxy-toolbar";
import { ProxyTable } from "@/components/proxies/proxy-table";
import { ProxySelectionBar } from "@/components/proxies/proxy-selection-bar";
import { ProxyImportDialog } from "@/components/proxies/proxy-import-dialog";
import { ProxyExportDialog } from "@/components/proxies/proxy-export-dialog";
import {
  parseProxyQuery,
  serializeProxyQuery,
  type ProxyWorkspaceQuery,
} from "@/lib/proxy-url-state";

export default function ProxiesPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // URL Query State
  const initialQuery = useMemo(() => parseProxyQuery(searchParams), [searchParams]);
  const [query, setQuery] = useState<ProxyWorkspaceQuery>(initialQuery);
  const [debouncedSearch, setDebouncedSearch] = useState(initialQuery.q);

  // Sync state if URL changes externally
  useEffect(() => {
    const parsed = parseProxyQuery(searchParams);
    setQuery((prev) => {
      if (
        prev.q === parsed.q &&
        prev.health === parsed.health &&
        prev.protocol === parsed.protocol &&
        prev.source === parsed.source &&
        prev.sort === parsed.sort &&
        prev.direction === parsed.direction &&
        prev.page === parsed.page &&
        prev.pageSize === parsed.pageSize
      ) {
        return prev;
      }
      return parsed;
    });
  }, [searchParams]);

  const updateQuery = useCallback(
    (patch: Partial<ProxyWorkspaceQuery>) => {
      const next = { ...query, ...patch };
      setQuery(next);
      const serialized = serializeProxyQuery(next);
      router.replace(`${pathname}${serialized ? `?${serialized}` : ""}`, { scroll: false });
    },
    [pathname, router, query],
  );

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
  const [optimizingSpeed, setOptimizingSpeed] = useState(false);
  const [confirmDeleteProxy, setConfirmDeleteProxy] = useState<UnifiedProxyItem | null>(null);
  const [checkingKey, setCheckingKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Selection
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [selectAllMatching, setSelectAllMatching] = useState(false);

  // Drawer
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [inspectProxy, setInspectProxy] = useState<UnifiedProxyItem | null>(null);

  // Add Proxy Dialog
  const [newProxyOpen, setNewProxyOpen] = useState(false);
  const [newProxyText, setNewProxyText] = useState("");
  const [addingProxy, setAddingProxy] = useState(false);
  // Import and Export Dialogs
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(query.q);
    }, 250);
    return () => {
      clearTimeout(timer);
    };
  }, [query.q]);

  // Load Proxies
  const loadProxies = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const res = await fetchUnifiedProxies(
          {
            health: query.health,
            search: debouncedSearch.trim() || undefined,
            protocol: query.protocol !== "all" ? query.protocol : undefined,
            source: query.source || undefined,
            sort: query.sort,
            direction: query.direction,
            page: query.page,
            pageSize: query.pageSize,
          },
          signal,
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
    },
    [
      query.health,
      debouncedSearch,
      query.protocol,
      query.source,
      query.sort,
      query.direction,
      query.page,
      query.pageSize,
    ],
  );

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    const controller = new AbortController();
    abortRef.current = controller;

    void loadProxies(controller.signal).catch(() => {});
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, [loadProxies]);

  // Unified Sync (Check 9Router + Evict + Auto-Rename + Antigravity)
  const handleUnifiedSync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      toast.info("Starting sync and health check cycle...");
      const res = await triggerUnifiedSync();
      if (res.started) {
        toast.success("Completed 9Router sync and health check cycle");
      } else {
        toast.info(res.error || "Sync running in background");
      }
      await loadProxies();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  // Optimize Antigravity Accounts by Speed
  const handleOptimizeSpeed = async () => {
    if (optimizingSpeed) return;
    setOptimizingSpeed(true);
    try {
      const res = await triggerOptimizeAccountsBySpeed();
      if (res.ok) {
        toast.success(`Optimized high-speed proxy assignment for ${res.updated ?? 0} accounts`);
      } else {
        toast.error("Failed to optimize assignment by speed");
      }
      await loadProxies();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setOptimizingSpeed(false);
    }
  };

  // Sync 9Router legacy handler
  const handleSync9Router = handleUnifiedSync;

  // Add Single Proxy
  const handleAddProxy = async () => {
    if (!newProxyText.trim() || addingProxy) return;
    setAddingProxy(true);
    try {
      const res = await importIntelligenceProxies({
        source: "manual-entry",
        content: newProxyText.trim(),
      });
      if (res.inserted > 0) {
        toast.success("Added proxy successfully");
        setNewProxyText("");
        setNewProxyOpen(false);
        void loadProxies();
      } else {
        toast.error("Invalid proxy format. Use protocol://host:port or host:port");
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setAddingProxy(false);
    }
  };

  // Check Single Proxy (Row-local)
  const handleCheckSingle = async (proxy: UnifiedProxyItem) => {
    const key = proxy.key || proxy.proxyKey;
    if (checkingKey) return;
    setCheckingKey(key);
    try {
      const res = await checkProxyValidity(key);
      const verdict = res.proxy.health?.toUpperCase() || res.proxy.status.toUpperCase();
      toast.success(`Check completed for ${proxy.name || key}: ${verdict}`);
      await loadProxies();
      if ((inspectProxy?.key || inspectProxy?.proxyKey) === key) {
        setInspectProxy(res.proxy);
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setCheckingKey(null);
    }
  };

  // Bulk Audit
  // Pin Toggle
  const handleTogglePin = async (proxy: UnifiedProxyItem) => {
    try {
      const nextState = !proxy.isPinned;
      await setProxyPin(proxy.proxyKey, nextState);
      toast.success(nextState ? "Proxy protected (pinned)" : "Proxy protection removed (unpinned)");
      await loadProxies();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  // Unlink from 9Router
  const handleUnlinkRouter = async (proxy: UnifiedProxyItem) => {
    try {
      await unlinkProxyFromRouter(proxy.proxyKey);
      toast.success("Unlinked proxy from 9Router (retained in app)");
      await loadProxies();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  // Push to 9Router
  const handlePushRouter = async (proxy: UnifiedProxyItem) => {
    try {
      await pushProxyToRouter(proxy.proxyKey);
      toast.success("Pushed proxy to 9Router successfully");
      await loadProxies();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  // Hard Delete
  const handleHardDelete = (proxy: UnifiedProxyItem) => {
    setConfirmDeleteProxy(proxy);
  };

  // Bulk Pin
  const handlePinSelected = async () => {
    if (selectedKeys.size === 0) return;
    try {
      for (const key of selectedKeys) {
        await setProxyPin(key, true);
      }
      toast.success(`Protected ${selectedKeys.size} proxies (pinned)`);
      setSelectedKeys(new Set());
      await loadProxies();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  // Bulk Delete
  const handleDeleteSelected = async () => {
    if (selectedKeys.size === 0) return;
    try {
      for (const key of selectedKeys) {
        await hardDeleteProxy(key, true);
      }
      toast.success(`Permanently deleted ${selectedKeys.size} proxies`);
      setSelectedKeys(new Set());
      await loadProxies();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  // Advanced Export handler
  const handleExecuteExport = async (options: {
    scope: "filtered" | "selected";
    format: "txt" | "csv";
    includeCredentials: boolean;
  }) => {
    try {
      const { blob, filename } = await downloadProxyExport(
        options.format,
        options.includeCredentials,
        {
          scope: options.scope === "selected" ? "all" : "usable",
        },
      );
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
      throw err;
    }
  };

  // Copy Endpoint
  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(text);
    toast.success("Copied to clipboard");
    setTimeout(() => {
      setCopiedKey((curr) => (curr === text ? null : curr));
    }, 2000);
  };

  // Open Drawer
  const handleOpenDetail = (proxy: UnifiedProxyItem) => {
    setInspectProxy(proxy);
    setDrawerOpen(true);
  };

  // Selection handlers
  const handleToggleSelectKey = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setSelectAllMatching(false);
  };

  const handleToggleSelectAllPage = () => {
    const pageKeys = items.map((i) => i.key || i.proxyKey);
    const allSelected = pageKeys.length > 0 && pageKeys.every((k) => selectedKeys.has(k));
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const k of pageKeys) next.delete(k);
      } else {
        for (const k of pageKeys) next.add(k);
      }
      return next;
    });
    setSelectAllMatching(false);
  };

  const pageKeys = items.map((i) => i.key || i.proxyKey);
  const allPageSelected = pageKeys.length > 0 && pageKeys.every((k) => selectedKeys.has(k));

  return (
    <div className="flex flex-col gap-5 p-4 sm:p-6 3xl:p-8 w-full max-w-none 4xl:max-w-[3600px] mx-auto">
      {/* Page Title & Subtitle + Top Action Buttons */}
      <div className="relative overflow-hidden rounded-2xl border border-border/80 bg-card/75 p-5 sm:p-6 backdrop-blur-xl shadow-md flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-foreground font-mono">
              Proxy Fleet Mesh
            </h1>
            <Badge
              variant="outline"
              className="font-mono text-xs px-2.5 py-0.5 rounded-full bg-primary/10 text-primary border-primary/30"
            >
              {total.toLocaleString()} total
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            9Router intelligent pool wrapper: automated health verification, latency ranking, and
            Antigravity rotation.
          </p>
        </div>
        <div className="flex items-center gap-2.5 flex-wrap sm:flex-nowrap shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={handleOptimizeSpeed}
            disabled={optimizingSpeed}
            className="h-9 text-xs font-mono gap-1.5 border-border/80 bg-surface/70 hover:bg-surface-raised cursor-pointer shadow-2xs"
          >
            {optimizingSpeed ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Zap className="h-3.5 w-3.5 text-amber-400" />
            )}
            <span>Optimize by speed</span>
          </Button>
          <Button
            size="sm"
            variant="halo"
            onClick={handleUnifiedSync}
            disabled={syncing}
            className="h-9 text-xs font-mono gap-1.5 text-primary-foreground shadow-[0_0_16px_rgba(255,91,34,0.35)] cursor-pointer"
          >
            {syncing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            <span>Sync & check fleet</span>
          </Button>
        </div>
      </div>
      {/* 3-Tier Status Pills */}
      <ProxySummary
        facets={counts}
        activeHealth={query.health}
        onHealthChange={(health) => updateQuery({ health, page: 1 })}
      />

      {/* Toolbar */}
      <ProxyToolbar
        query={query}
        onQueryChange={updateQuery}
        onSync9Router={handleSync9Router}
        syncing={syncing}
        onOpenImport={() => setImportOpen(true)}
        onOpenExport={() => setExportOpen(true)}
        onOpenAdd={() => setNewProxyOpen(true)}
      />

      {/* Selection Action Bar */}
      <ProxySelectionBar
        selectedCount={selectedKeys.size}
        totalMatching={total}
        selectAllMatching={selectAllMatching}
        onSelectAllMatchingToggle={setSelectAllMatching}
        onPinSelected={handlePinSelected}
        onDeleteSelected={handleDeleteSelected}
        onExportSelected={() => setExportOpen(true)}
        onClearSelection={() => {
          setSelectedKeys(new Set());
          setSelectAllMatching(false);
        }}
      />
      {/* Proxies Table */}
      <ProxyTable
        items={items}
        loading={loading}
        page={query.page}
        pageSize={query.pageSize}
        total={total}
        onPageChange={(page) => updateQuery({ page })}
        selectedKeys={selectedKeys}
        onToggleSelectKey={handleToggleSelectKey}
        onToggleSelectAllPage={handleToggleSelectAllPage}
        allPageSelected={allPageSelected}
        checkingKey={checkingKey}
        onCheckSingle={handleCheckSingle}
        onOpenDetail={handleOpenDetail}
        copiedKey={copiedKey}
        onCopyEndpoint={handleCopy}
        onResetFilters={() => updateQuery({ q: "", health: "all", protocol: "all", page: 1 })}
        onTogglePin={handleTogglePin}
        onUnlinkRouter={handleUnlinkRouter}
        onPushRouter={handlePushRouter}
        onHardDelete={handleHardDelete}
      />
      {/* Detail Drawer */}
      <ProxyDetailDrawer
        proxy={inspectProxy}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        onProxyUpdated={(updated) => {
          setItems((prev) =>
            prev.map((item) =>
              (item.key || item.proxyKey) === (updated.key || updated.proxyKey) ? updated : item,
            ),
          );
          setInspectProxy(updated);
        }}
      />
      {/* Import Dialog */}
      <ProxyImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImportSuccess={() => void loadProxies()}
      />

      {/* Export Dialog */}
      <ProxyExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        selectedCount={selectedKeys.size}
        totalFiltered={total}
        onExport={handleExecuteExport}
      />

      {/* New Proxy Modal Dialog */}
      <Dialog open={newProxyOpen} onOpenChange={setNewProxyOpen}>
        <DialogContent className="sm:max-w-md bg-card border-border/80">
          <DialogHeader>
            <DialogTitle className="text-sm font-bold font-mono">Add Single Proxy</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Enter endpoint string. E.g.:{" "}
              <code className="text-foreground">socks5://user:pass@host:port</code> or{" "}
              <code className="text-foreground">host:port</code>
            </DialogDescription>
          </DialogHeader>

          <div className="py-2">
            <Input
              value={newProxyText}
              onChange={(e) => setNewProxyText(e.target.value)}
              placeholder="protocol://username:password@host:port"
              className="font-mono text-xs bg-surface border-border/60"
              autoFocus
            />
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setNewProxyOpen(false)}
              className="text-xs"
            >
              Cancel
            </Button>
            <Button size="sm" onClick={handleAddProxy} disabled={addingProxy} className="text-xs">
              {addingProxy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
              Add Proxy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm Hard Delete Dialog */}
      <Dialog
        open={Boolean(confirmDeleteProxy)}
        onOpenChange={(open) => !open && setConfirmDeleteProxy(null)}
      >
        <DialogContent className="sm:max-w-md bg-card border-border/80">
          <DialogHeader>
            <DialogTitle className="text-sm font-bold font-mono text-rose-400">
              Confirm Permanent Proxy Deletion
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {confirmDeleteProxy?.isPinned ? (
                <span className="text-rose-400 font-semibold block mt-1">
                  Warning: This proxy is PINNED (Protected). Deleting will permanently remove it
                  from both SQLite and 9Router!
                </span>
              ) : (
                "This proxy will be permanently deleted from the SQLite database and unlinked from 9Router (if linked)."
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="font-mono text-xs p-3 rounded bg-muted/30 border border-border/50 text-foreground">
            {confirmDeleteProxy?.name || `${confirmDeleteProxy?.host}:${confirmDeleteProxy?.port}`}
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmDeleteProxy(null)}
              className="text-xs"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="text-xs"
              onClick={async () => {
                if (!confirmDeleteProxy) return;
                try {
                  await hardDeleteProxy(confirmDeleteProxy.proxyKey, true);
                  toast.success("Proxy permanently deleted");
                  setConfirmDeleteProxy(null);
                  void loadProxies();
                } catch (err) {
                  toast.error((err as Error).message);
                }
              }}
            >
              Permanently delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
