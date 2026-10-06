"use client";

import { useEffect, useState } from "react";
import { Bell, RefreshCw } from "lucide-react";
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
import type { FleetEventRecord } from "@/proxyfleet/types";

export default function EventsPage() {
  const { password } = useAuth();
  const [events, setEvents] = useState<FleetEventRecord[]>([]);
  const [loading, setLoading] = useState(true);

  async function loadEvents() {
    try {
      setLoading(true);
      const res = await fetch("/api/fleet/events?limit=200", {
        headers: authHeaders(password),
        credentials: "same-origin",
      });
      if (res.ok) {
        const data = await res.json();
        setEvents(data.events || []);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadEvents();
  }, [password]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Bell className="size-6 text-primary" />
            Fleet Event Stream
          </h1>
          <p className="text-sm text-muted-foreground">
            Audit logs for node registrations, WireGuard connections, deployments, and health state transitions.
          </p>
        </div>

        <Button variant="outline" size="sm" onClick={loadEvents} disabled={loading}>
          <RefreshCw className={`size-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader className="p-4 border-b">
          <CardTitle className="text-base">Recent Events ({events.length})</CardTitle>
          <CardDescription>Live audit events stream.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event Type</TableHead>
                <TableHead>Level</TableHead>
                <TableHead>Node</TableHead>
                <TableHead>Payload</TableHead>
                <TableHead className="text-right">Timestamp</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                    {loading ? "Loading events..." : "No events recorded yet."}
                  </TableCell>
                </TableRow>
              ) : (
                events.map((ev) => (
                  <TableRow key={ev.id}>
                    <TableCell className="font-mono text-xs font-semibold">{ev.event_type}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          ev.level === "error"
                            ? "destructive"
                            : ev.level === "warn"
                            ? "secondary"
                            : "outline"
                        }
                      >
                        {ev.level}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {ev.node_id ? `${ev.node_id.slice(0, 8)}...` : "—"}
                    </TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground max-w-xs truncate">
                      {JSON.stringify(ev.payload || {})}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground text-right">
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
