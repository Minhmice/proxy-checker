"use client";

import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Globe2,
  Loader2,
  Play,
  Pin,
  RotateCcw,
  SlidersHorizontal,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Status, StatusIndicator, StatusLabel } from "@/components/ui/status";
import { CopyButton } from "@/components/ui/copy-button";
import { LatencyIndicator } from "./latency-indicator";
import type { UnifiedProxyItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ProxyContextMenu } from "./proxy-context-menu";

export interface ProxyTableProps {
  items: UnifiedProxyItem[];
  loading: boolean;
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (newPage: number) => void;
  selectedKeys: Set<string>;
  onToggleSelectKey: (key: string) => void;
  onToggleSelectAllPage: () => void;
  allPageSelected: boolean;
  checkingKey: string | null;
  onCheckSingle: (proxy: UnifiedProxyItem) => void;
  onOpenDetail: (proxy: UnifiedProxyItem) => void;
  copiedKey: string | null;
  onCopyEndpoint: (text: string) => void;
  onResetFilters?: () => void;
  onTogglePin?: (proxy: UnifiedProxyItem) => void;
  onUnlinkRouter?: (proxy: UnifiedProxyItem) => void;
  onPushRouter?: (proxy: UnifiedProxyItem) => void;
  onHardDelete?: (proxy: UnifiedProxyItem) => void;
}

export function ProxyTable({
  items,
  loading,
  page,
  pageSize,
  total,
  onPageChange,
  selectedKeys,
  onToggleSelectKey,
  onToggleSelectAllPage,
  allPageSelected,
  checkingKey,
  onCheckSingle,
  onOpenDetail,
  copiedKey,
  onCopyEndpoint,
  onResetFilters,
  onTogglePin,
  onUnlinkRouter,
  onPushRouter,
  onHardDelete,
}: ProxyTableProps) {
  const totalPages = Math.ceil(total / pageSize) || 1;

  const renderHealthBadge = (health: string) => {
    switch (health) {
      case "working":
        return (
          <Status variant="success">
            <StatusIndicator />
            <StatusLabel>Healthy</StatusLabel>
          </Status>
        );
      case "regressed":
        return (
          <Status variant="warning">
            <StatusIndicator />
            <StatusLabel>Regressed</StatusLabel>
          </Status>
        );
      case "dead":
      default:
        return (
          <Status variant="error">
            <StatusIndicator />
            <StatusLabel>Dead</StatusLabel>
          </Status>
        );
    }
  };

  const renderPoolBadge = (tier: string | null, routerState?: string) => {
    if (routerState === "removed") {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] uppercase font-mono font-medium tracking-wider bg-rose-500/10 text-rose-400 border border-rose-500/30">
          Offline
        </span>
      );
    }
    if (!tier || tier === "unsynced") {
      return <span className="text-muted-foreground/60 font-mono text-[11px]">—</span>;
    }
    if (tier === "active") {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] uppercase font-mono font-semibold tracking-wider bg-primary/20 text-primary border border-primary/40">
          Active
        </span>
      );
    }
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] uppercase font-mono font-semibold tracking-wider bg-muted/40 text-muted-foreground border border-border/50">
        Reserve
      </span>
    );
  };

  return (
    <div className="rounded-lg border border-border/70 bg-card overflow-hidden shadow-sm flex flex-col">
      {loading && items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 p-12 text-center text-muted-foreground min-h-[380px]">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <span className="text-xs font-medium">Loading proxy fleet...</span>
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 p-12 text-center text-muted-foreground min-h-[380px]">
          <p className="text-xs">No proxies match the selected filters or search.</p>
          {onResetFilters && (
            <Button
              variant="outline"
              size="sm"
              onClick={onResetFilters}
              className="text-xs h-9 cursor-pointer"
            >
              Reset filters
            </Button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto min-h-[380px] w-full rounded-2xl border border-[#23232C] bg-[#131318] shadow-sm">
          <Table className="w-full">
            <TableHeader className="bg-surface/80">
              <TableRow className="border-border/60 hover:bg-transparent">
                <TableHead className="w-10 px-3">
                  <Checkbox
                    checked={allPageSelected}
                    onCheckedChange={onToggleSelectAllPage}
                    aria-label="Select all proxies on page"
                  />
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground min-w-[140px]">
                  Proxy Endpoint
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground hidden sm:table-cell">
                  Protocol
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Health
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground hidden sm:table-cell">
                  Pool
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground hidden md:table-cell">
                  Exit / ISP
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground hidden 3xl:table-cell">
                  Safety Audit
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground text-right hidden sm:table-cell">
                  Latency
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground text-right pr-4 min-w-[70px]">
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const isSelected = selectedKeys.has(item.key || item.proxyKey);
                const isChecking = checkingKey === (item.key || item.proxyKey);
                const endpoint = `${item.host}:${item.port}`;
                const locationText = [item.geo?.city, item.geo?.country].filter(Boolean).join(", ");
                const auditVerdict = item.lastAudit?.verdict;
                const safetyScore = item.lastAudit?.overallSafety ?? null;

                return (
                  <ProxyContextMenu
                    key={item.key || item.proxyKey}
                    proxy={item}
                    onTest={onCheckSingle}
                    onTogglePin={onTogglePin}
                    onUnlinkRouter={onUnlinkRouter}
                    onPushRouter={onPushRouter}
                    onHardDelete={onHardDelete}
                    onOpenDetail={onOpenDetail}
                  >
                    <TableRow
                      data-state={isSelected ? "selected" : undefined}
                      className={cn(
                        "border-border/50 transition-colors group cursor-pointer",
                        isSelected ? "bg-primary/5" : "hover:bg-surface/50",
                      )}
                      onClick={(e) => {
                        const target = e.target as HTMLElement;
                        if (target.closest("button") || target.closest("input")) return;
                        onOpenDetail(item);
                      }}
                    >
                      {/* Checkbox */}
                      <TableCell className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-center min-w-[24px] min-h-[36px]">
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => onToggleSelectKey(item.key || item.proxyKey)}
                            aria-label={`Select proxy ${endpoint}`}
                          />
                        </div>
                      </TableCell>

                      {/* Endpoint + Pin + Copy */}
                      <TableCell className="font-mono text-xs font-medium text-foreground py-3 max-w-[180px] sm:max-w-[240px] 3xl:max-w-md 5xl:max-w-xl">
                        <div className="flex items-center gap-1.5 min-w-0">
                          {item.isPinned && (
                            <Pin
                              className="h-3 w-3 text-amber-400 fill-amber-400/20 shrink-0"
                              aria-label="Protected proxy"
                            />
                          )}
                          <span
                            className="truncate hover:text-primary transition-colors block"
                            title={endpoint}
                          >
                            {endpoint}
                          </span>
                          <div onClick={(e) => e.stopPropagation()} className="shrink-0">
                            <CopyButton
                              value={endpoint}
                              label={endpoint}
                              size="icon-xs"
                              className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 p-1 hover:text-foreground text-muted-foreground transition-all shrink-0"
                            />
                          </div>
                        </div>
                      </TableCell>
                      {/* Protocol */}
                      <TableCell className="hidden sm:table-cell">
                        <Badge
                          variant="outline"
                          className="text-[10px] uppercase font-mono tracking-wider py-0"
                        >
                          {item.protocol}
                        </Badge>
                      </TableCell>

                      {/* Health Status */}
                      <TableCell>{renderHealthBadge(item.health || item.status)}</TableCell>

                      {/* Pool Tier */}
                      <TableCell className="hidden sm:table-cell">
                        {renderPoolBadge(item.poolTier ?? (item.sync as string), item.routerState)}
                      </TableCell>

                      {/* Exit IP & Location / ISP */}
                      <TableCell className="text-xs hidden md:table-cell">
                        {item.exitIp ? (
                          <div className="space-y-0.5">
                            <span className="font-mono text-xs font-medium text-foreground block">
                              {item.exitIp}
                            </span>
                            <span
                              className="text-[11px] text-muted-foreground flex items-center gap-1 truncate max-w-[200px] 3xl:max-w-xs 5xl:max-w-md"
                              title={item.isp || locationText}
                            >
                              {locationText && <Globe2 className="h-2.5 w-2.5 shrink-0" />}
                              {locationText || item.isp || "Unknown location"}
                            </span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground/60 font-mono text-[11px]">—</span>
                        )}
                      </TableCell>
                      {/* 4K/Ultra-wide Safety Audit Score */}
                      <TableCell className="hidden 3xl:table-cell font-mono text-xs">
                        {safetyScore != null ? (
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-[10px] font-mono px-1.5 py-0",
                              safetyScore >= 80
                                ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
                                : safetyScore >= 60
                                  ? "text-amber-400 border-amber-500/30 bg-amber-500/10"
                                  : "text-rose-400 border-rose-500/30 bg-rose-500/10",
                            )}
                          >
                            {safetyScore}%
                          </Badge>
                        ) : auditVerdict ? (
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-[10px] font-mono uppercase px-1.5 py-0",
                              auditVerdict === "PASS"
                                ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
                                : "text-amber-400 border-amber-500/30 bg-amber-500/10",
                            )}
                          >
                            {auditVerdict}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground/50 font-mono text-[11px]">—</span>
                        )}
                      </TableCell>

                      {/* Latency */}
                      <TableCell className="text-right hidden sm:table-cell">
                        <LatencyIndicator
                          latencyMs={item.latencyMs}
                          isDead={item.health === "dead"}
                          showBar={false}
                        />
                      </TableCell>

                      {/* Row Actions */}
                      <TableCell className="text-right pr-4" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onCheckSingle(item)}
                            disabled={isChecking}
                            className="h-8 w-8 sm:h-7 sm:w-7 p-0 text-muted-foreground hover:text-foreground cursor-pointer"
                            aria-label={`Test connectivity for ${endpoint}`}
                          >
                            {isChecking ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                            ) : (
                              <Play className="h-3.5 w-3.5" />
                            )}
                          </Button>

                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onOpenDetail(item)}
                            className="h-8 w-8 sm:h-7 sm:w-7 p-0 text-muted-foreground hover:text-foreground cursor-pointer"
                            aria-label={`Inspect details for ${endpoint}`}
                          >
                            <SlidersHorizontal className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  </ProxyContextMenu>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Pagination Footer */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3 border-t border-border/60 bg-surface/40 text-xs text-muted-foreground">
        <div className="text-center sm:text-left">
          Showing{" "}
          <strong className="font-semibold text-foreground">
            {total > 0 ? (page - 1) * pageSize + 1 : 0}
          </strong>{" "}
          to{" "}
          <strong className="font-semibold text-foreground">
            {Math.min(page * pageSize, total)}
          </strong>{" "}
          of <strong className="font-semibold text-foreground">{total.toLocaleString()}</strong>{" "}
          proxies
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(Math.max(1, page - 1))}
            disabled={page <= 1 || loading}
            className="h-8 w-8 sm:h-7 sm:w-7 p-0 border-border/70 cursor-pointer"
            aria-label="Previous page"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>

          <span className="font-mono text-xs px-2">
            Page {page} of {totalPages}
          </span>

          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(Math.min(totalPages, page + 1))}
            disabled={page >= totalPages || loading}
            className="h-8 w-8 sm:h-7 sm:w-7 p-0 border-border/70 cursor-pointer"
            aria-label="Next page"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
