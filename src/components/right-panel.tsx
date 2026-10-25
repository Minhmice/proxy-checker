"use client";

import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  ExternalLink,
  Gauge,
  Info,
  Layers,
  ListFilter,
  Loader2,
  RefreshCw,
  ServerCog,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "./auth-provider";
import { fetchMetrics, fetchStatus, formatTime, syncPools } from "@/lib/api";
import { isAbortError } from "@/lib/request-lifecycle";
import type { ActivityEntry, MetricsSnapshot, PoolStatus } from "@/lib/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  groupActivityBySync,
  sanitizeLogMessage,
  type SyncSessionSummary,
} from "@/lib/activity-grouping";

type AttentionItem = {
  label: string;
  detail: string;
  href: string;
  tone: "warning" | "error";
};

type Message = { tone: "success" | "error"; text: string } | null;

interface RightPanelProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function Trend({
  current,
  previous,
  positive,
}: {
  current?: number;
  previous?: number;
  positive: "up" | "down";
}) {
  if (current == null || previous == null || current === previous) return null;
  const direction = current > previous ? "up" : "down";
  const good = direction === positive;
  const Icon = direction === "up" ? TrendingUp : TrendingDown;
  const diff = Math.abs(current - previous);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-[10px] font-semibold tabular-nums",
        good ? "text-emerald-400" : "text-destructive",
      )}
    >
      <Icon className="size-3" aria-hidden />
      {diff}
      <span className="sr-only">
        {direction === "up" ? `increase of ${diff}` : `decrease of ${diff}`}
      </span>
    </span>
  );
}

function Metric({
  label,
  value,
  tone,
  trend,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "success" | "primary" | "danger";
  trend?: React.ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <strong
          className={cn(
            "truncate text-lg font-semibold tabular-nums tracking-tight",
            tone === "success" && "text-emerald-400",
            tone === "primary" && "text-primary",
            tone === "danger" && "text-destructive",
          )}
        >
          {value}
        </strong>
        {trend}
      </div>
      <span className="mt-1 block truncate text-[11px] text-muted-foreground">{label}</span>
    </div>
  );
}

function activityTone(level: ActivityEntry["level"]) {
  if (level === "error") return "bg-destructive";
  if (level === "warn") return "bg-amber-400";
  if (level === "success") return "bg-emerald-500";
  return "bg-primary";
}

export function RightPanel({ open = false, onOpenChange = () => {} }: RightPanelProps) {
  const { password, authenticated } = useAuth();
  const canRead = authenticated || Boolean(password);
  const inFlightRef = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<PoolStatus | null>(null);
  const [metrics, setMetrics] = useState<MetricsSnapshot[]>([]);
  const [message, setMessage] = useState<Message>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [syncSubmitting, setSyncSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!canRead) {
      setInitialLoading(false);
      return;
    }
    if (inFlightRef.current) {
      inFlightRef.current.abort();
      inFlightRef.current = null;
    }
    const controller = new AbortController();
    inFlightRef.current = controller;
    const signal = controller.signal;

    setRefreshing(true);
    try {
      const [statusData, metricData] = await Promise.all([
        fetchStatus(password || undefined, signal),
        fetchMetrics(password || undefined, 24, signal),
      ]);
      if (signal.aborted) return;
      setStatus(statusData);
      setMetrics(metricData);
      setMessage((current) => (current?.tone === "success" ? current : null));
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return;
      setMessage({ tone: "error", text: (error as Error).message });
    } finally {
      if (!signal.aborted) {
        setInitialLoading(false);
        setRefreshing(false);
      }
    }
  }, [password, canRead]);
  const isSyncRunning = Boolean(status?.running);

  useEffect(() => {
    if (!canRead) return;
    void load();

    const intervalMs = isSyncRunning ? 3000 : 15000;
    const timer = window.setInterval(() => {
      void load();
    }, intervalMs);
    return () => {
      window.clearInterval(timer);
      if (inFlightRef.current) {
        inFlightRef.current.abort();
        inFlightRef.current = null;
      }
    };
  }, [load, canRead, isSyncRunning]);
  async function handleSync() {
    if (!canRead || status?.running || syncSubmitting) return;
    setSyncSubmitting(true);
    setMessage(null);
    try {
      await syncPools(password || undefined);
      setMessage({ tone: "success", text: "Sync started. Health checks and ranking are running." });
      await load();
    } catch (error) {
      setMessage({ tone: "error", text: (error as Error).message });
    } finally {
      setSyncSubmitting(false);
    }
  }

  const attention = useMemo<AttentionItem[]>(() => {
    const items: AttentionItem[] = [];
    if (!canRead) {
      items.push({
        label: "Authentication required",
        detail: "Sign in to inspect operations and fleet health",
        href: "/auth",
        tone: "warning",
      });
      return items;
    }
    if (status && !status.configured) {
      items.push({
        label: "9Router not configured",
        detail: "Add credentials in Settings",
        href: "/settings",
        tone: "warning",
      });
    }
    if (status?.lastError) {
      items.push({
        label: "Sync reported an error",
        detail: status.lastError,
        href: "/proxies",
        tone: "warning",
      });
    }
    if (status?.stats.dead) {
      items.push({
        label: `${status.stats.dead} dead proxies`,
        detail: "Review failed routes",
        href: "/proxies",
        tone: "error",
      });
    }
    return items;
  }, [status, canRead]);
  const latest = metrics.at(-1);
  const previous = metrics.at(-2);
  const progress = status?.syncProgress;
  const progressValue = useMemo(() => {
    if (!status?.running || !progress) return 0;
    if (progress.phase === "login") return 8;
    if (progress.phase === "fetch") return 18;
    if (progress.phase === "check")
      return progress.total ? 20 + Math.round((progress.checked / progress.total) * 55) : 20;
    if (progress.phase === "rank") return 82;
    if (progress.phase === "activate") return 92;
    if (progress.phase === "done") return 100;
    return 4;
  }, [progress, status?.running]);

  const progressLabel = useMemo(() => {
    if (!status?.running || !progress) return null;
    if (progress.phase === "login") return "Connecting to 9Router";
    if (progress.phase === "fetch")
      return progress.remoteTotal ? `${progress.remoteTotal} pools fetched` : "Fetching pools";
    if (progress.phase === "check")
      return progress.total
        ? `Checking ${progress.checked} of ${progress.total}`
        : "Checking proxy health";
    if (progress.phase === "rank") return "Ranking by latency";
    if (progress.phase === "activate") return "Updating active routes";
    if (progress.phase === "done") return "Finishing sync";
    return "Sync in progress";
  }, [progress, status?.running]);

  const panel = (
    <OperationsContent
      status={status}
      latest={latest}
      previous={previous}
      attention={attention}
      activity={status?.activity ?? []}
      message={message}
      initialLoading={initialLoading}
      refreshing={refreshing}
      syncSubmitting={syncSubmitting}
      progressValue={progressValue}
      progressLabel={progressLabel}
      passwordAvailable={canRead}
      onRetry={() => load()}
      onSync={handleSync}
    />
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[min(92vw,24rem)] gap-0 p-0 sm:max-w-md">
        <SheetHeader className="sr-only">
          <SheetTitle>Operations</SheetTitle>
          <SheetDescription>Live fleet health, scheduler status, and activity.</SheetDescription>
        </SheetHeader>
        {panel}
      </SheetContent>
    </Sheet>
  );
}

function OperationsContent({
  status,
  latest,
  previous,
  attention,
  activity,
  message,
  initialLoading,
  refreshing,
  syncSubmitting,
  progressValue,
  progressLabel,
  passwordAvailable,
  onRetry,
  onSync,
}: {
  status: PoolStatus | null;
  latest: MetricsSnapshot | undefined;
  previous: MetricsSnapshot | undefined;
  attention: AttentionItem[];
  activity: ActivityEntry[];
  message: Message;
  initialLoading: boolean;
  refreshing: boolean;
  syncSubmitting: boolean;
  progressValue: number;
  progressLabel: string | null;
  passwordAvailable: boolean;
  onRetry: () => void;
  onSync: () => void;
}) {
  const running = status?.running ?? false;
  // ponytail: inline truthful status mapping; avoid extra state machine for single-panel control room
  const statusTone:
    | "unauthenticated"
    | "loading"
    | "unknown"
    | "unconfigured"
    | "error"
    | "syncing"
    | "attention"
    | "healthy" = !passwordAvailable
    ? "unauthenticated"
    : initialLoading
      ? "loading"
      : !status
        ? "unknown"
        : !status.configured
          ? "unconfigured"
          : status.lastError
            ? "error"
            : running
              ? "syncing"
              : attention.length > 0
                ? "attention"
                : "healthy";

  const statusLabel = {
    unauthenticated: "Auth required",
    loading: "Checking...",
    unknown: "Unknown",
    unconfigured: "Unconfigured",
    error: "Error",
    syncing: "Syncing",
    attention: "Attention",
    healthy: "Healthy",
  }[statusTone];

  return (
    <ScrollArea className="h-full w-full">
      <div className="space-y-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold tracking-tight">Operations</h2>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">9Router control plane</p>
          </div>
          <Badge
            variant="outline"
            className={cn(
              "gap-1.5 px-2 py-0.5 text-[10px] font-medium",
              statusTone === "healthy" &&
                "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
              statusTone === "syncing" && "border-primary/30 bg-primary/10 text-primary",
              (statusTone === "attention" || statusTone === "unconfigured") &&
                "border-amber-400/30 bg-amber-400/10 text-amber-300",
              statusTone === "error" && "border-destructive/30 bg-destructive/10 text-destructive",
              (statusTone === "unauthenticated" ||
                statusTone === "unknown" ||
                statusTone === "loading") &&
                "border-muted-foreground/30 bg-muted/20 text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                statusTone === "healthy" && "bg-emerald-500",
                statusTone === "syncing" && "bg-primary animate-pulse",
                (statusTone === "attention" || statusTone === "unconfigured") && "bg-amber-400",
                statusTone === "error" && "bg-destructive",
                statusTone === "loading" && "bg-muted-foreground animate-pulse",
                (statusTone === "unauthenticated" || statusTone === "unknown") &&
                  "bg-muted-foreground",
              )}
            />
            {statusLabel}
          </Badge>
        </div>

        {message?.tone === "error" && (
          <Alert variant="destructive">
            <AlertTriangle aria-hidden />
            <AlertTitle>Could not refresh operations</AlertTitle>
            <AlertDescription>
              <p className="break-words text-xs">{message.text}</p>
              <Button variant="outline" size="xs" onClick={onRetry} className="mt-1">
                <RefreshCw className="size-3" /> Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {message?.tone === "success" && (
          <Alert className="border-primary/30 bg-primary/5">
            <CheckCircle2 className="text-primary" aria-hidden />
            <AlertTitle>Sync accepted</AlertTitle>
            <AlertDescription className="text-xs">{message.text}</AlertDescription>
          </Alert>
        )}

        {initialLoading ? (
          <Card className="gap-4 border-border/60 py-4 shadow-none">
            <CardHeader className="px-4">
              <Skeleton className="h-4 w-28" />
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-2 px-4">
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-16" />
              ))}
            </CardContent>
          </Card>
        ) : (
          <Card className="gap-4 border-border/60 bg-card/70 py-4 shadow-none">
            <CardHeader className="flex-row items-center justify-between gap-3 px-4">
              <CardTitle className="text-sm">Fleet and scheduler</CardTitle>
              <Button asChild variant="ghost" size="xs" className="text-muted-foreground">
                <Link href="/proxies">
                  View proxies <ExternalLink className="size-3" />
                </Link>
              </Button>
            </CardHeader>
            <CardContent className="space-y-4 px-4">
              <div className="grid grid-cols-2 gap-2">
                <Metric
                  label="Active"
                  value={status?.stats.active ?? "—"}
                  tone={status ? "success" : undefined}
                  trend={
                    <Trend current={latest?.active} previous={previous?.active} positive="up" />
                  }
                />
                <Metric
                  label="Reserve"
                  value={status?.stats.reserve ?? "—"}
                  tone={status ? "primary" : undefined}
                />
                <Metric
                  label="Dead"
                  value={status?.stats.dead ?? "—"}
                  tone={status && status.stats.dead > 0 ? "danger" : undefined}
                  trend={<Trend current={latest?.dead} previous={previous?.dead} positive="down" />}
                />
                <Metric
                  label="Avg latency"
                  value={latest?.avgLatencyMs != null ? `${latest.avgLatencyMs} ms` : "—"}
                />
              </div>

              <Separator />

              <div className="space-y-2.5 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Clock3 className="size-3.5" /> Last sync
                  </span>
                  <span
                    className="max-w-[11rem] truncate text-right font-medium tabular-nums"
                    title={status?.lastSyncAt ? formatTime(status.lastSyncAt) : "Never"}
                  >
                    {status?.lastSyncAt ? formatTime(status.lastSyncAt) : "Never"}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Activity className="size-3.5" /> Interval
                  </span>
                  <span className="font-medium tabular-nums">
                    {status?.autoSync === false
                      ? "Paused"
                      : `Every ${status?.syncIntervalMinutes ?? 360} min`}
                  </span>
                </div>
              </div>

              {running && progressLabel && (
                <div className="space-y-2" role="status" aria-live="polite">
                  <div className="flex items-center justify-between gap-3 text-[11px]">
                    <span className="truncate text-primary">{progressLabel}</span>
                    <span className="font-medium tabular-nums text-muted-foreground">
                      {progressValue}%
                    </span>
                  </div>
                  <Progress value={progressValue} className="h-1.5" />
                </div>
              )}

              <Button
                className="w-full"
                size="sm"
                disabled={!passwordAvailable || running || syncSubmitting}
                onClick={onSync}
              >
                {running || syncSubmitting ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                {running ? "Sync in progress" : syncSubmitting ? "Starting sync" : "Sync now"}
              </Button>
            </CardContent>
          </Card>
        )}

        {attention.length > 0 ? (
          <Card className="gap-3 border-amber-400/30 bg-amber-400/5 py-4 shadow-none">
            <CardHeader className="flex-row items-center gap-2 px-4">
              <AlertTriangle className="size-4 text-amber-300" aria-hidden />
              <CardTitle className="text-sm">Attention needed</CardTitle>
              <Badge
                variant="outline"
                className="ml-auto border-amber-400/30 text-[10px] text-amber-300"
              >
                {attention.length}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-2 px-4">
              {attention.map((item) => (
                <Link
                  key={`${item.label}-${item.href}`}
                  href={item.href}
                  className="flex min-w-0 items-start gap-2 rounded-md border border-border/50 bg-background/40 p-2.5 transition-colors hover:bg-accent/50"
                >
                  <span
                    className={cn(
                      "mt-1 size-1.5 shrink-0 rounded-full",
                      item.tone === "error" ? "bg-destructive" : "bg-amber-400",
                    )}
                  />
                  <span className="min-w-0">
                    <strong className="block truncate text-xs font-medium">{item.label}</strong>
                    <span className="mt-0.5 block break-words text-[11px] leading-4 text-muted-foreground">
                      {item.detail}
                    </span>
                  </span>
                </Link>
              ))}
            </CardContent>
          </Card>
        ) : status && status.configured ? (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5 text-xs text-emerald-300">
            <CheckCircle2 className="size-4 shrink-0" aria-hidden />
            <span>All systems operational</span>
          </div>
        ) : null}
        <Card className="gap-3 border-border/60 bg-card/50 py-4 shadow-none">
          <CardHeader className="flex-row items-center justify-between gap-3 px-4 pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Gauge className="size-4 text-primary" /> Activity Log
            </CardTitle>
            {refreshing && (
              <Loader2
                className="size-3.5 animate-spin text-muted-foreground"
                aria-label="Refreshing activity"
              />
            )}
          </CardHeader>
          <CardContent className="px-4">
            <ActivityTabs activity={activity} />
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
  );
}

function ActivityTabs({ activity }: { activity: ActivityEntry[] }) {
  const syncSessions = useMemo(() => groupActivityBySync(activity), [activity]);
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(
    () => syncSessions[0]?.id ?? null,
  );

  // Keep latest session open if state changes
  useEffect(() => {
    if (
      syncSessions.length > 0 &&
      (!expandedSessionId || !syncSessions.find((s) => s.id === expandedSessionId))
    ) {
      setExpandedSessionId(syncSessions[0].id);
    }
  }, [syncSessions, expandedSessionId]);

  return (
    <Tabs defaultValue="sessions" className="w-full">
      <div className="flex items-center justify-between mb-2.5">
        <TabsList className="h-7 p-0.5 bg-muted/60">
          <TabsTrigger
            value="sessions"
            className="text-[11px] h-6 px-2.5 data-[state=active]:bg-background"
          >
            <Layers className="size-3 mr-1" /> Syncs ({syncSessions.length})
          </TabsTrigger>
          <TabsTrigger
            value="all"
            className="text-[11px] h-6 px-2.5 data-[state=active]:bg-background"
          >
            <ListFilter className="size-3 mr-1" /> All ({activity.length})
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="sessions" className="mt-0 focus-visible:outline-none">
        {syncSessions.length > 0 ? (
          <ScrollArea className="h-64 pr-2">
            <div className="space-y-2.5">
              {syncSessions.map((session, index) => {
                const isExpanded = expandedSessionId === session.id;
                const isLatest = index === 0;
                return (
                  <div
                    key={session.id}
                    className={cn(
                      "rounded-lg border p-2.5 transition-all text-xs",
                      session.status === "failed"
                        ? "border-destructive/40 bg-destructive/5"
                        : session.status === "running"
                          ? "border-primary/40 bg-primary/5"
                          : "border-border/60 bg-muted/20",
                    )}
                  >
                    {/* Session Summary Header */}
                    <button
                      type="button"
                      onClick={() => setExpandedSessionId(isExpanded ? null : session.id)}
                      className="w-full flex items-center justify-between text-left gap-2 focus-visible:outline-none"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={cn(
                            "size-2 rounded-full shrink-0",
                            session.status === "failed"
                              ? "bg-destructive"
                              : session.status === "running"
                                ? "bg-primary animate-pulse"
                                : "bg-emerald-500",
                          )}
                        />
                        <div className="truncate">
                          <span className="font-semibold text-foreground mr-1.5">
                            {isLatest ? "Latest Sync" : "Sync Session"}
                          </span>
                          <time className="text-[10px] text-muted-foreground tabular-nums">
                            {new Date(session.startedAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            })}
                          </time>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {session.durationSeconds != null && (
                          <span className="text-[10px] text-muted-foreground font-medium">
                            {session.durationSeconds}s
                          </span>
                        )}
                        <Badge
                          variant="outline"
                          className={cn(
                            "h-5 text-[10px] px-1.5 font-medium",
                            session.status === "failed" &&
                              "border-destructive/40 text-destructive bg-destructive/10",
                            session.status === "running" &&
                              "border-primary/40 text-primary bg-primary/10",
                            session.status === "success" &&
                              "border-emerald-500/40 text-emerald-400 bg-emerald-500/10",
                          )}
                        >
                          {session.status === "failed"
                            ? "Failed"
                            : session.status === "running"
                              ? "Running"
                              : "Success"}
                        </Badge>
                        {isExpanded ? (
                          <ChevronDown className="size-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="size-3.5 text-muted-foreground" />
                        )}
                      </div>
                    </button>

                    {/* Session Metrics Bar */}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground border-t border-border/40 pt-2">
                      {session.activeCount != null && (
                        <span className="text-emerald-400 font-medium">
                          {session.activeCount} active
                        </span>
                      )}
                      {session.reserveCount != null && (
                        <span>· {session.reserveCount} reserve</span>
                      )}
                      {session.checkedCount != null && (
                        <span>· {session.checkedCount} checked</span>
                      )}
                      {session.retriesCount > 0 && (
                        <span className="text-amber-400">· {session.retriesCount} retries</span>
                      )}
                      {session.removedCount > 0 && (
                        <span className="text-destructive">· {session.removedCount} removed</span>
                      )}
                      {session.renamedCount > 0 && (
                        <span className="text-primary font-medium">
                          · {session.renamedCount} ranked
                        </span>
                      )}
                    </div>

                    {/* Expandable Session Details (Errors & Highlights) */}
                    {isExpanded && (
                      <div className="mt-2.5 space-y-1.5 border-t border-border/40 pt-2 text-[11px]">
                        {session.errorMessages.map((err, i) => (
                          <div
                            key={i}
                            className="flex items-start gap-1.5 text-destructive bg-destructive/10 p-1.5 rounded"
                          >
                            <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
                            <span className="break-words leading-tight">{err}</span>
                          </div>
                        ))}
                        {session.warningMessages.map((warn, i) => (
                          <div
                            key={i}
                            className="flex items-start gap-1.5 text-amber-300 bg-amber-400/10 p-1.5 rounded"
                          >
                            <Info className="size-3.5 shrink-0 mt-0.5" />
                            <span className="break-words leading-tight">{warn}</span>
                          </div>
                        ))}
                        {session.highlights.map((h, i) => (
                          <div
                            key={i}
                            className="flex items-start gap-1.5 text-muted-foreground p-1"
                          >
                            <CheckCircle2 className="size-3.5 shrink-0 text-emerald-400 mt-0.5" />
                            <span className="break-words leading-tight">{h}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        ) : (
          <p className="text-xs text-muted-foreground py-2 text-center">No sync sessions found.</p>
        )}
      </TabsContent>

      <TabsContent value="all" className="mt-0 focus-visible:outline-none">
        {activity.length ? (
          <ScrollArea className="h-64 pr-2">
            <ol className="space-y-0 text-xs" aria-live="polite">
              {activity.map((entry, index) => {
                const atTime =
                  typeof entry.at === "number" && Number.isFinite(entry.at) ? entry.at : Date.now();
                const dateObj = new Date(atTime);
                const isValidDate = Number.isFinite(dateObj.getTime());
                return (
                  <li key={entry.id} className="relative flex gap-2.5 pb-2.5 last:pb-0">
                    {index < activity.length - 1 && (
                      <span
                        className="absolute left-[3px] top-2 h-full w-px bg-border/70"
                        aria-hidden
                      />
                    )}
                    <span
                      className={cn(
                        "relative mt-1.5 size-2 shrink-0 rounded-full ring-4 ring-card",
                        activityTone(entry.level),
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <time
                        className="block text-[10px] tabular-nums text-muted-foreground"
                        dateTime={isValidDate ? dateObj.toISOString() : undefined}
                      >
                        {isValidDate
                          ? dateObj.toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            })
                          : "—"}
                      </time>
                      <p
                        className={cn(
                          "mt-0.5 break-words text-[11px] leading-snug",
                          entry.level === "error" && "text-destructive font-medium",
                          entry.level === "warn" && "text-amber-300",
                          entry.level === "success" && "text-emerald-300",
                        )}
                      >
                        {sanitizeLogMessage(entry.message)}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>
          </ScrollArea>
        ) : (
          <p className="text-xs text-muted-foreground py-2 text-center">
            No activity recorded yet.
          </p>
        )}
      </TabsContent>
    </Tabs>
  );
}
