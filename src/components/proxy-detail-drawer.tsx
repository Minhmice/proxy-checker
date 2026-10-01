"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Clock,
  Globe2,
  Loader2,
  Play,
  RotateCcw,
  Shield,
  Wifi,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "./auth-provider";
import { checkProxyValidity, fetchProxyHistory } from "@/lib/api";
import { isAbortError } from "@/lib/request-lifecycle";
import type { UnifiedProxyItem, UnifiedProxyHistoryEntry } from "@/lib/types";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

export interface ProxyDetailDrawerProps {
  proxy: UnifiedProxyItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProxyUpdated?: (updated: UnifiedProxyItem) => void;
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function ProxyDetailDrawer({
  proxy,
  open,
  onOpenChange,
  onProxyUpdated,
}: ProxyDetailDrawerProps) {
  const { password } = useAuth();
  const [checking, setChecking] = useState(false);
  const [history, setHistory] = useState<UnifiedProxyHistoryEntry[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  useEffect(() => {
    if (!open || !proxy || !password) {
      setHistory([]);
      return;
    }

    const controller = new AbortController();
    setLoadingHistory(true);

    fetchProxyHistory(password, proxy.key, controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) {
          setHistory(res.history);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted && !isAbortError(err)) {
          console.error("Failed to load history:", err);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoadingHistory(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [open, proxy?.key, password]);

  const handleCheck = async () => {
    if (!proxy || !password || checking) return;
    setChecking(true);
    try {
      const res = await checkProxyValidity(password, proxy.key);
      toast.success(`Check succeeded for ${proxy.name}`);
      if (onProxyUpdated) {
        onProxyUpdated(res.proxy);
      }
      // Refresh history
      const hist = await fetchProxyHistory(password, proxy.key);
      setHistory(hist.history);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setChecking(false);
    }
  };

  if (!proxy) return null;

  const isWorking = proxy.status === "working";
  const locationText = [proxy.geo?.city, proxy.geo?.country].filter(Boolean).join(", ") || "Unknown Location";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md md:max-w-lg flex flex-col p-6 overflow-hidden">
        <SheetHeader className="border-b border-border/40 pb-4">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px] uppercase font-mono tracking-wider">
              {proxy.protocol}
            </Badge>
            <span className="text-[11px] text-muted-foreground font-mono">This device</span>
          </div>
          <SheetTitle className="text-lg font-bold font-mono tracking-tight mt-1 text-foreground">
            {proxy.name}
          </SheetTitle>
          <SheetDescription className="text-xs text-muted-foreground">
            Connection test
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1 mt-4 pr-3">
          <div className="space-y-6 text-xs">
            {/* Verified Exit Section */}
            <div className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-muted-foreground uppercase text-[10px] tracking-wider">
                  Verified exit
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  {proxy.host}:{proxy.port}
                </span>
              </div>

              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xl font-bold font-mono text-foreground">
                  {proxy.exitIp || proxy.host}
                </span>
                <Badge variant="secondary" className="text-xs font-normal">
                  <Globe2 className="h-3 w-3 mr-1 text-muted-foreground" />
                  {locationText}
                </Badge>
              </div>

              {/* Status Banner */}
              <div className="pt-2 border-t border-border/40 flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5">
                  {isWorking ? (
                    <>
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                      <span className="font-medium text-emerald-500">Last check succeeded</span>
                    </>
                  ) : (
                    <>
                      <XCircle className="h-4 w-4 text-rose-500" />
                      <span className="font-medium text-rose-500">Last check failed</span>
                    </>
                  )}
                </div>
                {proxy.lastCheckedAt && (
                  <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {new Date(proxy.lastCheckedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                )}
              </div>
            </div>

            {/* 4-Box Metrics Grid */}
            <div className="grid grid-cols-2 gap-3">
              {/* UDP */}
              <div className="rounded-lg border border-border/50 bg-card p-3">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                  UDP
                </span>
                <div className="mt-1 flex items-center gap-1.5">
                  <Badge
                    variant={proxy.udp === "Yes" ? "default" : "secondary"}
                    className={proxy.udp === "Yes" ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-xs" : "text-xs"}
                  >
                    {proxy.udp}
                  </Badge>
                </div>
              </div>

              {/* ISP */}
              <div className="rounded-lg border border-border/50 bg-card p-3">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                  ISP
                </span>
                <p className="mt-1 font-medium truncate text-foreground" title={proxy.isp || "Unknown"}>
                  {proxy.isp || "Unknown ISP"}
                </p>
              </div>

              {/* Timezone */}
              <div className="rounded-lg border border-border/50 bg-card p-3">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                  Timezone
                </span>
                <p className="mt-1 font-medium truncate text-foreground" title={proxy.timezone || "Unknown"}>
                  {proxy.timezone || "Unknown"}
                </p>
              </div>

              {/* Took */}
              <div className="rounded-lg border border-border/50 bg-card p-3">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                  Took
                </span>
                <p className="mt-1 font-mono font-semibold text-foreground">
                  {proxy.latencyMs !== null ? `${proxy.latencyMs} ms` : "—"}
                </p>
              </div>
            </div>

            <p className="text-[11px] text-muted-foreground italic px-1">
              This tests the stored proxy. A profile may use different routing.
            </p>

            {/* Check validity action */}
            <div>
              <Button
                className="w-full h-10 font-medium text-xs gap-2"
                onClick={handleCheck}
                disabled={checking}
              >
                {checking ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Testing connectivity & UDP...</span>
                  </>
                ) : (
                  <>
                    <RotateCcw className="h-4 w-4" />
                    <span>Check proxy validity</span>
                  </>
                )}
              </Button>
            </div>

            {/* Recent Checks History */}
            <div className="pt-2">
              <h4 className="font-semibold text-foreground text-xs mb-3 flex items-center justify-between">
                <span>Recent checks</span>
                {loadingHistory && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
              </h4>

              {history.length === 0 ? (
                <div className="rounded-md border border-dashed border-border/60 p-4 text-center text-muted-foreground">
                  No check history recorded yet.
                </div>
              ) : (
                <div className="space-y-2">
                  {history.map((entry) => (
                    <div
                      key={entry.id}
                      className="rounded-lg border border-border/40 bg-card p-3 flex items-center justify-between text-xs"
                    >
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <Badge
                            variant={entry.status === "passed" ? "default" : "destructive"}
                            className={entry.status === "passed" ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px] uppercase py-0" : "text-[10px] uppercase py-0"}
                          >
                            {entry.status === "passed" ? "Passed" : "Failed"}
                          </Badge>
                          <span className="font-mono text-xs text-foreground">
                            {entry.exitIp || "—"}
                          </span>
                        </div>
                        <p className="text-[11px] text-muted-foreground truncate max-w-[200px]">
                          {entry.isp || "Unknown ISP"} • UDP {entry.udp}
                        </p>
                      </div>

                      <div className="text-right">
                        <div className="font-mono font-medium text-foreground">
                          {entry.latencyMs !== null ? `${entry.latencyMs} ms` : "—"}
                        </div>
                        <span className="text-[10px] text-muted-foreground">
                          {formatRelativeTime(entry.timestamp)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
