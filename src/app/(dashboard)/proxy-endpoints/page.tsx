"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Network, RefreshCw, Eye, Copy, Check } from "lucide-react";
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
} from "@/components/ui/dialog";
import type { FleetProxyEndpointRecord } from "@/proxyfleet/types";

export default function ProxyEndpointsPage() {
  const { password } = useAuth();
  const [endpoints, setEndpoints] = useState<FleetProxyEndpointRecord[]>([]);
  const [loading, setLoading] = useState(true);

  // Credential reveal modal state
  const [revealedCreds, setRevealedCreds] = useState<{ username: string; password: string } | null>(null);
  const [revealOpen, setRevealOpen] = useState(false);
  const [revealingId, setRevealingId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function loadEndpoints() {
    try {
      setLoading(true);
      const res = await fetch("/api/fleet/endpoints", {
        headers: authHeaders(password),
        credentials: "same-origin",
      });
      if (res.ok) {
        const data = await res.json();
        setEndpoints(data.endpoints || []);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadEndpoints();
  }, [password]);

  async function handleReveal(endpointId: string) {
    setRevealingId(endpointId);
    try {
      const res = await fetch(`/api/fleet/endpoints/${encodeURIComponent(endpointId)}/credentials/reveal`, {
        method: "POST",
        headers: authHeaders(password),
        credentials: "same-origin",
      });
      if (res.ok) {
        const creds = await res.json();
        setRevealedCreds(creds);
        setRevealOpen(true);
      }
    } finally {
      setRevealingId(null);
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

        <Button variant="outline" size="sm" onClick={loadEndpoints} disabled={loading}>
          <RefreshCw className={`size-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader className="p-4 border-b">
          <CardTitle className="text-base">Active Fleet Endpoints ({endpoints.length})</CardTitle>
          <CardDescription>
            Credentials are encrypted at rest and redacted from normal display.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Protocol</TableHead>
                <TableHead>Listen Address</TableHead>
                <TableHead>Node</TableHead>
                <TableHead>Username</TableHead>
                <TableHead>Credentials</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {endpoints.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                    {loading ? "Loading endpoints..." : "No proxy endpoints created yet."}
                  </TableCell>
                </TableRow>
              ) : (
                endpoints.map((ep) => (
                  <TableRow key={ep.id}>
                    <TableCell className="uppercase font-semibold text-xs">{ep.protocol}</TableCell>
                    <TableCell className="font-mono text-xs font-semibold text-primary">
                      {ep.listen_ip}:{ep.listen_port}
                    </TableCell>
                    <TableCell>
                      <Button variant="link" size="sm" asChild className="p-0 h-auto font-mono text-xs">
                        <Link href={`/nodes/${ep.node_id}`}>{ep.node_id.slice(0, 8)}...</Link>
                      </Button>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{ep.username}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">••••••••••••</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px]">
                        ProxyFleet
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={ep.enabled ? "secondary" : "destructive"}>
                        {ep.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleReveal(ep.id)}
                        disabled={revealingId === ep.id}
                        className="h-8 text-xs"
                      >
                        <Eye className="size-3.5 mr-1" />
                        Reveal
                      </Button>
                    </TableCell>
                  </TableRow>
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
            setRevealedCreds(null);
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
                <div className="p-2.5 rounded bg-muted/60 font-mono text-xs">{revealedCreds.username}</div>
              </div>

              <div className="space-y-1">
                <span className="text-xs font-semibold text-muted-foreground uppercase">Password</span>
                <div className="flex items-center gap-2">
                  <div className="p-2.5 flex-1 rounded bg-muted/60 font-mono text-xs break-all">
                    {revealedCreds.password}
                  </div>
                  <Button
                    size="icon"
                    variant="outline"
                    className="size-9"
                    onClick={() => {
                      navigator.clipboard.writeText(revealedCreds.password);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                  >
                    {copied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
