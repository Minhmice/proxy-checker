"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Clock,
  Copy,
  Eye,
  Network,
  RefreshCw,
} from "lucide-react";
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  EndpointActionsDropdown,
  EndpointContextMenu,
} from "@/components/endpoints/endpoint-context-menu";
import type { FleetNodeRecord, FleetProxyEndpointRecord, FleetHealthCheckRecord } from "@/proxyfleet/types";
type EndpointWithHealth = FleetProxyEndpointRecord & { health?: FleetHealthCheckRecord | null };

export default function ProxyEndpointsPage() {
  const router = useRouter();
  const { password } = useAuth();
  const [endpoints, setEndpoints] = useState<FleetProxyEndpointRecord[]>([]);
  const [nodeNames, setNodeNames] = useState<Record<string, string>>({});
  const [nodesById, setNodesById] = useState<Record<string, FleetNodeRecord>>({});
  const [loading, setLoading] = useState(true);
  const [endpointError, setEndpointError] = useState<string | null>(null);
  const [nodeLookupError, setNodeLookupError] = useState(false);
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);

  // Credential reveal modal state
  const [revealedCreds, setRevealedCreds] = useState<{ username: string; password: string } | null>(null);
  const [revealOpen, setRevealOpen] = useState(false);
  const [revealingId, setRevealingId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Request abort controllers for concurrency and cancellation
  const abortControllerRef = useRef<AbortController | null>(null);
  const revealAbortRef = useRef<AbortController | null>(null);

  // Endpoints and reveal state
  const loadEndpoints = useCallback(async () => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const signal = controller.signal;

    try {
      setLoading(true);
      setEndpointError(null);

      const res = await fetch("/api/fleet/endpoints", {
        headers: authHeaders(password),
        credentials: "same-origin",
        signal,
      });

      if (signal.aborted) return;

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        if (signal.aborted) return;
        throw new Error(errData.error || `Failed to fetch endpoints (HTTP ${res.status})`);
      }

      const data = await res.json();
      if (signal.aborted) return;

      setEndpoints(data.endpoints || []);
      setLastFetchedAt(new Date());

      // Load node names for friendly display, degrade gracefully if node lookup fails
      try {
        const nodesRes = await fetch("/api/fleet/nodes", {
          headers: authHeaders(password),
          credentials: "same-origin",
          signal,
        });
        if (signal.aborted) return;

        if (nodesRes.ok) {
          const nodesData = await nodesRes.json();
          if (signal.aborted) return;
          const nodes = (nodesData.nodes || []) as FleetNodeRecord[];
          setNodeNames(Object.fromEntries(nodes.map((node) => [node.id, node.name])));
          setNodesById(Object.fromEntries(nodes.map((node) => [node.id, node])));
          setNodeLookupError(false);
        } else {
          setNodeLookupError(true);
        }
      } catch (nodeErr) {
        if (!signal.aborted) {
          setNodeLookupError(true);
        }
      }
    } catch (err) {
      if (!signal.aborted && !isAbortError(err)) {
        setEndpointError(err instanceof Error ? err.message : "Failed to load proxy endpoints");
      }
    } finally {
      if (!signal.aborted) {
        setLoading(false);
      }
    }
  }, [password]);

  useEffect(() => {
    void loadEndpoints();
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, [loadEndpoints]);

  async function handleReveal(endpointId: string) {
    revealAbortRef.current?.abort();
    const controller = new AbortController();
    revealAbortRef.current = controller;
    const signal = controller.signal;

    setRevealingId(endpointId);
    try {
      const res = await fetch(`/api/fleet/endpoints/${encodeURIComponent(endpointId)}/credentials/reveal`, {
        method: "POST",
        headers: authHeaders(password),
        credentials: "same-origin",
        signal,
      });

      if (signal.aborted) return;

      if (res.ok) {
        const creds = await res.json();
        if (signal.aborted) return;
        setRevealedCreds({ username: creds.username || "", password: creds.password || "" });
        setRevealOpen(true);
      } else {
        // generic HTTP error without echoing unsanitized backend error
        toast.error(`Failed to reveal credentials (HTTP ${res.status})`);
      }
    } catch (err) {
      if (!signal.aborted) {
        toast.error("Network error while revealing credentials");
      }
    } finally {
      if (!signal.aborted) {
        setRevealingId(null);
      }
    }
  }

  async function toggleEndpoint(endpoint: FleetProxyEndpointRecord) {
    try {
      const res = await fetch(`/api/fleet/endpoints/${encodeURIComponent(endpoint.id)}`, {
        method: "PATCH",
        headers: authHeaders(password),
        credentials: "same-origin",
        body: JSON.stringify({ enabled: !endpoint.enabled }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Could not update endpoint (HTTP ${res.status})`);
      }
      await loadEndpoints();
      toast.success(`Endpoint ${endpoint.enabled ? "disabled" : "enabled"}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update endpoint");
    }
  }

  async function copyProxyUrl(endpoint: FleetProxyEndpointRecord) {
    try {
      const credsRes = await fetch(`/api/fleet/endpoints/${encodeURIComponent(endpoint.id)}/credentials/reveal`, {
        method: "POST",
        headers: authHeaders(password),
        credentials: "same-origin",
      });
      if (!credsRes.ok) {
        const errData = await credsRes.json().catch(() => ({}));
        throw new Error(errData.error || `Could not read endpoint credentials (HTTP ${credsRes.status})`);
      }
      const creds = await credsRes.json();
      const user = encodeURIComponent(creds.username || "");
      const pass = encodeURIComponent(creds.password || "");
      const auth = user ? `${user}${pass ? `:${pass}` : ""}@` : "";
      await navigator.clipboard.writeText(`${endpoint.protocol}://${auth}${endpoint.listen_ip}:${endpoint.listen_port}`);
      toast.success("Proxy URL copied to clipboard");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not copy proxy URL");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Network className="size-6 text-primary" />
            Proxy Endpoints
          </h1>
          <p className="text-sm text-muted-foreground">
            All configured HTTP CONNECT and SOCKS5 proxy listeners across fleet nodes.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {lastFetchedAt && !endpointError && (
            <span className="text-xs text-muted-foreground hidden sm:inline font-mono">
              Updated {lastFetchedAt.toLocaleTimeString()}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadEndpoints()}
            disabled={loading}
            className="min-h-[44px] sm:min-h-[36px]"
          >
            <RefreshCw className={`size-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {endpointError && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-lg border border-destructive/40 bg-destructive/10 text-destructive text-sm">
          <div className="flex items-center gap-2.5">
            <AlertCircle className="size-5 shrink-0" />
            <div>
              <p className="font-medium">Failed to load proxy endpoints</p>
              <p className="text-xs text-destructive/85">{endpointError}</p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="border-destructive/40 hover:bg-destructive/20 text-destructive shrink-0 min-h-[44px] sm:min-h-[32px]"
            onClick={() => void loadEndpoints()}
            disabled={loading}
          >
            <RefreshCw className={`size-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            Retry
          </Button>
        </div>
      )}

      {nodeLookupError && !endpointError && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-400 text-xs">
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 shrink-0" />
            <span>Node name lookup unavailable. Endpoints displayed with raw node IDs.</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-amber-300 hover:text-amber-200 hover:bg-amber-500/20"
            onClick={() => void loadEndpoints()}
          >
            Retry Lookup
          </Button>
        </div>
      )}

      <Card className="border-border/60 bg-card/60 shadow-none py-0 gap-0 overflow-hidden">
        <CardHeader className="p-4 border-b border-border/40">
          <CardTitle className="text-base">
            Active Fleet Endpoints {!endpointError && `(${endpoints.length})`}
          </CardTitle>
          <CardDescription>
            Credentials are encrypted at rest and redacted from normal display.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-surface/50 border-b border-border/40">
              <TableRow className="border-0 hover:bg-transparent">
                <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/75 py-3 pl-4">Endpoint</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/75 py-3">Node</TableHead>
                <TableHead className="hidden md:table-cell text-xs font-semibold uppercase tracking-wider text-muted-foreground/75 py-3">Username</TableHead>
                <TableHead className="hidden md:table-cell text-xs font-semibold uppercase tracking-wider text-muted-foreground/75 py-3">Credentials</TableHead>
                <TableHead className="hidden md:table-cell text-xs font-semibold uppercase tracking-wider text-muted-foreground/75 py-3">Source</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/75 py-3">State</TableHead>
                <TableHead className="hidden sm:table-cell text-xs font-semibold uppercase tracking-wider text-muted-foreground/75 py-3">Health</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/75 py-3 pr-4 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && endpoints.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground text-sm">
                    <RefreshCw className="size-4 animate-spin inline mr-2 text-primary" />
                    Loading endpoints...
                  </TableCell>
                </TableRow>
              ) : endpointError && endpoints.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-destructive text-sm">
                    Unable to display endpoints due to network or server error.
                  </TableCell>
                </TableRow>
              ) : endpoints.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground text-sm">
                    No proxy endpoints created yet.
                  </TableCell>
                </TableRow>
              ) : (
                endpoints.map((ep) => (
                  <EndpointContextMenu
                    key={ep.id}
                    endpoint={ep}
                    onReveal={() => handleReveal(ep.id)}
                    onCopyUrl={() => copyProxyUrl(ep)}
                    onJumpToNode={() => router.push(`/nodes/${ep.node_id}`)}
                    onToggle={() => void toggleEndpoint(ep)}
                    isRevealing={revealingId === ep.id}
                  >
                    <TableRow className="group cursor-context-menu border-b border-border/30 transition-colors duration-150 hover:bg-surface-raised/40">
                      <TableCell className="py-3.5 pl-4">
                        <div className="space-y-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <Badge variant="outline" className="uppercase font-mono text-[10px] px-1.5 py-0 h-4 border-border/50 text-foreground/85">{ep.protocol}</Badge>
                            <span className="font-mono text-xs font-medium text-foreground tracking-tight">{ep.listen_ip}:{ep.listen_port}</span>
                            <span className="inline-flex items-center gap-1">
                              <Badge variant="outline" className="font-mono text-[10px] px-1.5 py-0 h-4 border-border/50 text-muted-foreground">
                                rev {ep.current_revision}
                              </Badge>
                              {nodesById[ep.node_id]?.configuration?.status === "failed" && (
                                <span
                                  className="inline-flex"
                                  title={`Node configuration failed: ${nodesById[ep.node_id].configuration?.error ?? "Unknown error"}`}
                                >
                                  <AlertTriangle
                                    className="size-3.5 text-rose-400"
                                    aria-label="Node configuration failed"
                                  />
                                </span>
                              )}
                              {nodesById[ep.node_id]?.configuration?.status === "pending" && (
                                <span
                                  className="inline-flex"
                                  title={`Node applying revision ${nodesById[ep.node_id].configuration?.desiredRevision}`}
                                >
                                  <Clock
                                    className="size-3.5 text-amber-400"
                                    aria-label="Node applying configuration"
                                  />
                                </span>
                              )}
                            </span>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="py-3.5">
                        <Link
                          href={`/nodes/${ep.node_id}`}
                          className="text-sm font-medium text-foreground hover:text-primary transition-colors truncate inline-flex items-center gap-1.5"
                        >
                          <span>{nodeNames[ep.node_id] || ep.node_id.slice(0, 8)}</span>
                          {nodeLookupError && !nodeNames[ep.node_id] && (
                            <Badge variant="outline" className="text-[9px] px-1 py-0 h-3.5 text-amber-500 border-amber-500/30">
                              Stale
                            </Badge>
                          )}
                        </Link>
                      </TableCell>
                      <TableCell className="hidden md:table-cell font-mono text-xs text-foreground/80 py-3.5">{ep.username}</TableCell>
                      <TableCell className="hidden md:table-cell font-mono text-xs text-muted-foreground/50 py-3.5 tracking-widest">••••••••••••</TableCell>
                      <TableCell className="hidden md:table-cell py-3.5">
                        <Badge variant="outline" className="text-[10px] font-mono border-border/40 text-muted-foreground">ProxyFleet</Badge>
                      </TableCell>
                      <TableCell className="py-3.5">
                        <span className="inline-flex items-center gap-2 text-xs">
                          <span className={`size-2 rounded-full inline-block shrink-0 ring-2 ${ep.enabled ? "bg-emerald-400 ring-emerald-500/20" : "bg-muted-foreground/40 ring-border/20"}`} />
                          <span className="text-xs font-medium capitalize text-foreground/90">{ep.enabled ? "Enabled" : "Disabled"}</span>
                        </span>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell py-3.5">
                        {(ep as EndpointWithHealth).health ? (
                          <div className="flex flex-col gap-0.5 text-xs">
                            <div className="flex items-center gap-1.5">
                              <Badge
                                variant="outline"
                                className={`text-[10px] capitalize px-1.5 py-0 h-4 ${
                                  (ep as EndpointWithHealth).health!.status === "healthy"
                                    ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
                                    : "text-rose-400 border-rose-500/30 bg-rose-500/10"
                                }`}
                              >
                                {(ep as EndpointWithHealth).health!.status}
                              </Badge>
                              {(ep as EndpointWithHealth).health!.latency_ms != null && (
                                <span className="text-[10px] font-mono text-muted-foreground">
                                  {(ep as EndpointWithHealth).health!.latency_ms}ms
                                </span>
                              )}
                            </div>
                            {(ep as EndpointWithHealth).health!.exit_ip && (
                              <span className="text-[10px] font-mono text-muted-foreground truncate max-w-[120px]" title={(ep as EndpointWithHealth).health!.exit_ip!}>
                                Exit: {(ep as EndpointWithHealth).health!.exit_ip}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground/70">Unknown</span>
                        )}
                      </TableCell>
                      <TableCell className="py-3.5 pr-4 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleReveal(ep.id)}
                            disabled={revealingId === ep.id}
                            className="hidden sm:inline-flex h-8 px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-surface-raised/70"
                          >
                            {revealingId === ep.id ? (
                              <RefreshCw className="size-3.5 mr-1 animate-spin" />
                            ) : (
                              <Eye className="size-3.5 mr-1" />
                            )}
                            Reveal
                          </Button>
                          <EndpointActionsDropdown
                            endpoint={ep}
                            onReveal={() => handleReveal(ep.id)}
                            onCopyUrl={() => copyProxyUrl(ep)}
                            onJumpToNode={() => router.push(`/nodes/${ep.node_id}`)}
                            onToggle={() => void toggleEndpoint(ep)}
                            isRevealing={revealingId === ep.id}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  </EndpointContextMenu>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Credential Reveal Dialog */}
      <Dialog
        open={revealOpen}
        onOpenChange={(open) => {
          setRevealOpen(open);
          if (!open) {
            revealAbortRef.current?.abort();
            setRevealedCreds(null);
            setRevealingId(null);
            setCopied(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Decrypted Endpoint Credentials</DialogTitle>
            <DialogDescription>
              Retrieved securely from vault. Do not share or log these values.
            </DialogDescription>
          </DialogHeader>

          {revealedCreds && (
            <div className="space-y-4 py-4">
              <div className="space-y-1">
                <span className="text-xs font-semibold text-muted-foreground uppercase">Username</span>
                <div className="p-2.5 rounded bg-muted/60 font-mono text-xs select-all">{revealedCreds.username}</div>
              </div>

              <div className="space-y-1">
                <span className="text-xs font-semibold text-muted-foreground uppercase">Password</span>
                <div className="flex items-center gap-2">
                  <div className="p-2.5 flex-1 rounded bg-muted/60 font-mono text-xs break-all select-all">
                    {revealedCreds.password}
                  </div>
                  <Button
                    size="icon"
                    variant="outline"
                    className="size-9 min-h-[44px] min-w-[44px] sm:min-h-[36px] sm:min-w-[36px]"
                    aria-label="Copy password to clipboard"
                    onClick={() => {
                      navigator.clipboard.writeText(revealedCreds.password);
                      setCopied(true);
                      toast.success("Password copied to clipboard");
                      setTimeout(() => setCopied(false), 2000);
                    }}
                  >
                    {copied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
                  </Button>
                </div>
              </div>
            </div>
          )}

          <DialogFooter className="sm:justify-end">
            <Button
              variant="outline"
              size="sm"
              className="min-h-[44px] sm:min-h-[32px]"
              onClick={() => {
                revealAbortRef.current?.abort();
                setRevealOpen(false);
                setRevealedCreds(null);
                setRevealingId(null);
                setCopied(false);
              }}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
