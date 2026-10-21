"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { Bell, RefreshCw, AlertCircle, Clock, Eye, Copy, Check } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { authHeaders } from "@/lib/api";
import { isAbortError } from "@/lib/request-lifecycle";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<FleetEventRecord | null>(null);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const loadEvents = useCallback(async (isManual = false) => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    if (isManual) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      const res = await fetch("/api/fleet/events?limit=200", {
        headers: authHeaders(password),
        credentials: "same-origin",
        signal: controller.signal,
      });

      if (!res.ok) {
        let errMessage = `HTTP ${res.status}: ${res.statusText || "Request failed"}`;
        try {
          const errData = await res.json();
          if (errData && typeof errData === "object") {
            const msg = "error" in errData && typeof errData.error === "string"
              ? errData.error
              : "message" in errData && typeof errData.message === "string"
              ? errData.message
              : null;
            if (msg && msg.trim()) {
              errMessage = `HTTP ${res.status}: ${msg.trim().slice(0, 160)}`;
            }
          }
        } catch {
          // Non-JSON failure (HTML or stream drop); preserve concise HTTP status
        }
        if (controller.signal.aborted) return;
        throw new Error(errMessage);
      }

      const data = await res.json();
      if (controller.signal.aborted) return;
      setEvents(Array.isArray(data.events) ? data.events : []);
      setLastUpdated(new Date());
    } catch (err: unknown) {
      if (controller.signal.aborted || isAbortError(err)) {
        return;
      }
      setError(err instanceof Error ? err.message : "An unexpected network error occurred while loading events.");
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [password]);

  useEffect(() => {
    void loadEvents();
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, [loadEvents]);

  const handleCopyPayload = async () => {
    if (!selectedEvent) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(selectedEvent.payload || {}, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access denied or unsupported
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Bell className="size-6 text-primary" />
            Fleet Event Log
          </h1>
          <p className="text-sm text-muted-foreground">
            Audit records for node registrations, WireGuard connections, deployments, and health transitions.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {lastUpdated && (
            <div className="hidden md:flex items-center gap-1.5 text-xs text-muted-foreground" title={lastUpdated.toISOString()}>
              <Clock className="size-3.5" />
              <span>Snapshot {lastUpdated.toLocaleTimeString()}</span>
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => loadEvents(true)}
            disabled={loading || refreshing}
            aria-label="Refresh audit event log"
          >
            <RefreshCw className={`size-4 mr-2 ${loading || refreshing ? "animate-spin" : ""}`} />
            {refreshing ? "Refreshing..." : "Refresh"}
          </Button>
        </div>
      </div>

      {/* Error alert with retry */}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertCircle className="size-4" />
          <AlertTitle>Event Log Fetch Failed</AlertTitle>
          <AlertDescription className="mt-1 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <span className="text-xs break-all">{error}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => loadEvents(true)}
              className="shrink-0 text-xs h-7 px-3"
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Event table card */}
      <Card className="overflow-hidden">
        <CardHeader className="p-4 border-b">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">
                Recent Events ({loading && events.length === 0 ? "..." : events.length})
              </CardTitle>
              <CardDescription>
                Historical audit trail. Updated on manual refresh.
              </CardDescription>
            </div>
            {error && events.length > 0 && (
              <Badge variant="outline" className="text-amber-500 border-amber-500/30 text-xs">
                Stale snapshot
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[160px]">Event Type</TableHead>
                  <TableHead className="min-w-[90px]">Level</TableHead>
                  <TableHead className="min-w-[110px]">Node</TableHead>
                  <TableHead className="min-w-[240px]">Payload</TableHead>
                  <TableHead className="min-w-[160px] text-right">Timestamp</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && events.length === 0 ? (
                  Array.from({ length: 4 }).map((_, idx) => (
                    <TableRow key={`skeleton-ev-${idx}`}>
                      <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-12" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-48" /></TableCell>
                      <TableCell className="text-right"><Skeleton className="h-4 w-28 ml-auto" /></TableCell>
                    </TableRow>
                  ))
                ) : events.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-10 text-muted-foreground">
                      {error ? (
                        <div className="space-y-2">
                          <p className="text-destructive font-medium text-sm">Failed to load events</p>
                          <p className="text-xs text-muted-foreground">Unable to fetch event stream from server.</p>
                        </div>
                      ) : (
                        <div className="space-y-1">
                          <p className="text-sm font-medium text-foreground">No events recorded yet</p>
                          <p className="text-xs text-muted-foreground">System audit activities will appear here.</p>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ) : (
                  events.map((ev) => {
                    const payloadStr = JSON.stringify(ev.payload || {});
                    return (
                      <TableRow key={ev.id}>
                        <TableCell className="font-mono text-xs font-semibold">
                          {ev.event_type}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              ev.level === "error"
                                ? "destructive"
                                : ev.level === "warn"
                                ? "secondary"
                                : "outline"
                            }
                            className="text-[11px] capitalize"
                          >
                            {ev.level}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {ev.node_id ? `${ev.node_id.slice(0, 8)}...` : "—"}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2 max-w-sm">
                            <span className="font-mono text-[11px] text-muted-foreground truncate max-w-[200px]" title={payloadStr}>
                              {payloadStr}
                            </span>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setSelectedEvent(ev)}
                              className="h-6 px-2 text-[11px] text-primary hover:text-primary gap-1 shrink-0"
                              aria-label={`View full payload for ${ev.event_type}`}
                            >
                              <Eye className="size-3" />
                              <span>View</span>
                            </Button>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground text-right whitespace-nowrap" title={new Date(ev.created_at).toISOString()}>
                          {new Date(ev.created_at).toLocaleString()}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
        </CardContent>
      </Card>

      {/* Full Event Payload Disclosure Dialog */}
      <Dialog open={selectedEvent !== null} onOpenChange={(open) => !open && setSelectedEvent(null)}>
        <DialogContent className="max-w-lg max-h-[85vh] flex flex-col p-6">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <span>Event Payload:</span>
              <span className="font-mono text-sm text-primary">{selectedEvent?.event_type}</span>
            </DialogTitle>
            <DialogDescription className="text-xs">
              Event ID: <span className="font-mono text-foreground">{selectedEvent?.id}</span>
            </DialogDescription>
          </DialogHeader>

          {selectedEvent && (
            <div className="space-y-4 my-2 flex-1 overflow-y-auto pr-1">
              {/* Metadata Grid */}
              <div className="grid grid-cols-2 gap-2 text-xs bg-muted/40 p-3 rounded-md border">
                <div>
                  <span className="text-muted-foreground font-medium">Severity Level: </span>
                  <Badge
                    variant={
                      selectedEvent.level === "error"
                        ? "destructive"
                        : selectedEvent.level === "warn"
                        ? "secondary"
                        : "outline"
                    }
                    className="text-[10px] ml-1 uppercase"
                  >
                    {selectedEvent.level}
                  </Badge>
                </div>
                <div>
                  <span className="text-muted-foreground font-medium">Created: </span>
                  <span className="text-foreground">{new Date(selectedEvent.created_at).toLocaleString()}</span>
                </div>
                <div>
                  <span className="text-muted-foreground font-medium">Node ID: </span>
                  <span className="font-mono text-foreground break-all">{selectedEvent.node_id || "None"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground font-medium">Endpoint ID: </span>
                  <span className="font-mono text-foreground break-all">{selectedEvent.endpoint_id || "None"}</span>
                </div>
              </div>

              {/* Formatted Payload JSON */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-muted-foreground">Payload Data</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCopyPayload}
                    className="h-6 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
                  >
                    {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
                    <span>{copied ? "Copied" : "Copy JSON"}</span>
                  </Button>
                </div>
                <pre className="font-mono text-xs p-3 rounded-md bg-muted/60 border max-h-72 overflow-y-auto overflow-x-auto whitespace-pre-wrap break-all select-text">
                  {JSON.stringify(selectedEvent.payload || {}, null, 2)}
                </pre>
              </div>
            </div>
          )}

          <DialogFooter className="mt-2">
            <Button variant="outline" size="sm" onClick={() => setSelectedEvent(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
