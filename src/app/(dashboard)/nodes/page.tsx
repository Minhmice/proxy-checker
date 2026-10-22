"use client";

import { useEffect, useState, useMemo, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Server, Plus, RefreshCw, Copy, MoreVertical, ExternalLink, AlertTriangle, AlertCircle, Trash2, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth-provider";
import { authHeaders } from "@/lib/api";
import { isAbortError } from "@/lib/request-lifecycle";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatFleetNodeStatus, formatFleetNodeRole, formatHeartbeatStatus, formatPlatform, formatRelativeTime, formatPublicIpStatus, formatProxyActivation } from "@/lib/fleet-ui-utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { FleetNodeRecord, FleetNodeStatus, FleetNodeConfigurationView, FleetRemovalRecord } from "@/proxyfleet/types";
import { NodeContextMenu } from "@/components/nodes/node-context-menu";
import { EnrollWorkerWizard } from "@/components/nodes/enroll-worker-wizard";
import { DeleteNodeDialog } from "@/components/nodes/delete-node-dialog";
function NodeConfigConvergenceIndicator({ config }: { config: FleetNodeConfigurationView }) {
  if (config.status === "applied") {
    return (
      <span className="text-[11px] font-mono text-emerald-400 tracking-tight truncate max-w-[180px]" title={`Applied rev ${config.appliedRevision}/${config.desiredRevision}`}>
        Applied rev {config.appliedRevision}/{config.desiredRevision}
      </span>
    );
  }
  if (config.status === "pending") {
    return (
      <span className="text-[11px] font-mono text-amber-400 tracking-tight truncate max-w-[180px]" title={`Pending rev ${config.appliedRevision ?? "—"}/${config.desiredRevision}`}>
        Pending rev {config.appliedRevision ?? "—"}/{config.desiredRevision}
      </span>
    );
  }
  if (config.status === "failed") {
    return (
      <span
        className="text-[11px] font-mono text-rose-400 tracking-tight truncate max-w-[180px] cursor-help"
        title={config.error ? `Failed rev ${config.appliedRevision ?? "—"}/${config.desiredRevision}: ${config.error}` : `Failed rev ${config.appliedRevision ?? "—"}/${config.desiredRevision}`}
      >
        Failed rev {config.appliedRevision ?? "—"}/{config.desiredRevision}
      </span>
    );
  }
  return (
    <span className="text-[11px] font-mono text-muted-foreground/70 tracking-tight truncate max-w-[180px]" title={`Unknown rev —/${config.desiredRevision}`}>
      Unknown rev —/{config.desiredRevision}
    </span>
  );
}


export default function NodesPage() {
  const router = useRouter();
  const { password } = useAuth();
  const [nodes, setNodes] = useState<FleetNodeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [quickEndpointNode, setQuickEndpointNode] = useState<FleetNodeRecord | null>(null);
  const [quickProtocol, setQuickProtocol] = useState<"http" | "socks5">("http");
  const [quickPort, setQuickPort] = useState("20001");
  const [quickUsername, setQuickUsername] = useState("user1");
  const [quickPassword, setQuickPassword] = useState("");
  const [quickCreating, setQuickCreating] = useState(false);
  const [quickError, setQuickError] = useState<string | null>(null);
  const [deleteTargetNode, setDeleteTargetNode] = useState<FleetNodeRecord | null>(null);
  const [pendingRemovals, setPendingRemovals] = useState<FleetRemovalRecord[]>([]);
  const [retryingRemovalId, setRetryingRemovalId] = useState<string | null>(null);
  const [removalError, setRemovalError] = useState<string | null>(null);

  async function copyText(label: string, text: string | null) {
    if (!text) {
      toast.error(`${label} unavailable`);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied`);
    } catch {
      toast.error(`Could not copy ${label.toLowerCase()}`);
    }
  }

  async function createQuickEndpoint() {
    if (!quickEndpointNode) return;
    const port = parseInt(quickPort, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      setQuickError("Port must be between 1 and 65535");
      return;
    }
    if (!quickUsername.trim()) {
      setQuickError("Username cannot be empty");
      return;
    }
    setQuickCreating(true);
    setQuickError(null);
    try {
      const res = await fetch("/api/fleet/endpoints", {
        method: "POST",
        headers: authHeaders(password),
        credentials: "same-origin",
        body: JSON.stringify({
          nodeId: quickEndpointNode.id,
          protocol: quickProtocol,
          listenIp: quickEndpointNode.wireguard_ip,
          listenPort: port,
          username: quickUsername.trim(),
          password: quickPassword,
          enabled: true,
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        const msg = errData?.error || `Failed to create endpoint (${res.status} ${res.statusText})`;
        setQuickError(msg);
        toast.error(msg);
        return;
      }
      setQuickEndpointNode(null);
      setQuickError(null);
      setQuickPassword("");
      toast.success("Endpoint created");
      await loadNodes();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not create endpoint";
      setQuickError(msg);
      toast.error(msg);
    } finally {
      setQuickCreating(false);
    }
  }

  async function loadNodes(signal?: AbortSignal) {
    try {
      setLoading(true);
      const [nodesRes, removalsRes] = await Promise.all([
        fetch("/api/fleet/nodes", {
          headers: authHeaders(password),
          credentials: "same-origin",
          signal,
        }),
        fetch("/api/fleet/node-removals", {
          headers: authHeaders(password),
          credentials: "same-origin",
          signal,
        }).catch(() => null),
      ]);

      if (signal?.aborted) return;
      if (!nodesRes.ok) {
        const errData = await nodesRes.json().catch(() => null);
        const msg = errData?.error || `Failed to fetch nodes (${nodesRes.status} ${nodesRes.statusText})`;
        if (!signal?.aborted) {
          setError(msg);
        }
        return;
      }
      const data = await nodesRes.json();
      if (removalsRes) {
        if (!removalsRes.ok) {
          const errData = await removalsRes.json().catch(() => ({}));
          setRemovalError(errData.error || `Failed to fetch pending removals (HTTP ${removalsRes.status})`);
        } else {
          const remData = await removalsRes.json().catch(() => null);
          if (remData && Array.isArray(remData.removals)) {
            setPendingRemovals(remData.removals);
            setRemovalError(null);
          } else {
            setRemovalError("Malformed pending removals payload");
          }
        }
      } else {
        setRemovalError("Network error fetching pending removals");
      }

      if (!signal?.aborted) {
        setNodes(data.nodes || []);
        setError(null);
        setLastUpdated(new Date());
      }
    } catch (err: unknown) {
      if (signal?.aborted || isAbortError(err)) {
        return;
      }
      const msg = err instanceof Error ? err.message : "Network error connecting to fleet service";
      setError(msg);
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }

  async function retryRemoval(removalId: string) {
    setRetryingRemovalId(removalId);
    try {
      const res = await fetch(`/api/fleet/node-removals/${encodeURIComponent(removalId)}/retry`, {
        method: "POST",
        headers: authHeaders(password),
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data.error || `Retry failed (HTTP ${res.status})`;
        toast.error(msg);
        return;
      }
      toast.success("Decommission retry initiated");
      void loadNodes();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Retry network error");
    } finally {
      setRetryingRemovalId(null);
    }
  }

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    const controller = new AbortController();
    abortRef.current = controller;

    void loadNodes(controller.signal);
    const interval = setInterval(() => {
      if (!controller.signal.aborted) {
        void loadNodes(controller.signal);
      }
    }, 15000);
    return () => {
      clearInterval(interval);
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, [password]);



  const activeNodes = useMemo(() => {
    const pendingIds = new Set(pendingRemovals.map((r) => r.nodeId));
    return nodes.filter((n) => !pendingIds.has(n.id));
  }, [nodes, pendingRemovals]);

  const filteredNodes = useMemo(() => {
    if (filterStatus === "all") return activeNodes;
    return activeNodes.filter((n) => n.status === filterStatus);
  }, [activeNodes, filterStatus]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Server className="size-6 text-primary" />
            Fleet Nodes
          </h1>
          <p className="text-sm text-muted-foreground">
            Manage remote proxy workers connected via WireGuard overlay.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void loadNodes()} disabled={loading}>
            <RefreshCw className={`size-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>

          <EnrollWorkerWizard
            password={password}
            onNodeEnrolled={loadNodes}
          />
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-2">
        {(["all", "online", "degraded", "offline"] as const).map((st) => (
          <Button
            key={st}
            size="sm"
            variant={filterStatus === st ? "default" : "outline"}
            onClick={() => setFilterStatus(st)}
            className="capitalize text-xs h-8"
          >
            {st} {st !== "all" && `(${nodes.filter((n) => n.status === st).length})`}
          </Button>
        ))}
      </div>
      {/* Stale Warning Banner */}
      {error && nodes.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="size-4 text-amber-400 shrink-0" />
            <span>
              Fleet sync failed: {error}. Showing cached snapshot{lastUpdated ? ` from ${lastUpdated.toLocaleTimeString()}` : ""}.
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => loadNodes()}
            disabled={loading}
            className="h-7 text-xs border-amber-500/40 hover:bg-amber-500/20 text-amber-100"
          >
            <RefreshCw className={`size-3 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            Retry
          </Button>
        </div>
      )}

      {/* Nodes Table Card */}
      <Card className="border-border/60 bg-card/60 shadow-none py-0 gap-0 overflow-hidden">
        <CardHeader className="p-4 border-b border-border/40">
          <CardTitle className="text-base">Registered Nodes ({filteredNodes.length})</CardTitle>
          <CardDescription>Live node status and connectivity</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto w-full">
            <Table>
              <TableHeader className="bg-surface/50 border-b border-border/40">
                <TableRow className="border-0 hover:bg-transparent">
                  <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/75 py-3 pl-4">Node</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/75 py-3">Status</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/75 py-3">Network</TableHead>
                  <TableHead className="hidden md:table-cell text-xs font-semibold uppercase tracking-wider text-muted-foreground/75 py-3">Platform</TableHead>
                  <TableHead className="hidden md:table-cell text-xs font-semibold uppercase tracking-wider text-muted-foreground/75 py-3">Last Heartbeat</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/75 py-3 pr-4 text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredNodes.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-10 text-muted-foreground">
                      {error && nodes.length === 0 ? (
                        <div className="flex flex-col items-center justify-center gap-2 text-destructive">
                          <AlertCircle className="size-5" />
                          <span className="font-semibold text-sm">Failed to load fleet nodes</span>
                          <p className="text-xs text-muted-foreground max-w-sm">{error}</p>
                          <Button variant="outline" size="sm" onClick={() => loadNodes()} className="mt-2 text-xs">
                            <RefreshCw className="size-3.5 mr-1.5" /> Retry
                          </Button>
                        </div>
                      ) : loading ? (
                        "Loading nodes..."
                      ) : filterStatus !== "all" ? (
                        `No nodes found with status "${filterStatus}".`
                      ) : (
                        "No nodes registered yet. Click 'Enroll Worker' to add one."
                      )}
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredNodes.map((node) => {
                    const statusInfo = formatFleetNodeStatus(node.status as FleetNodeStatus);
                    const roleInfo = formatFleetNodeRole(node.role);
                    const heartbeat = formatHeartbeatStatus(node.last_heartbeat_at);
                    const platformStr = formatPlatform(node.os, node.arch);
                    const config: FleetNodeConfigurationView = node.configuration ?? {
                      status: "unknown",
                      desiredRevision: node.desired_revision ?? 1,
                      appliedRevision: null,
                      deploymentRevision: null,
                      error: null,
                      updatedAt: null,
                    };
                    return (
                      <NodeContextMenu
                        key={node.id}
                        node={node}
                        onManage={() => router.push(`/nodes/${node.id}`)}
                        onAddEndpoint={() => setQuickEndpointNode(node)}
                        onDelete={() => setDeleteTargetNode(node)}
                      >
                        <TableRow className="group cursor-context-menu border-b border-border/30 transition-colors duration-150 hover:bg-surface-raised/40">
                          <TableCell className="py-3.5 pl-4">
                            <div className="flex flex-col gap-1 min-w-0 max-w-[180px] sm:max-w-[240px] 3xl:max-w-md 5xl:max-w-xl">
                              <Link
                                href={`/nodes/${node.id}`}
                                className="font-semibold text-sm text-foreground hover:text-primary transition-colors truncate"
                                title={node.name}
                              >
                                {node.name}
                              </Link>
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <Badge variant={roleInfo.badgeVariant} className="text-[10px] font-mono px-1.5 py-0 h-4 border-border/50 shrink-0">
                                  {roleInfo.label}
                                </Badge>
                                <span className="text-[10px] font-mono text-muted-foreground/60 truncate max-w-[120px] 3xl:max-w-xs" title={node.id}>
                                  {node.id}
                                </span>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="py-3.5">
                            <div className="flex flex-col gap-0.5 min-w-0">
                              <div className="flex items-center gap-2">
                                <span
                                  className={`size-2 rounded-full inline-block shrink-0 ring-2 ${
                                    statusInfo.variant === "success"
                                      ? "bg-emerald-400 ring-emerald-500/20"
                                      : statusInfo.variant === "warning"
                                      ? "bg-amber-400 ring-amber-500/20"
                                      : "bg-rose-400 ring-rose-500/20"
                                  }`}
                                />
                                <span className="text-xs font-medium capitalize text-foreground/90">{statusInfo.label}</span>
                              </div>
                              <NodeConfigConvergenceIndicator config={config} />
                              {/* Key health visible on mobile where heartbeat column is hidden */}
                              <div className="md:hidden text-[10px] font-mono text-muted-foreground mt-0.5">
                                {heartbeat.label}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="py-3.5">
                            <div className="flex flex-col text-xs font-mono leading-tight">
                              <span className="text-foreground tracking-tight">{node.tailscale_ip || node.wireguard_ip}</span>
                              <div className="flex items-center gap-1.5 mt-0.5">
                                <span className="text-[11px] text-muted-foreground">{node.public_ip || "no public IP"}</span>
                                {node.public_ip_status && node.public_ip_status !== "unknown" && (
                                  <Badge variant="outline" className={`text-[9px] px-1 py-0 h-3.5 ${formatPublicIpStatus(node.public_ip_status).variant === "success" ? "text-emerald-400 border-emerald-500/40" : formatPublicIpStatus(node.public_ip_status).variant === "warning" ? "text-amber-400 border-amber-500/40" : "text-rose-400 border-rose-500/40"}`}>
                                    {formatPublicIpStatus(node.public_ip_status).label}
                                  </Badge>
                                )}
                              </div>
                              {node.proxy_activation && (
                                <span className={`text-[10px] mt-0.5 ${node.proxy_activation === "enabled" ? "text-emerald-400/80" : "text-amber-400/80"}`}>
                                  {formatProxyActivation(node.proxy_activation).label}
                                </span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="hidden md:table-cell py-3.5">
                            <div className="flex flex-col text-xs leading-tight">
                              <span className="font-mono text-muted-foreground">{platformStr}</span>
                              {node.agent_version && (
                                <span className="text-[11px] font-mono text-muted-foreground/50 mt-0.5">v{node.agent_version}</span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="hidden md:table-cell py-3.5">
                            <span
                              className={`text-xs font-mono tabular-nums ${
                                heartbeat.severity === "critical"
                                  ? "text-rose-400 font-medium"
                                  : heartbeat.severity === "warning"
                                  ? "text-amber-400"
                                  : "text-muted-foreground"
                              }`}
                            >
                              {heartbeat.label}
                            </span>
                          </TableCell>
                          <TableCell className="text-right py-3.5 pr-4">
                            <div className="flex items-center justify-end gap-1">
                              <Button variant="ghost" size="sm" asChild className="h-8 px-2.5 text-xs text-muted-foreground hover:text-foreground hover:bg-surface-raised/70">
                                <Link href={`/nodes/${node.id}`}>Manage</Link>
                              </Button>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground">
                                    <span className="sr-only">Open actions menu</span>
                                    <MoreVertical className="size-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-48">
                                  <DropdownMenuItem asChild>
                                    <Link href={`/nodes/${node.id}`} className="cursor-pointer">
                                      <ExternalLink className="size-4 mr-2" /> Manage node
                                    </Link>
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => setQuickEndpointNode(node)}>
                                    <Plus className="size-4 mr-2" /> Add endpoint
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem onClick={() => void copyText("WireGuard IP", node.wireguard_ip)}>
                                    <Copy className="size-4 mr-2" /> Copy WireGuard IP
                                  </DropdownMenuItem>
                                  {node.public_ip && (
                                    <DropdownMenuItem onClick={() => void copyText("Public IP", node.public_ip)}>
                                      <Copy className="size-4 mr-2" /> Copy public IP
                                    </DropdownMenuItem>
                                  )}
                                  <DropdownMenuItem onClick={() => void copyText("Node ID", node.id)}>
                                    <Copy className="size-4 mr-2" /> Copy node ID
                                  </DropdownMenuItem>
                                  {node.role !== "controller-worker" && node.id !== "controller-node-master" && (
                                    <>
                                      <DropdownMenuSeparator />
                                      <DropdownMenuItem
                                        onClick={() => setDeleteTargetNode(node)}
                                        className="text-rose-400 focus:text-rose-300 cursor-pointer"
                                      >
                                        <Trash2 className="size-4 mr-2" /> Delete node
                                      </DropdownMenuItem>
                                    </>
                                  )}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </TableCell>
                        </TableRow>
                      </NodeContextMenu>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
      {/* Pending Removals Card */}
      {(pendingRemovals.length > 0 || removalError) && (
        <Card className="border-amber-500/40 bg-amber-500/5 shadow-none overflow-hidden">
          <CardHeader className="p-4 border-b border-border/30 bg-amber-500/10">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2 text-amber-300">
                <AlertTriangle className="size-4 text-amber-400" />
                Pending Decommission & Cleanup ({pendingRemovals.length})
              </CardTitle>
              {removalError && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadNodes()}
                  className="h-7 text-xs border-amber-500/40 hover:bg-amber-500/20 text-amber-200"
                >
                  <RefreshCw className={`size-3 mr-1 ${loading ? "animate-spin" : ""}`} />
                  Retry Sync
                </Button>
              )}
            </div>
            <CardDescription className="text-xs text-amber-200/80">
              These nodes are removed from fleet routing inventory. WireGuard peer cleanup and host uninstallation are pending or retrying.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {removalError && (
              <div className="p-3 border-b border-border/20 text-xs text-rose-400 flex items-center justify-between">
                <span>{removalError} (showing last confirmed snapshot)</span>
              </div>
            )}
            {pendingRemovals.length > 0 && (
              <Table>
                <TableHeader className="bg-surface/50 border-b border-border/30">
                  <TableRow className="border-0">
                    <TableHead className="text-xs py-2.5 pl-4">Node</TableHead>
                    <TableHead className="text-xs py-2.5">WireGuard IP</TableHead>
                    <TableHead className="text-xs py-2.5">Status</TableHead>
                    <TableHead className="text-xs py-2.5">Requested</TableHead>
                    <TableHead className="text-xs py-2.5 pr-4 text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pendingRemovals.map((rem) => (
                    <TableRow key={rem.nodeId} className="border-b border-border/20 text-xs">
                      <TableCell className="py-2.5 pl-4 font-medium font-mono text-foreground">
                        {rem.nodeName || rem.nodeId}
                        {rem.lastError && (
                          <div className="text-[10px] text-rose-400 font-mono mt-0.5 truncate max-w-xs" title={rem.lastError}>
                            Error: {rem.lastError}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="py-2.5 font-mono text-muted-foreground">
                        {rem.wireguardIp || "—"}
                      </TableCell>
                      <TableCell className="py-2.5">
                        <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-300 text-[10px]">
                          {rem.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-2.5 text-muted-foreground font-mono">
                        {formatRelativeTime(rem.requestedAt)}
                      </TableCell>
                      <TableCell className="py-2.5 pr-4 text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs gap-1 border-amber-500/40 hover:bg-amber-500/20 text-amber-200"
                          disabled={retryingRemovalId === rem.nodeId}
                          onClick={() => void retryRemoval(rem.nodeId)}
                        >
                          <RotateCw className={`size-3 ${retryingRemovalId === rem.nodeId ? "animate-spin" : ""}`} />
                          Retry
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
      <DeleteNodeDialog
        open={deleteTargetNode !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTargetNode(null);
        }}
        nodeId={deleteTargetNode?.id ?? null}
        nodeName={deleteTargetNode?.name}
        role={deleteTargetNode?.role}
        onSuccess={() => void loadNodes()}
      />
      <Dialog
        open={quickEndpointNode !== null}
        onOpenChange={(open) => {
          if (!open) {
            setQuickEndpointNode(null);
            setQuickError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add proxy endpoint</DialogTitle>
            <DialogDescription>
              Create listener on {quickEndpointNode?.name} ({quickEndpointNode?.wireguard_ip}).
            </DialogDescription>
          </DialogHeader>
          {quickError && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive flex items-start gap-2">
              <AlertCircle className="size-4 shrink-0 mt-0.5" />
              <span>{quickError}</span>
            </div>
          )}
          <div className="grid gap-4 py-2">
            <div className="grid gap-2 text-sm">
              <span className="font-medium text-xs uppercase tracking-wider text-muted-foreground">Protocol</span>
              <ToggleGroup
                type="single"
                value={quickProtocol}
                onValueChange={(value) => {
                  if (value) {
                    setQuickProtocol(value as "http" | "socks5");
                    setQuickError(null);
                  }
                }}
                variant="outline"
                className="w-full"
              >
                <ToggleGroupItem value="http" className="flex-1 text-xs">HTTP CONNECT</ToggleGroupItem>
                <ToggleGroupItem value="socks5" className="flex-1 text-xs">SOCKS5</ToggleGroupItem>
              </ToggleGroup>
            </div>
            <label htmlFor="quick-port" className="grid gap-1.5 text-sm">
              <span className="font-medium text-xs uppercase tracking-wider text-muted-foreground">Listen port</span>
              <Input
                id="quick-port"
                type="number"
                min={1}
                max={65535}
                value={quickPort}
                onChange={(e) => {
                  setQuickPort(e.target.value);
                  setQuickError(null);
                }}
                placeholder="20001"
              />
            </label>
            <label htmlFor="quick-username" className="grid gap-1.5 text-sm">
              <span className="font-medium text-xs uppercase tracking-wider text-muted-foreground">Username</span>
              <Input
                id="quick-username"
                value={quickUsername}
                onChange={(e) => {
                  setQuickUsername(e.target.value);
                  setQuickError(null);
                }}
                placeholder="user1"
              />
            </label>
            <label htmlFor="quick-password" className="grid gap-1.5 text-sm">
              <span className="font-medium text-xs uppercase tracking-wider text-muted-foreground">Password</span>
              <Input
                id="quick-password"
                type="password"
                value={quickPassword}
                onChange={(e) => {
                  setQuickPassword(e.target.value);
                  setQuickError(null);
                }}
                placeholder="Optional password"
              />
            </label>
          </div>
          <Button onClick={createQuickEndpoint} disabled={quickCreating || !quickPort || !quickUsername.trim()}>
            {quickCreating ? "Creating…" : "Create endpoint"}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
