"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Globe2,
  HelpCircle,
  Info,
  Loader2,
  RotateCcw,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import {
  checkProxyValidity,
  fetchProxyAuditDetail,
  fetchProxyHistory,
} from "@/lib/api";
import { isAbortError } from "@/lib/request-lifecycle";
import type {
  UnifiedProxyItem,
  UnifiedProxyHistoryEntry,
  ProxyAuditDetail,
  AuditProbe,
  AuditReason,
} from "@/lib/types";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

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
  // ponytail: Local state + Promise.all handles audit detail & history together. Keep unified load until detail payload splits into lazy tabs.
  const [checking, setChecking] = useState(false);
  const [history, setHistory] = useState<UnifiedProxyHistoryEntry[]>([]);
  const [auditDetail, setAuditDetail] = useState<ProxyAuditDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const proxyKey = proxy?.key || proxy?.proxyKey;
  const activeControllerRef = useRef<AbortController | null>(null);

  const loadDetailsAndHistory = async () => {
    if (!proxyKey) return;

    if (activeControllerRef.current) {
      activeControllerRef.current.abort();
    }
    const controller = new AbortController();
    activeControllerRef.current = controller;
    const signal = controller.signal;

    setLoadingDetail(true);
    setDetailError(null);

    try {
      const [detailRes, histRes] = await Promise.all([
        fetchProxyAuditDetail(proxyKey, undefined, signal),
        fetchProxyHistory(proxyKey, signal),
      ]);
      if (!signal.aborted) {
        setAuditDetail(detailRes.auditDetail);
        setHistory(histRes.history);
        setDetailError(null);
      }
    } catch (err) {
      if (!signal.aborted && !isAbortError(err)) {
        console.error("Failed to load proxy details:", err);
        setDetailError((err as Error).message || "Failed to load audit details and history");
      }
    } finally {
      if (!signal.aborted) {
        setLoadingDetail(false);
      }
    }
  };

  useEffect(() => {
    if (!open || !proxyKey) {
      if (activeControllerRef.current) {
        activeControllerRef.current.abort();
        activeControllerRef.current = null;
      }
      setHistory([]);
      setAuditDetail(null);
      setDetailError(null);
      return;
    }

    loadDetailsAndHistory();

    return () => {
      if (activeControllerRef.current) {
        activeControllerRef.current.abort();
        activeControllerRef.current = null;
      }
    };
  }, [open, proxyKey]);

  const handleCheck = async () => {
    if (!proxyKey || checking) return;
    setChecking(true);
    try {
      const res = await checkProxyValidity(proxyKey);
      toast.success(`Check succeeded: ${res.proxy.health?.toUpperCase() || res.proxy.status.toUpperCase()}`);
      if (onProxyUpdated) {
        onProxyUpdated(res.proxy);
      }

      // Refresh detail and history
      await loadDetailsAndHistory();
    } catch (err) {
      toast.error((err as Error).message || "Proxy check failed");
    } finally {
      setChecking(false);
    }
  };


  if (!proxy) return null;

  const endpoint = `${proxy.host}:${proxy.port}`;
  const effectiveVerdict = auditDetail?.verdict || proxy.lastAudit?.verdict || (proxy.status === "working" ? "PASS" : "FAIL");
  const isHealthy = proxy.health === "working" || proxy.status === "working";
  const isRegressed = proxy.health === "regressed" || proxy.status === "regressed";

  const renderVerdictBadge = (verdict: string) => {
    switch (verdict) {
      case "PASS":
        return (
          <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/40 text-xs font-semibold px-2.5 py-0.5">
            <CheckCircle2 className="h-3 w-3 mr-1 shrink-0" />
            PASS
          </Badge>
        );
      case "WARN":
        return (
          <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/40 text-xs font-semibold px-2.5 py-0.5">
            <AlertTriangle className="h-3 w-3 mr-1 shrink-0" />
            WARN
          </Badge>
        );
      case "FAIL":
        return (
          <Badge className="bg-rose-500/20 text-rose-400 border-rose-500/40 text-xs font-semibold px-2.5 py-0.5">
            <XCircle className="h-3 w-3 mr-1 shrink-0" />
            FAIL
          </Badge>
        );
      default:
        return (
          <Badge variant="outline" className="text-muted-foreground text-xs font-semibold px-2.5 py-0.5">
            <HelpCircle className="h-3 w-3 mr-1 shrink-0" />
            UNKNOWN
          </Badge>
        );
    }
  };

  const renderProbeStatus = (status: AuditProbe["status"]) => {
    switch (status) {
      case "PASS":
        return <span className="text-[11px] font-semibold text-emerald-400 uppercase">PASS</span>;
      case "WARN":
        return <span className="text-[11px] font-semibold text-amber-400 uppercase">WARN</span>;
      case "FAIL":
        return <span className="text-[11px] font-semibold text-rose-400 uppercase">FAIL</span>;
      case "UNSUPPORTED":
        return <span className="text-[11px] font-medium text-muted-foreground uppercase">UNSUPPORTED</span>;
      case "SKIPPED":
        return <span className="text-[11px] font-medium text-muted-foreground uppercase">SKIPPED</span>;
      case "ERROR":
      default:
        return <span className="text-[11px] font-semibold text-rose-400 uppercase">ERROR</span>;
    }
  };

  const scores = auditDetail?.scores || {
    overallSafety: proxy.lastAudit?.overallSafety ?? null,
    transportSecurity: null,
    privacy: null,
    reputation: null,
    reliability: null,
  };

  const scoreItems = [
    { label: "Overall Safety", value: scores.overallSafety },
    { label: "Transport Security", value: scores.transportSecurity },
    { label: "Privacy", value: scores.privacy },
    { label: "Reputation", value: scores.reputation },
    { label: "Reliability", value: scores.reliability },
  ];

  // ponytail: Exit node verified only when probe or audit returns explicit exit IP. Host address must never masquerade as verified exit.
  const verifiedExitIp = auditDetail?.exit?.ip || proxy.exitIp || null;
  const locationText = [
    auditDetail?.exit?.city || proxy.geo?.city,
    auditDetail?.exit?.country || proxy.geo?.country,
  ]
    .filter(Boolean)
    .join(", ") || (verifiedExitIp ? "Unknown Location" : "Unmeasured");

  const ispText = auditDetail?.exit?.isp || proxy.isp || (verifiedExitIp ? "Unknown ISP" : "Unmeasured");
  const asnText = auditDetail?.exit?.asn ? ` • ${auditDetail.exit.asn}` : "";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md md:max-w-lg lg:max-w-xl flex flex-col p-4 sm:p-6 h-full max-h-screen overflow-hidden bg-card border-border/80">
        <SheetHeader className="shrink-0 border-b border-border/50 pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-[10px] uppercase font-mono tracking-wider">
                {proxy.protocol}
              </Badge>
              <span className="text-xs text-muted-foreground font-mono">
                {proxy.source || "inventory"}
              </span>
            </div>
            {renderVerdictBadge(effectiveVerdict)}
          </div>

          <div className="flex items-center justify-between gap-2 mt-2">
            <SheetTitle className="text-base font-bold font-mono tracking-tight text-foreground break-all">
              {endpoint}
            </SheetTitle>
            <CopyButton value={endpoint} label="Endpoint" className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground shrink-0" />
          </div>

          <SheetDescription className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5">
            <Clock className="h-3 w-3 shrink-0" />
            <span>
              {auditDetail?.checkedAt
                ? new Date(auditDetail.checkedAt).toLocaleString()
                : proxy.lastCheckedAt
                ? new Date(proxy.lastCheckedAt).toLocaleString()
                : "Not checked yet"}
            </span>
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1 mt-4 pr-3 -mr-3 overflow-y-auto min-h-0">
          <div className="space-y-6 text-xs pr-2">
            {/* Error Banner if Load Failed */}
            {detailError && (
              <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3.5 space-y-2 text-xs animate-in fade-in duration-150">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-rose-400 font-semibold">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    <span>Audit Details Load Error</span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => loadDetailsAndHistory()}
                    disabled={loadingDetail}
                    className="h-7 text-xs border-rose-500/40 text-rose-300 hover:bg-rose-500/20"
                  >
                    {loadingDetail ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <RotateCcw className="h-3 w-3 mr-1" />}
                    Retry
                  </Button>
                </div>
                <p className="text-[11px] text-rose-300/90 font-mono break-all">
                  {detailError}
                </p>
              </div>
            )}

            {/* Regression Banner if Regressed */}
            {isRegressed && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3.5 space-y-1.5 animate-in fade-in duration-200">
                <div className="flex items-center gap-2 text-amber-400 font-semibold">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  <span>Regression Detected (Zombie Proxy)</span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  This proxy successfully connected or passed audits in the past, but is currently unreachable.
                </p>
              </div>
            )}

            {/* Verified Exit Card */}
            <div className="rounded-lg border border-border/60 bg-surface/50 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block">
                  Verified Exit Node
                </span>
                {!verifiedExitIp && (
                  <Badge variant="outline" className="text-[10px] text-muted-foreground font-mono">
                    Unmeasured
                  </Badge>
                )}
              </div>

              <div className="flex items-baseline justify-between gap-2 flex-wrap">
                <span className={cn(
                  "font-bold font-mono break-all",
                  verifiedExitIp ? "text-xl text-foreground" : "text-sm text-muted-foreground/80 italic"
                )}>
                  {verifiedExitIp || "Exit IP unverified (no probe recorded)"}
                </span>
                <Badge variant="secondary" className="text-xs font-normal">
                  <Globe2 className="h-3 w-3 mr-1 text-muted-foreground" />
                  {locationText}
                </Badge>
              </div>

              <div className="text-xs text-muted-foreground flex items-center justify-between pt-2 border-t border-border/40 gap-2">
                <span className="truncate max-w-[240px]" title={`${ispText}${asnText}`}>
                  {ispText}
                  {asnText}
                </span>
                <span className="font-mono text-foreground font-medium shrink-0">
                  {proxy.latencyMs !== null ? `${proxy.latencyMs} ms` : "—"}
                </span>
              </div>
            </div>

            {/* 5 Security & Performance Scores */}
            <div className="space-y-2.5">
              <h4 className="font-semibold text-foreground text-xs uppercase tracking-wider flex items-center justify-between">
                <span>Security & Reliability Scores</span>
                {loadingDetail && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
              </h4>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                {scoreItems.map((item) => {
                  const score = item.value;
                  const hasScore = typeof score === "number";

                  return (
                    <div
                      key={item.label}
                      className="rounded-lg border border-border/50 bg-surface/40 p-2.5 flex flex-col justify-between"
                    >
                      <span className="text-[10px] uppercase font-semibold text-muted-foreground truncate" title={item.label}>
                        {item.label}
                      </span>
                      <span
                        className={cn(
                          "font-mono text-base font-bold mt-1",
                          hasScore
                            ? score >= 80
                              ? "text-emerald-400"
                              : score >= 50
                              ? "text-amber-400"
                              : "text-rose-400"
                            : "text-muted-foreground/60 text-xs"
                        )}
                      >
                        {hasScore ? `${score}/100` : "Not measured"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Why This Verdict (Reason Codes) */}
            {auditDetail?.reasons && auditDetail.reasons.length > 0 && (
              <div className="space-y-2.5">
                <h4 className="font-semibold text-foreground text-xs uppercase tracking-wider">
                  Audit Findings & Reasoning
                </h4>

                <div className="space-y-2">
                  {auditDetail.reasons.map((reason, idx) => (
                    <div
                      key={`${reason.code}-${idx}`}
                      className={cn(
                        "rounded-lg border p-3 flex items-start gap-2.5",
                        reason.severity === "critical"
                          ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
                          : reason.severity === "warning"
                          ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                          : "border-blue-500/40 bg-blue-500/10 text-blue-300"
                      )}
                    >
                      {reason.severity === "critical" ? (
                        <ShieldAlert className="h-4 w-4 shrink-0 text-rose-400 mt-0.5" />
                      ) : reason.severity === "warning" ? (
                        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
                      ) : (
                        <Info className="h-4 w-4 shrink-0 text-blue-400 mt-0.5" />
                      )}

                      <div className="space-y-0.5 flex-1">
                        <div className="flex items-center justify-between">
                          <span className="font-mono font-semibold text-xs tracking-tight">
                            {reason.code}
                          </span>
                          <span className="text-[10px] uppercase tracking-wider font-semibold opacity-80">
                            {reason.severity}
                          </span>
                        </div>
                        <p className="text-[11px] leading-relaxed opacity-90">{reason.summary}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Measurement Probes Evidence */}
            {auditDetail?.probes && auditDetail.probes.length > 0 && (
              <div className="space-y-2.5">
                <h4 className="font-semibold text-foreground text-xs uppercase tracking-wider">
                  Probe Measurement Details
                </h4>

                <div className="rounded-lg border border-border/60 bg-surface/30 divide-y divide-border/40">
                  {auditDetail.probes.map((probe) => (
                    <div key={probe.name} className="p-3 flex items-center justify-between gap-3">
                      <div className="space-y-0.5 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-semibold text-foreground uppercase">
                            {probe.name}
                          </span>
                          {renderProbeStatus(probe.status)}
                        </div>
                        <p className="text-[11px] text-muted-foreground leading-normal">{probe.summary}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Check Action Button */}
            <div>
              <Button
                className="w-full h-10 font-semibold text-xs gap-2 bg-primary text-primary-foreground hover:bg-primary-hover cursor-pointer"
                onClick={handleCheck}
                disabled={checking}
                aria-label={`Run audit on ${endpoint}`}
              >
                {checking ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Executing full audit pipeline...</span>
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
            <div className="space-y-2.5 pt-2">
              <div className="flex items-center justify-between">
                <h4 className="font-semibold text-foreground text-xs uppercase tracking-wider">
                  Recent Checks History
                </h4>
                <span className="text-muted-foreground font-mono text-[11px]">
                  {loadingDetail ? "Loading..." : `${history.length} record${history.length === 1 ? "" : "s"}`}
                </span>
              </div>

              {detailError && history.length === 0 ? (
                <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-4 text-center space-y-2">
                  <p className="text-rose-400 text-xs">Error loading history from server.</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => loadDetailsAndHistory()}
                    disabled={loadingDetail}
                    className="h-7 text-xs text-rose-300 hover:text-rose-200"
                  >
                    <RotateCcw className="h-3 w-3 mr-1.5" />
                    Try again
                  </Button>
                </div>
              ) : history.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/60 p-4 text-center text-muted-foreground">
                  No check history recorded yet.
                </div>
              ) : (
                <div className="space-y-2">
                  {history.map((entry) => (
                    <div
                      key={entry.id}
                      className="rounded-lg border border-border/50 bg-surface/30 p-3 flex items-start justify-between text-xs gap-3"
                    >
                      <div className="space-y-1 min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge
                            variant={entry.status === "passed" ? "default" : "destructive"}
                            className={cn(
                              "text-[10px] uppercase font-mono py-0 shrink-0",
                              entry.status === "passed"
                                ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                                : ""
                            )}
                          >
                            {entry.status === "passed" ? "Passed" : "Failed"}
                          </Badge>
                          <span className="font-mono text-xs text-foreground break-all">
                            {entry.exitIp || "Exit unmeasured"}
                          </span>
                        </div>

                        {entry.errorMessage ? (
                          <p className="text-[11px] text-rose-400 font-mono break-all leading-relaxed">
                            {entry.errorMessage}
                          </p>
                        ) : null}

                        <p className="text-[11px] text-muted-foreground">
                          {entry.udp === "Unknown" || !entry.udp
                            ? "UDP not measured"
                            : `UDP: ${entry.udp}`}
                        </p>
                      </div>

                      <div className="text-right shrink-0">
                        <div className="font-mono font-medium text-foreground">
                          {entry.latencyMs !== null ? `${entry.latencyMs} ms` : "—"}
                        </div>
                        <span className="text-[10px] text-muted-foreground block whitespace-nowrap">
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
