"use client";

import { useEffect, useState, use, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Server,
  ArrowLeft,
  Activity,
  Network,
  Cpu,
  HardDrive,
  Plus,
  RefreshCw,
  AlertTriangle,
  AlertCircle,
  Trash2,
  ShieldAlert,
  Sliders,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth-provider";
import { authHeaders } from "@/lib/api";
import { isAbortError } from "@/lib/request-lifecycle";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatFleetNodeStatus, formatFleetNodeRole, formatRelativeTime } from "@/lib/fleet-ui-utils";
import { NodeRuntimeCard } from "@/components/nodes/node-runtime-card";
import { DeleteNodeDialog } from "@/components/nodes/delete-node-dialog";
import type {
  FleetNodeRecord,
  FleetProxyEndpointRecord,
  FleetEventRecord,
  FleetNodeStatus,
  FleetDeploymentRecord,
  FleetNodeConfigurationView,
} from "@/proxyfleet/types";

export default function NodeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const nodeId = resolvedParams.id;
  const router = useRouter();
  const { password } = useAuth();
  const [node, setNode] = useState<FleetNodeRecord | null>(null);
  const [endpoints, setEndpoints] = useState<FleetProxyEndpointRecord[]>([]);
  const [events, setEvents] = useState<FleetEventRecord[]>([]);
  const [deployments, setDeployments] = useState<FleetDeploymentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // New endpoint dialog form state
  const [newProtocol, setNewProtocol] = useState<"http" | "socks5">("http");
  const [newPort, setNewPort] = useState<string>("20001");
  const [newUsername, setNewUsername] = useState<string>("user1");
  const [newPassword, setNewPassword] = useState<string>("");
  const [creatingEp, setCreatingEp] = useState(false);
  const [createEpError, setCreateEpError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  // Capacity and Decommission state
  const [capacityInput, setCapacityInput] = useState<string>("");
  const [savingCapacity, setSavingCapacity] = useState(false);
  const [capacityError, setCapacityError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [isCapacityDirty, setIsCapacityDirty] = useState(false);
  const [isDecommissioning, setIsDecommissioning] = useState(false);

  async function loadData(signal?: AbortSignal) {
    try {
      setLoading(true);
      const res = await fetch(`/api/fleet/nodes/${encodeURIComponent(nodeId)}`, {
        headers: authHeaders(password),
        credentials: "same-origin",
        signal,
      });
      if (signal?.aborted) return;
      if (res.status === 404) {
        if (!signal?.aborted) {
          setNotFound(true);
          setFetchError(null);
        }
        return;
      }
      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        const msg = errData?.error || `Failed to fetch node (${res.status} ${res.statusText})`;
        if (!signal?.aborted) {
          setFetchError(msg);
          setNotFound(false);
        }
        return;
      }
      const data = await res.json();
      if (!signal?.aborted) {
        setNode(data.node);
        setEndpoints(data.endpoints || []);
        setEvents(data.events || []);
        setDeployments(data.deployments || []);
        setNotFound(false);
        setFetchError(null);
        setLastUpdated(new Date());
        if (!isCapacityDirty) {
          setCapacityInput(
            data.node?.capacity?.maxConnections != null ? String(data.node.capacity.maxConnections) : ""
          );
        }
      }
    } catch (err: unknown) {
      if (signal?.aborted || isAbortError(err)) {
        return;
      }
      const msg = err instanceof Error ? err.message : "Network error connecting to fleet service";
      setFetchError(msg);
      setNotFound(false);
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
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

    void loadData(controller.signal);
    const interval = setInterval(() => {
      if (!controller.signal.aborted) {
        void loadData(controller.signal);
      }
    }, 15000);
    return () => {
      clearInterval(interval);
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, [nodeId, password]);

  async function handleSaveCapacity(resetToDefault = false) {
    setSavingCapacity(true);
    setCapacityError(null);
    try {
      let maxConnections: number | null = null;
      if (!resetToDefault) {
        const trimmed = capacityInput.trim();
        if (trimmed !== "") {
          if (!/^\d+$/.test(trimmed)) {
            setCapacityError("Capacity ceiling must be a whole positive integer");
            setSavingCapacity(false);
            return;
          }
          const val = Number(trimmed);
          if (!Number.isInteger(val) || val <= 0 || val > 1_000_000) {
            setCapacityError("Capacity ceiling must be an integer between 1 and 1,000,000");
            setSavingCapacity(false);
            return;
          }
          maxConnections = val;
        }
      }

      const res = await fetch(`/api/fleet/nodes/${encodeURIComponent(nodeId)}/capacity`, {
        method: "PATCH",
        headers: authHeaders(password),
        credentials: "same-origin",
        body: JSON.stringify({ maxConnections }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data.error || `Failed to update capacity (HTTP ${res.status})`;
        setCapacityError(msg);
        toast.error(msg);
        return;
      }

      toast.success(
        maxConnections != null
          ? `Capacity ceiling set to ${maxConnections} maxconn`
          : "Capacity ceiling reset to engine default"
      );
      setIsCapacityDirty(false);
      if (resetToDefault) {
        setCapacityInput("");
      } else if (data.node?.capacity?.maxConnections != null) {
        setCapacityInput(String(data.node.capacity.maxConnections));
      } else {
        setCapacityInput("");
      }
      if (data.node) {
        setNode(data.node);
      }
      void loadData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Network error updating capacity";
      setCapacityError(msg);
      toast.error(msg);
    } finally {
      setSavingCapacity(false);
    }
  }

  async function handleCreateEndpoint() {
    if (!node) return;
    const port = parseInt(newPort, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      setCreateEpError("Port must be between 1 and 65535");
      return;
    }
    if (!newUsername.trim()) {
      setCreateEpError("Username cannot be empty");
      return;
    }
    if (!newPassword) {
      setCreateEpError("Password cannot be empty");
      return;
    }
    setCreatingEp(true);
    setCreateEpError(null);
    try {
      const res = await fetch("/api/fleet/endpoints", {
        method: "POST",
        headers: authHeaders(password),
        credentials: "same-origin",
        body: JSON.stringify({
          nodeId: node.id,
          protocol: newProtocol,
          listenIp: node.wireguard_ip,
          listenPort: port,
          username: newUsername.trim(),
          password: newPassword.trim(),
          enabled: true,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        const msg = errData?.error || `Failed to create endpoint (${res.status} ${res.statusText})`;
        setCreateEpError(msg);
        toast.error(msg);
        return;
      }

      setDialogOpen(false);
      setCreateEpError(null);
      setNewPassword("");
      toast.success("Proxy endpoint created");
      await loadData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not create endpoint";
      setCreateEpError(msg);
      toast.error(msg);
    } finally {
      setCreatingEp(false);
    }
  }

  if (loading && !node && !notFound && !fetchError) {
    return (
      <div className="flex items-center justify-center p-12 text-sm text-muted-foreground">
        <RefreshCw className="size-5 animate-spin mr-2" />
        Loading node details...
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="space-y-4 max-w-lg">
        <Button variant="ghost" size="sm" asChild className="h-8 px-2 -ml-2">
          <Link href="/nodes">
            <ArrowLeft className="size-4 mr-1.5" />
            Fleet Nodes
          </Link>
        </Button>
        <Card className="border-border/60 bg-card/60 p-6">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Server className="size-5" />
              <h2 className="text-lg font-semibold text-foreground">Node Not Found</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Node <code className="font-mono text-foreground font-semibold px-1 py-0.5 rounded bg-muted/60">{nodeId}</code> could not be found in the fleet registry.
            </p>
            <div className="pt-2">
              <Button asChild size="sm">
                <Link href="/nodes">Back to Fleet Nodes</Link>
              </Button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  if (fetchError && !node) {
    return (
      <div className="space-y-4 max-w-lg">
        <Button variant="ghost" size="sm" asChild className="h-8 px-2 -ml-2">
          <Link href="/nodes">
            <ArrowLeft className="size-4 mr-1.5" />
            Fleet Nodes
          </Link>
        </Button>
        <Card className="border-destructive/30 bg-destructive/5 p-6">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="size-5" />
              <h2 className="text-lg font-semibold">Failed to Load Node</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Could not load details for node <code className="font-mono text-foreground px-1 py-0.5 rounded bg-muted/60">{nodeId}</code>: {fetchError}
            </p>
            <div className="flex items-center gap-2 pt-2">
              <Button size="sm" onClick={() => loadData()}>
                <RefreshCw className="size-3.5 mr-1.5" /> Retry
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link href="/nodes">Back to Fleet Nodes</Link>
              </Button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  if (!node) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" asChild>
          <Link href="/nodes">
            <ArrowLeft className="size-4 mr-2" />
            Back to Nodes
          </Link>
        </Button>
        <p className="text-muted-foreground">Node unavailable.</p>
      </div>
    );
  }

  const statusInfo = formatFleetNodeStatus(node.status as FleetNodeStatus);
  const roleInfo = formatFleetNodeRole(node.role);
  const config: FleetNodeConfigurationView = node.configuration ?? {
    status: node.deployment_status || "unknown",
    desiredRevision: node.desired_revision ?? 1,
    appliedRevision: node.applied_revision ?? null,
    deploymentRevision: node.deployment_revision ?? null,
    error: node.deployment_error ?? null,
    updatedAt: node.deployment_updated_at ?? null,
  };

  const convergenceBadge = (() => {
    switch (config.status) {
      case "applied":
        return (
          <Badge variant="default" className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
            Applied
          </Badge>
        );
      case "pending":
        return (
          <Badge variant="outline" className="bg-amber-500/15 text-amber-400 border-amber-500/30">
            Pending
          </Badge>
        );
      case "failed":
        return <Badge variant="destructive">Failed</Badge>;
      default:
        return <Badge variant="secondary">Unknown</Badge>;
    }
  })();

  return (
    <div className="space-y-6">
      {/* Stale Warning Banner */}
      {fetchError && node && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="size-4 text-amber-400 shrink-0" />
            <span>
              Sync failed: {fetchError}. Showing cached snapshot{lastUpdated ? ` from ${lastUpdated.toLocaleTimeString()}` : ""}.
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => loadData()}
            disabled={loading}
            className="h-7 text-xs border-amber-500/40 hover:bg-amber-500/20 text-amber-100"
          >
            <RefreshCw className={`size-3 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            Retry
          </Button>
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" asChild className="h-8 px-2 -ml-2 text-xs">
              <Link href="/nodes">
                <ArrowLeft className="size-4 mr-1" />
                Fleet Nodes
              </Link>
            </Button>
            <span className="text-muted-foreground">/</span>
            <span className="font-mono text-sm truncate max-w-[200px]" title={node.name}>{node.name}</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2.5 flex-wrap">
            <Server className="size-6 text-primary shrink-0" />
            <span className="truncate">{node.name}</span>
            <Badge variant={roleInfo.badgeVariant}>
              {roleInfo.label}
            </Badge>
            <Badge variant={statusInfo.variant === "destructive" ? "destructive" : "secondary"}>
              {statusInfo.label}
            </Badge>
          </h1>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => loadData()} disabled={loading} className="h-8 text-xs">
            <RefreshCw className={`size-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          {node.role === "controller-worker" || node.id === "controller-node-master" ? (
            <Button variant="outline" size="sm" disabled className="h-8 text-xs text-muted-foreground border-border/50">
              <ShieldAlert className="size-3.5 mr-1.5 text-amber-400" />
              Controller Protected
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteDialogOpen(true)}
              className="h-8 text-xs border-rose-500/40 text-rose-400 hover:bg-rose-500/10 hover:text-rose-300"
            >
              <Trash2 className="size-3.5 mr-1.5" />
              Decommission Node
            </Button>
          )}
        </div>
      </div>

      {/* Node Runtime & Observability Card */}
      <NodeRuntimeCard
        node={node}
        device={node.device}
        runtime={node.runtime}
        runtimeReceivedAt={node.runtimeReceivedAt}
        capacity={node.capacity}
        onRefresh={() => void loadData()}
        loading={loading}
      />

      {/* Configured Listener Capacity Ceiling */}
      <Card className="p-5 border-border/60 bg-card/60">
        <CardHeader className="p-0 pb-3 border-b border-border/40 flex flex-row items-center justify-between">
          <div className="space-y-1">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Sliders className="size-4 text-primary" />
              Configured Listener Capacity Ceiling
            </CardTitle>
            <CardDescription className="text-xs">
              Configured per-listener ceiling (3proxy maxconn) — limits concurrent client connections. Does not imply measured hardware capacity.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="p-0 pt-4 space-y-3">
          {capacityError && (
            <Alert variant="destructive" className="py-2 text-xs">
              <AlertCircle className="size-4" />
              <AlertDescription>{capacityError}</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-col sm:flex-row items-start sm:items-end gap-3 max-w-lg">
            <div className="w-full sm:w-64 space-y-1">
              <label htmlFor="cap-input" className="text-xs font-medium text-foreground">
                Max Concurrent Connections
              </label>
              <Input
                id="cap-input"
                type="number"
                min={1}
                placeholder="Engine default"
                value={capacityInput}
                onChange={(e) => {
                  setCapacityInput(e.target.value);
                  setIsCapacityDirty(true);
                  setCapacityError(null);
                }}
                className="h-8 text-xs font-mono"
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => void handleSaveCapacity(false)}
                disabled={savingCapacity}
                className="h-8 text-xs"
              >
                {savingCapacity ? "Saving..." : "Save Ceiling"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleSaveCapacity(true)}
                disabled={savingCapacity}
                className="h-8 text-xs text-muted-foreground"
              >
                Reset to Default
              </Button>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Current setting:{" "}
            <strong className="text-foreground font-mono">
              {node.capacity?.maxConnections ? `${node.capacity.maxConnections} maxconn` : "engine default"}
            </strong>
            . Benchmarks and throughput verification are operator-run separate tools.
          </p>
        </CardContent>
      </Card>

      {/* Configuration Convergence Card */}
      <Card className="p-5 border-border/60">
        <CardHeader className="p-0 pb-4 border-b border-border/40 flex flex-row items-center justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5">
              <CardTitle className="text-base font-semibold">Configuration Convergence</CardTitle>
              {convergenceBadge}
            </div>
            <CardDescription className="text-xs">
              State reconciliation between controller desired revision and node agent applied configuration.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="p-0 pt-4 space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <div className="text-xs text-muted-foreground font-medium">Desired Revision</div>
              <div className="mt-1 font-mono text-lg font-bold">rev {config.desiredRevision}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground font-medium">Applied Revision</div>
              <div className="mt-1 font-mono text-lg font-bold">
                {config.appliedRevision != null ? `rev ${config.appliedRevision}` : "None"}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground font-medium">Latest Reported Revision</div>
              <div className="mt-1 font-mono text-lg font-bold">
                {config.deploymentRevision != null ? `rev ${config.deploymentRevision}` : "None"}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground font-medium">Last Updated</div>
              <div className="mt-1 font-mono text-sm font-medium text-foreground/90">
                {config.updatedAt ? new Date(config.updatedAt).toLocaleString() : "—"}
              </div>
            </div>
          </div>

          {config.status === "failed" && config.error && (
            <Alert variant="destructive" className="mt-3">
              <AlertTriangle className="size-4 shrink-0" />
              <div className="ml-2">
                <AlertTitle className="text-xs font-semibold">Configuration Deployment Error</AlertTitle>
                <AlertDescription className="text-xs mt-1 font-mono whitespace-pre-wrap break-words">
                  {config.error}
                </AlertDescription>
              </div>
            </Alert>
          )}
        </CardContent>
      </Card>


      {/* Proxy Endpoints on Node */}
      <Card>
        <CardHeader className="p-4 border-b flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Managed Proxy Endpoints ({endpoints.length})</CardTitle>
            <CardDescription>3proxy listeners bound to WireGuard IP {node.wireguard_ip}</CardDescription>
          </div>

          <Dialog
            open={dialogOpen}
            onOpenChange={(open) => {
              setDialogOpen(open);
              if (!open) setCreateEpError(null);
            }}
          >
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="size-4 mr-1.5" />
                Add Endpoint
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Add Proxy Endpoint</DialogTitle>
                <DialogDescription>
                  Configure a new authenticated 3proxy listener on {node.name}.
                </DialogDescription>
              </DialogHeader>

              {createEpError && (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive flex items-start gap-2">
                  <AlertCircle className="size-4 shrink-0 mt-0.5" />
                  <span>{createEpError}</span>
                </div>
              )}

              <div className="space-y-4 py-2">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Protocol</label>
                  <div className="flex gap-2" role="radiogroup" aria-label="Protocol">
                    <Button
                      type="button"
                      size="sm"
                      variant={newProtocol === "http" ? "default" : "outline"}
                      onClick={() => {
                        setNewProtocol("http");
                        setCreateEpError(null);
                      }}
                      className="flex-1 text-xs"
                    >
                      HTTP CONNECT
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={newProtocol === "socks5" ? "default" : "outline"}
                      onClick={() => {
                        setNewProtocol("socks5");
                        setCreateEpError(null);
                      }}
                      className="flex-1 text-xs"
                    >
                      SOCKS5
                    </Button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="ep-port" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Port</label>
                  <Input
                    id="ep-port"
                    type="number"
                    value={newPort}
                    onChange={(e) => {
                      setNewPort(e.target.value);
                      setCreateEpError(null);
                    }}
                    min={1}
                    max={65535}
                    placeholder="20001"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Port range 1–65535. Recommended: 20001+ for HTTP, 30001+ for SOCKS5
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="ep-username" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Username</label>
                  <Input
                    id="ep-username"
                    value={newUsername}
                    onChange={(e) => {
                      setNewUsername(e.target.value);
                      setCreateEpError(null);
                    }}
                    placeholder="proxy username"
                  />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="ep-password" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Password</label>
                  <Input
                    id="ep-password"
                    type="password"
                    value={newPassword}
                    onChange={(e) => {
                      setNewPassword(e.target.value);
                      setCreateEpError(null);
                    }}
                    placeholder="proxy password"
                  />
                </div>

                <Button
                  onClick={handleCreateEndpoint}
                  disabled={!newUsername || !newPassword || creatingEp}
                  className="w-full"
                >
                  {creatingEp ? "Creating…" : "Create Endpoint"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto w-full">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Protocol</TableHead>
                  <TableHead>Listen Address</TableHead>
                  <TableHead>Username</TableHead>
                  <TableHead>Password</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead>Health</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {endpoints.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-6 text-muted-foreground">
                      No proxy endpoints configured yet on this node.
                    </TableCell>
                  </TableRow>
                ) : (
                  endpoints.map((ep) => (
                    <TableRow key={ep.id}>
                      <TableCell className="uppercase font-semibold text-xs">{ep.protocol}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {ep.listen_ip}:{ep.listen_port}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{ep.username}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">••••••••</TableCell>
                      <TableCell>
                        <Badge variant={ep.enabled ? "secondary" : "outline"} className={ep.enabled ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" : "text-muted-foreground"}>
                          {ep.enabled ? "Enabled" : "Disabled"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {ep.health ? (
                          <Badge variant="outline" className={`text-[10px] capitalize ${
                            ep.health.status === "healthy" ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10" : "text-rose-400 border-rose-500/30 bg-rose-500/10"
                          }`}>
                            {ep.health.status}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">Unknown</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">rev {ep.current_revision}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Node Events */}
      <Card>
        <CardHeader className="p-4 border-b">
          <CardTitle className="text-base">Node Audit Events ({events.length})</CardTitle>
          <CardDescription>Recent lifecycle and deployment events reported for {node.name}.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto w-full">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event Type</TableHead>
                  <TableHead>Level</TableHead>
                  <TableHead>Timestamp</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center py-6 text-muted-foreground">
                      No events recorded for this node yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  events.map((ev) => (
                    <TableRow key={ev.id}>
                      <TableCell className="font-mono text-xs">{ev.event_type}</TableCell>
                      <TableCell>
                        <Badge variant={ev.level === "error" ? "destructive" : "secondary"}>
                          {ev.level}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(ev.created_at).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
      {/* Configuration Deployment History */}
      <Card>
        <CardHeader className="p-4 border-b">
          <CardTitle className="text-base">Configuration Deployments ({deployments.length})</CardTitle>
          <CardDescription>Recent agent deployment outcomes and configuration watermark convergence.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto w-full">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Revision</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Config Digest</TableHead>
                  <TableHead>Error / Detail</TableHead>
                  <TableHead>Timestamp</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deployments.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-6 text-muted-foreground text-xs">
                      No configuration deployments recorded for this node yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  deployments.map((dep) => (
                    <TableRow key={dep.id}>
                      <TableCell className="font-mono text-xs font-semibold">
                        rev {dep.revision}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            dep.status === "applied"
                              ? "default"
                              : dep.status === "failed"
                              ? "destructive"
                              : "secondary"
                          }
                          className={
                            dep.status === "applied"
                              ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px]"
                              : "text-[10px]"
                          }
                        >
                          {dep.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground truncate max-w-[140px]" title={dep.config_digest}>
                        {dep.config_digest ? dep.config_digest.slice(0, 12) + "…" : "—"}
                      </TableCell>
                      <TableCell className="text-xs font-mono max-w-[240px] truncate" title={dep.error_message || undefined}>
                        {dep.error_message ? (
                          <span className="text-rose-400">{dep.error_message}</span>
                        ) : (
                          <span className="text-muted-foreground/60">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(dep.created_at).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
      <DeleteNodeDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        nodeId={node.id}
        nodeName={node.name}
        role={node.role}
        onSuccess={() => {
          setIsDecommissioning(true);
          router.replace("/nodes");
        }}
      />
    </div>
  );
}
