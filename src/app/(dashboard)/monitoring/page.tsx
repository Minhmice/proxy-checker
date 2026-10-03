"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Activity, Server, Cpu, HardDrive, RefreshCw } from "lucide-react";
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
import { formatFleetNodeStatus, formatFleetNodeRole, formatRelativeTime } from "@/lib/fleet-ui-utils";
import type { FleetNodeRecord, FleetNodeStatus } from "@/proxyfleet/types";

export default function MonitoringPage() {
  const { password } = useAuth();
  const [nodes, setNodes] = useState<FleetNodeRecord[]>([]);
  const [loading, setLoading] = useState(true);

  async function loadData() {
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
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, [password]);

  const onlineCount = nodes.filter((n) => n.status === "online").length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Activity className="size-6 text-primary" />
            Infrastructure Monitoring
          </h1>
          <p className="text-sm text-muted-foreground">
            Hardware health and telemetry powered by Beszel Hub and ProxyFleet agents.
          </p>
        </div>

        <Button variant="outline" size="sm" onClick={loadData} disabled={loading}>
          <RefreshCw className={`size-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground font-medium">Total Managed Nodes</span>
            <Server className="size-4 text-primary" />
          </div>
          <div className="mt-2 text-2xl font-bold">{nodes.length}</div>
          <div className="text-[11px] text-muted-foreground mt-1">
            {onlineCount} online / {nodes.length - onlineCount} inactive
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground font-medium">Beszel Telemetry Hub</span>
            <Cpu className="size-4 text-emerald-500" />
          </div>
          <div className="mt-2 text-base font-bold flex items-center gap-2">
            <span className="size-2 rounded-full bg-emerald-500" />
            Active (:8090)
          </div>
          <div className="text-[11px] text-muted-foreground mt-1">Port 8090 on Controller VPS #1</div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground font-medium">Overlay Mesh</span>
            <HardDrive className="size-4 text-primary" />
          </div>
          <div className="mt-2 text-base font-bold font-mono">10.77.0.0/24</div>
          <div className="text-[11px] text-muted-foreground mt-1">WireGuard UDP :51820</div>
        </Card>
      </div>

      {/* Nodes Health Table */}
      <Card>
        <CardHeader className="p-4 border-b">
          <CardTitle className="text-base">Node Telemetry ({nodes.length})</CardTitle>
          <CardDescription>Live health and operating system telemetry.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Node</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Public IP</TableHead>
                <TableHead>WireGuard IP</TableHead>
                <TableHead>OS / Kernel</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Last Heartbeat</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {nodes.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                    {loading ? "Loading telemetry..." : "No worker nodes registered yet."}
                  </TableCell>
                </TableRow>
              ) : (
                nodes.map((node) => {
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
                      <TableCell className="font-mono text-xs">{node.public_ip || "—"}</TableCell>
                      <TableCell className="font-mono text-xs">{node.wireguard_ip}</TableCell>
                      <TableCell className="text-xs">
                        {node.os || "Ubuntu"} ({node.arch || "x86_64"})
                      </TableCell>
                      <TableCell className="text-xs">v{node.agent_version || "0.1.0"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatRelativeTime(node.last_heartbeat_at || 0)}
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
