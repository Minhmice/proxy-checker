"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import { Server, Plus, RefreshCw, Terminal, Check, Copy } from "lucide-react";
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
import type { FleetNodeRecord, FleetNodeStatus } from "@/proxyfleet/types";

export default function NodesPage() {
  const { password } = useAuth();
  const [nodes, setNodes] = useState<FleetNodeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [newNodeName, setNewNodeName] = useState("");
  const [enrollToken, setEnrollToken] = useState("");
  const [tokenLoading, setTokenLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function loadNodes() {
    try {
      setLoading(true);
      const res = await fetch("/api/fleet/nodes", {
        headers: authHeaders(password),
        credentials: "same-origin",
      });
      if (res.ok) {
        const data = await res.json();
        setNodes(data.nodes || []);
      }
    } catch {
      // error handled by UI state
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadNodes();
    const interval = setInterval(loadNodes, 15000);
    return () => clearInterval(interval);
  }, [password]);

  async function handleCreateEnrollmentToken() {
    if (!newNodeName.trim()) return;
    setTokenLoading(true);
    try {
      const res = await fetch("/api/fleet/enrollment-tokens", {
        method: "POST",
        headers: authHeaders(password),
        credentials: "same-origin",
        body: JSON.stringify({ nodeName: newNodeName.trim(), ttlMinutes: 60 }),
      });
      if (res.ok) {
        const data = await res.json();
        setEnrollToken(data.token);
      }
    } finally {
      setTokenLoading(false);
    }
  }

  const filteredNodes = useMemo(() => {
    if (filterStatus === "all") return nodes;
    return nodes.filter((n) => n.status === filterStatus);
  }, [nodes, filterStatus]);

  const curlCommand = enrollToken
    ? `curl -fsSL ${window.location.origin}/install-agent.sh | sudo bash -s -- --server ${window.location.origin} --token ${enrollToken} --node-name "${newNodeName}"`
    : "";

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Server className="size-6 text-primary" />
            Infrastructure Nodes
          </h1>
          <p className="text-sm text-muted-foreground">
            Manage remote Ubuntu proxy workers connected via WireGuard overlay.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={loadNodes} disabled={loading}>
            <RefreshCw className={`size-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>

          <Dialog>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="size-4 mr-2" />
                Enroll Worker
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Enroll New Proxy Worker</DialogTitle>
                <DialogDescription>
                  Generate a single-use token and run the installer command on your remote Ubuntu VPS.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <label className="text-xs font-semibold uppercase text-muted-foreground">Node Identifier</label>
                  <div className="flex gap-2">
                    <Input
                      placeholder="e.g. worker-001"
                      value={newNodeName}
                      onChange={(e) => setNewNodeName(e.target.value)}
                    />
                    <Button onClick={handleCreateEnrollmentToken} disabled={!newNodeName.trim() || tokenLoading}>
                      Generate Token
                    </Button>
                  </div>
                </div>

                {enrollToken && (
                  <div className="space-y-2">
                    <label className="text-xs font-semibold uppercase text-muted-foreground flex items-center gap-1">
                      <Terminal className="size-3.5" />
                      Run on Remote VPS (as root):
                    </label>
                    <div className="relative bg-muted/60 p-3 rounded-lg border text-xs font-mono break-all pr-10">
                      {curlCommand}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="absolute top-2 right-2 size-7"
                        onClick={() => {
                          navigator.clipboard.writeText(curlCommand);
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                        }}
                      >
                        {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
                      </Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      This token expires in 60 minutes and is single-use.
                    </p>
                  </div>
                )}
              </div>
            </DialogContent>
          </Dialog>
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

      {/* Nodes Table Card */}
      <Card>
        <CardHeader className="p-4 border-b">
          <CardTitle className="text-base">Registered Nodes ({filteredNodes.length})</CardTitle>
          <CardDescription>Live status of fleet proxy workers and WireGuard peer addresses.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Node Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>WireGuard IP</TableHead>
                <TableHead>Public IP</TableHead>
                <TableHead>OS / Arch</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Last Heartbeat</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredNodes.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                    {loading ? "Loading nodes..." : "No nodes registered yet. Click 'Enroll Worker' to add one."}
                  </TableCell>
                </TableRow>
              ) : (
                filteredNodes.map((node) => {
                  const statusInfo = formatFleetNodeStatus(node.status as FleetNodeStatus);
                  const roleInfo = formatFleetNodeRole(node.role);
                  return (
                    <TableRow key={node.id}>
                      <TableCell className="font-semibold text-sm">
                        <Link href={`/nodes/${node.id}`} className="hover:underline text-primary">
                          {node.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge variant={roleInfo.badgeVariant}>
                          {roleInfo.label}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusInfo.variant === "destructive" ? "destructive" : "secondary"}>
                          {statusInfo.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{node.wireguard_ip}</TableCell>
                      <TableCell className="font-mono text-xs">{node.public_ip || "—"}</TableCell>
                      <TableCell className="text-xs">
                        {node.os || "Linux"} / {node.arch || "amd64"}
                      </TableCell>
                      <TableCell className="text-xs">{node.agent_version || "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatRelativeTime(node.last_heartbeat_at || 0)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/nodes/${node.id}`}>Manage</Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
