"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import {
  Server,
  ArrowLeft,
  Activity,
  Network,
  Cpu,
  HardDrive,
  Plus,
  RefreshCw,
} from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { authHeaders } from "@/lib/api";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatFleetNodeStatus, formatFleetNodeRole, formatRelativeTime } from "@/lib/fleet-ui-utils";
import type { FleetNodeRecord, FleetProxyEndpointRecord, FleetEventRecord, FleetNodeStatus } from "@/proxyfleet/types";

export default function NodeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const nodeId = resolvedParams.id;
  const { password } = useAuth();

  const [node, setNode] = useState<FleetNodeRecord | null>(null);
  const [endpoints, setEndpoints] = useState<FleetProxyEndpointRecord[]>([]);
  const [events, setEvents] = useState<FleetEventRecord[]>([]);
  const [loading, setLoading] = useState(true);

  // New endpoint dialog form state
  const [newProtocol, setNewProtocol] = useState<"http" | "socks5">("http");
  const [newPort, setNewPort] = useState<number>(20001);
  const [newUsername, setNewUsername] = useState<string>("user1");
  const [newPassword, setNewPassword] = useState<string>("");
  const [creatingEp, setCreatingEp] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  async function loadData() {
    try {
      setLoading(true);
      const res = await fetch(`/api/fleet/nodes/${encodeURIComponent(nodeId)}`, {
        headers: authHeaders(password),
        credentials: "same-origin",
      });
      if (res.ok) {
        const data = await res.json();
        setNode(data.node);
        setEndpoints(data.endpoints || []);
        setEvents(data.events || []);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, [nodeId, password]);

  async function handleCreateEndpoint() {
    if (!node) return;
    setCreatingEp(true);
    try {
      const res = await fetch("/api/fleet/endpoints", {
        method: "POST",
        headers: authHeaders(password),
        credentials: "same-origin",
        body: JSON.stringify({
          nodeId: node.id,
          protocol: newProtocol,
          listenIp: node.wireguard_ip,
          listenPort: Number(newPort),
          username: newUsername.trim(),
          password: newPassword.trim(),
          enabled: true,
        }),
      });

      if (res.ok) {
        setDialogOpen(false);
        setNewPassword("");
        loadData();
      }
    } finally {
      setCreatingEp(false);
    }
  }

  if (loading && !node) {
    return (
      <div className="flex items-center justify-center p-12 text-sm text-muted-foreground">
        <RefreshCw className="size-5 animate-spin mr-2" />
        Loading node details...
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
        <p className="text-muted-foreground">Node not found.</p>
      </div>
    );
  }

  const statusInfo = formatFleetNodeStatus(node.status as FleetNodeStatus);
  const roleInfo = formatFleetNodeRole(node.role);
  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" asChild className="h-8 px-2 -ml-2">
              <Link href="/nodes">
                <ArrowLeft className="size-4 mr-1" />
                Nodes
              </Link>
            </Button>
            <span className="text-muted-foreground">/</span>
            <span className="font-mono text-sm">{node.name}</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2.5">
            <Server className="size-6 text-primary" />
            {node.name}
            <Badge variant={roleInfo.badgeVariant}>
              {roleInfo.label}
            </Badge>
            <Badge variant={statusInfo.variant === "destructive" ? "destructive" : "secondary"}>
              {statusInfo.label}
            </Badge>
          </h1>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={loadData} disabled={loading}>
            <RefreshCw className={`size-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Node Metrics & Hardware Info */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground font-medium">WireGuard Overlay</span>
            <Network className="size-4 text-primary" />
          </div>
          <div className="mt-2 font-mono text-base font-bold">{node.wireguard_ip}</div>
          <div className="text-[11px] text-muted-foreground mt-1">Interface: wg0 (Subnet 10.77.0.0/24)</div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground font-medium">Public WAN IP</span>
            <Activity className="size-4 text-emerald-500" />
          </div>
          <div className="mt-2 font-mono text-base font-bold">{node.public_ip || "—"}</div>
          <div className="text-[11px] text-muted-foreground mt-1">Egress target</div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground font-medium">Operating System</span>
            <Cpu className="size-4 text-muted-foreground" />
          </div>
          <div className="mt-2 text-sm font-semibold">{node.os || "Linux"}</div>
          <div className="text-[11px] text-muted-foreground mt-1">Arch: {node.arch || "amd64"}</div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground font-medium">ProxyFleet Agent</span>
            <HardDrive className="size-4 text-muted-foreground" />
          </div>
          <div className="mt-2 text-sm font-semibold">v{node.agent_version || "0.1.0"}</div>
          <div className="text-[11px] text-muted-foreground mt-1">
            Last seen {formatRelativeTime(node.last_heartbeat_at || 0)}
          </div>
        </Card>
      </div>

      {/* Proxy Endpoints on Node */}
      <Card>
        <CardHeader className="p-4 border-b flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Managed Proxy Endpoints ({endpoints.length})</CardTitle>
            <CardDescription>3proxy listeners bound to WireGuard IP {node.wireguard_ip}</CardDescription>
          </div>

          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="size-4 mr-1.5" />
                Add Endpoint
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add Proxy Endpoint</DialogTitle>
                <DialogDescription>
                  Configure a new authenticated 3proxy listener on {node.name}.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <label className="text-xs font-semibold uppercase text-muted-foreground">Protocol</label>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant={newProtocol === "http" ? "default" : "outline"}
                      onClick={() => setNewProtocol("http")}
                    >
                      HTTP CONNECT
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={newProtocol === "socks5" ? "default" : "outline"}
                      onClick={() => setNewProtocol("socks5")}
                    >
                      SOCKS5
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-semibold uppercase text-muted-foreground">Port</label>
                  <Input
                    type="number"
                    value={newPort}
                    onChange={(e) => setNewPort(Number(e.target.value))}
                    min={1024}
                    max={65535}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Recommended: 20001+ for HTTP, 30001+ for SOCKS5
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-semibold uppercase text-muted-foreground">Username</label>
                  <Input
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    placeholder="proxy username"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-semibold uppercase text-muted-foreground">Password</label>
                  <Input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="proxy password"
                  />
                </div>

                <Button
                  onClick={handleCreateEndpoint}
                  disabled={!newUsername || !newPassword || creatingEp}
                  className="w-full"
                >
                  Create Endpoint
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Protocol</TableHead>
                <TableHead>Listen Address</TableHead>
                <TableHead>Username</TableHead>
                <TableHead>Password</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Revision</TableHead>
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
                      <Badge variant={ep.enabled ? "secondary" : "destructive"}>
                        {ep.enabled ? "Active" : "Disabled"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">rev {ep.current_revision}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Node Events */}
      <Card>
        <CardHeader className="p-4 border-b">
          <CardTitle className="text-base">Node Audit Events ({events.length})</CardTitle>
          <CardDescription>Recent lifecycle and deployment events reported for {node.name}.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
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
        </CardContent>
      </Card>
    </div>
  );
}
