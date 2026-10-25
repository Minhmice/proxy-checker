"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { toast } from "sonner";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  Clock,
  Database,
  Layers,
  Loader2,
  Play,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  fetchDualRouterStatus,
  fetchDualRouterConflicts,
  triggerDualRouterAudit,
  triggerDualRouterReconcile,
  resolveDualRouterConflict,
} from "@/lib/api";
import type {
  DualRouterConflict,
  DualRouterInfo,
  DualRouterStatusResponse,
  DualRouterValue,
} from "@/lib/types";
import { cn } from "@/lib/utils";

interface DualNineRouterCardProps {
  configuredUrl?: string;
  className?: string;
}

export function DualNineRouterCard({ configuredUrl = "", className }: DualNineRouterCardProps) {
  const { password, authenticated } = useAuth();

  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<DualRouterStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [isAuditing, setIsAuditing] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  // Conflicts modal state
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [conflictsLoading, setConflictsLoading] = useState(false);
  const [conflicts, setConflicts] = useState<DualRouterConflict[]>([]);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      setError(null);
      const res = await fetchDualRouterStatus(password);
      if (!mountedRef.current) return;
      if (res && res.ok !== false) {
        setStatus(res);
      } else {
        setStatus(null);
      }
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : "Failed to load dual router status";
      setError(msg);
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [password]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const loadConflicts = useCallback(async () => {
    setConflictsLoading(true);
    try {
      const res = await fetchDualRouterConflicts(password);
      if (!mountedRef.current) return;
      if (res && res.conflicts) {
        setConflicts(res.conflicts);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load conflicts";
      toast.error(msg);
    } finally {
      if (mountedRef.current) {
        setConflictsLoading(false);
      }
    }
  }, [password]);

  const handleOpenConflicts = useCallback(() => {
    setConflictsOpen(true);
    void loadConflicts();
  }, [loadConflicts]);

  const handleRunAudit = async () => {
    setIsAuditing(true);
    try {
      const res = await triggerDualRouterAudit(password);
      if (res && res.ok) {
        const report = res.report;
        const opCount = report.operations?.length ?? 0;
        const conflictCount = report.conflicts?.length ?? 0;
        toast.success(
          `Dry run audit completed (${report.status}): ${opCount} ops planned, ${conflictCount} conflicts.`,
        );
      } else {
        toast.error("Audit returned unsuccessful status");
      }
      await loadStatus();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Audit failed";
      toast.error(msg);
    } finally {
      if (mountedRef.current) {
        setIsAuditing(false);
      }
    }
  };

  const handleSyncReconcile = async () => {
    setIsSyncing(true);
    try {
      const res = await triggerDualRouterReconcile("incremental", password);
      if (res && res.ok) {
        const report = res.report;
        toast.success(`Sync reconciled successfully (${report.status})`);
      } else {
        toast.error("Reconciliation returned unsuccessful status");
      }
      await loadStatus();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Sync failed";
      toast.error(msg);
    } finally {
      if (mountedRef.current) {
        setIsSyncing(false);
      }
    }
  };

  const handleResolveConflict = async (
    conflict: DualRouterConflict,
    chosenValue: DualRouterValue,
    sourceName: string,
  ) => {
    setResolvingId(conflict.id);
    try {
      await resolveDualRouterConflict(conflict.id, conflict.revision, chosenValue, password);
      toast.success(`Resolved ${conflict.resource}/${conflict.key} accepting ${sourceName}`);
      await loadConflicts();
      await loadStatus();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to resolve conflict";
      toast.error(msg);
    } finally {
      if (mountedRef.current) {
        setResolvingId(null);
      }
    }
  };

  // Derive router info
  const parsedUrls = configuredUrl
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

  const router1: DualRouterInfo = status?.routers?.[0] ?? {
    id: "router-1",
    url: parsedUrls[0] || "http://127.0.0.1:20128",
    reachable: status?.routers?.[0]?.reachable ?? true,
    latencyMs: status?.routers?.[0]?.latencyMs ?? null,
    activePools: status?.routers?.[0]?.activePools ?? 0,
    totalPools: status?.routers?.[0]?.totalPools ?? 0,
    activeAccounts: status?.routers?.[0]?.activeAccounts ?? 0,
  };

  const hasSecondConfigured =
    (status?.routers && status.routers.length > 1) || parsedUrls.length > 1;

  const router2: DualRouterInfo | null = hasSecondConfigured
    ? (status?.routers?.[1] ?? {
        id: "router-2",
        url: parsedUrls[1] || "",
        reachable: status?.routers?.[1]?.reachable ?? false,
        latencyMs: status?.routers?.[1]?.latencyMs ?? null,
        activePools: status?.routers?.[1]?.activePools ?? 0,
        totalPools: status?.routers?.[1]?.totalPools ?? 0,
        activeAccounts: status?.routers?.[1]?.activeAccounts ?? 0,
      })
    : null;

  // Determine sync status badge
  const isSingleRouterMode = !hasSecondConfigured;
  const activeConflicts = status?.activeConflictsCount ?? 0;

  let syncBadgeText = "In Sync";
  let syncBadgeClass = "border-emerald-500/40 bg-emerald-500/10 text-emerald-400";
  let SyncIcon = CheckCircle2;

  if (isSingleRouterMode) {
    syncBadgeText = "Single Router Mode";
    syncBadgeClass = "border-primary/40 bg-primary/10 text-primary";
    SyncIcon = Server;
  } else if (activeConflicts > 0 || status?.status === "conflicted") {
    syncBadgeText = "Conflicts Pending";
    syncBadgeClass = "border-destructive/40 bg-destructive/10 text-destructive";
    SyncIcon = AlertTriangle;
  } else if (status?.status === "partial") {
    syncBadgeText = "Drift Detected";
    syncBadgeClass = "border-amber-500/40 bg-amber-500/10 text-amber-400";
    SyncIcon = AlertCircle;
  } else if (status?.status === "busy") {
    syncBadgeText = "Syncing…";
    syncBadgeClass = "border-primary/40 bg-primary/10 text-primary";
    SyncIcon = RefreshCw;
  } else if (status?.status === "verified") {
    syncBadgeText = "In Sync";
    syncBadgeClass = "border-emerald-500/40 bg-emerald-500/10 text-emerald-400";
    SyncIcon = CheckCircle2;
  } else if (status?.status === "blocked") {
    syncBadgeText = "Drift Detected";
    syncBadgeClass = "border-amber-500/40 bg-amber-500/10 text-amber-400";
    SyncIcon = ShieldAlert;
  }

  const renderRouterCard = (
    title: string,
    subtitle: string,
    info: DualRouterInfo | null,
    isConfigured: boolean,
  ) => {
    if (!isConfigured || !info) {
      return (
        <div className="flex flex-col justify-between rounded-xl border border-dashed border-border/80 bg-muted/10 p-4 min-h-[160px]">
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                {title}
              </span>
              <Badge variant="outline" className="text-[10px] text-muted-foreground border-border">
                Not Configured
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          </div>
          <p className="text-xs text-muted-foreground italic mt-4">
            Add a secondary 9Router URL in endpoint settings to enable dual-master synchronization.
          </p>
        </div>
      );
    }

    const isReachable = info.reachable ?? !info.error;

    return (
      <div className="rounded-xl border border-border/70 bg-card p-4 space-y-3.5 shadow-xs">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-foreground">
                {title}
              </span>
              <span className="text-[11px] text-muted-foreground">({subtitle})</span>
            </div>
            <p
              className="font-mono text-xs text-muted-foreground truncate max-w-[280px] sm:max-w-[340px]"
              title={info.url}
            >
              {info.url || "http://127.0.0.1:20128"}
            </p>
          </div>
          {isReachable ? (
            <Badge
              variant="outline"
              className="shrink-0 border-emerald-500/40 bg-emerald-500/10 text-emerald-400 text-[10px] py-0.5 px-2 flex items-center gap-1"
            >
              <Wifi className="size-3" />
              Online
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="shrink-0 border-destructive/40 bg-destructive/10 text-destructive text-[10px] py-0.5 px-2 flex items-center gap-1"
            >
              <WifiOff className="size-3" />
              Unreachable
            </Badge>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2 pt-1 border-t border-border/50 text-center">
          <div className="rounded-lg bg-muted/30 p-2">
            <div className="text-[10px] font-medium text-muted-foreground uppercase">
              Pools (Act/Tot)
            </div>
            <div className="text-sm font-semibold font-mono text-foreground mt-0.5">
              {info.activePools ?? 0} / {info.totalPools ?? 0}
            </div>
          </div>
          <div className="rounded-lg bg-muted/30 p-2">
            <div className="text-[10px] font-medium text-muted-foreground uppercase">
              Active Accs
            </div>
            <div className="text-sm font-semibold font-mono text-foreground mt-0.5">
              {info.activeAccounts ?? 0}
            </div>
          </div>
          <div className="rounded-lg bg-muted/30 p-2">
            <div className="text-[10px] font-medium text-muted-foreground uppercase">Latency</div>
            <div className="text-sm font-semibold font-mono text-foreground mt-0.5">
              {info.latencyMs !== null && info.latencyMs !== undefined
                ? `${info.latencyMs} ms`
                : "—"}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      <Card className={cn("shadow-sm", className)}>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-lg bg-primary/10 text-primary border border-primary/20">
                <ArrowRightLeft className="size-4" />
              </div>
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  Dual 9Router Synchronization & Control
                </CardTitle>
                <CardDescription>
                  Active-active dual master replication, state consistency, and conflict
                  reconciliation.
                </CardDescription>
              </div>
            </div>

            <div className="flex items-center gap-2 self-start sm:self-auto">
              <Badge
                variant="outline"
                className={cn(
                  "text-xs py-1 px-2.5 font-medium flex items-center gap-1.5",
                  syncBadgeClass,
                )}
              >
                <SyncIcon className="size-3.5" />
                {syncBadgeText}
              </Badge>
              <Button
                variant="ghost"
                size="icon-xs"
                className="size-7 text-muted-foreground hover:text-foreground"
                onClick={() => void loadStatus()}
                disabled={loading}
                title="Refresh Status"
              >
                <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-5">
          {error && (
            <Alert variant="destructive" className="py-2.5 text-xs">
              <AlertCircle className="size-4" />
              <AlertTitle className="text-xs font-semibold">
                Synchronization Status Warning
              </AlertTitle>
              <AlertDescription className="text-xs">{error}</AlertDescription>
            </Alert>
          )}

          {/* Side by side Router 1 and Router 2 metrics */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {renderRouterCard("Router 1", "LAN Master", router1, true)}
            {renderRouterCard("Router 2", "Cloud Master", router2, hasSecondConfigured)}
          </div>

          {/* Sync Information Metadata */}
          {status?.lastVerifiedRun && (
            <div className="flex flex-wrap items-center justify-between text-xs text-muted-foreground px-1 pt-1">
              <span className="flex items-center gap-1">
                <Clock className="size-3" />
                Last verified:{" "}
                {status.lastVerifiedRun.verifiedAt
                  ? new Date(status.lastVerifiedRun.verifiedAt).toLocaleTimeString()
                  : "Recently"}
              </span>
              <span>Operations recorded: {status.lastVerifiedRun.operations?.length ?? 0}</span>
            </div>
          )}
        </CardContent>

        <CardFooter className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-border/50">
          <div className="flex items-center gap-2">
            {activeConflicts > 0 ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={handleOpenConflicts}
                className="text-xs h-8"
              >
                <AlertTriangle className="size-3.5 mr-1.5" />
                Resolve Conflicts ({activeConflicts})
              </Button>
            ) : (
              <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                <ShieldCheck className="size-3.5 text-emerald-400" />
                No active conflicts
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRunAudit}
              disabled={isAuditing || isSyncing}
              className="text-xs h-8"
            >
              {isAuditing ? (
                <>
                  <Loader2 className="size-3 mr-1.5 animate-spin" />
                  Auditing…
                </>
              ) : (
                <>
                  <Play className="size-3 mr-1.5" />
                  Run Audit (Dry Run)
                </>
              )}
            </Button>

            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={handleSyncReconcile}
              disabled={isSyncing || isAuditing}
              className="text-xs h-8"
            >
              {isSyncing ? (
                <>
                  <Loader2 className="size-3 mr-1.5 animate-spin" />
                  Reconciling…
                </>
              ) : (
                <>
                  <RefreshCw className="size-3 mr-1.5" />
                  Sync & Reconcile Now
                </>
              )}
            </Button>
          </div>
        </CardFooter>
      </Card>

      {/* Conflicts Resolution Dialog */}
      <Dialog open={conflictsOpen} onOpenChange={setConflictsOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="size-4 text-amber-500" />
              Resolve Synchronization Conflicts
            </DialogTitle>
            <DialogDescription className="text-xs">
              Discrepancies detected between Router 1 and Router 2. Select which router state should
              take precedence for each resource.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {conflictsLoading ? (
              <div className="flex items-center justify-center py-8 text-xs text-muted-foreground gap-2">
                <Loader2 className="size-4 animate-spin text-primary" />
                Loading pending conflicts…
              </div>
            ) : conflicts.length === 0 ? (
              <div className="text-center py-6 text-xs text-muted-foreground">
                <CheckCircle2 className="size-6 text-emerald-400 mx-auto mb-2" />
                All conflicts have been resolved or acknowledged.
              </div>
            ) : (
              <div className="space-y-3">
                {conflicts.map((conflict) => (
                  <div
                    key={conflict.id}
                    className="rounded-lg border border-border p-3 space-y-2.5 bg-muted/20"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="text-[10px] font-mono uppercase">
                          {conflict.resource}
                        </Badge>
                        <span className="font-mono text-xs font-semibold">{conflict.key}</span>
                        {conflict.field && (
                          <span className="text-xs text-muted-foreground">({conflict.field})</span>
                        )}
                      </div>
                      <Badge
                        variant="outline"
                        className="text-[10px] text-amber-400 border-amber-500/30"
                      >
                        {conflict.reason}
                      </Badge>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                      <div className="p-2 rounded bg-background border border-border/60 space-y-1">
                        <div className="text-[10px] font-semibold text-muted-foreground">
                          Router 1 (LAN)
                        </div>
                        <pre className="text-[11px] font-mono text-foreground overflow-x-auto max-h-20 whitespace-pre-wrap">
                          {JSON.stringify(conflict.a, null, 2)}
                        </pre>
                        <Button
                          size="xs"
                          variant="outline"
                          className="w-full text-[10px] h-6 mt-1"
                          disabled={resolvingId === conflict.id}
                          onClick={() => handleResolveConflict(conflict, conflict.a, "Router 1")}
                        >
                          {resolvingId === conflict.id ? "Resolving…" : "Accept Router 1"}
                        </Button>
                      </div>

                      <div className="p-2 rounded bg-background border border-border/60 space-y-1">
                        <div className="text-[10px] font-semibold text-muted-foreground">
                          Router 2 (Cloud)
                        </div>
                        <pre className="text-[11px] font-mono text-foreground overflow-x-auto max-h-20 whitespace-pre-wrap">
                          {JSON.stringify(conflict.b, null, 2)}
                        </pre>
                        <Button
                          size="xs"
                          variant="outline"
                          className="w-full text-[10px] h-6 mt-1"
                          disabled={resolvingId === conflict.id}
                          onClick={() => handleResolveConflict(conflict, conflict.b, "Router 2")}
                        >
                          {resolvingId === conflict.id ? "Resolving…" : "Accept Router 2"}
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <DialogFooter className="flex sm:justify-between items-center gap-2">
            <span className="text-[11px] text-muted-foreground">
              Total pending: {conflicts.length}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConflictsOpen(false)}
              className="text-xs"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
