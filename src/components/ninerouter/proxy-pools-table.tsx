"use client";

import React from "react";
import {
  Globe,
  FlaskConical,
  Trash2,
  Link as LinkIcon,
  CheckCircle2,
  XCircle,
  HelpCircle,
  AlertCircle,
  RefreshCw,
} from "lucide-react";
import {
  type LoadState,
  resolvePoolLifecycleBadge,
  resolvePoolLatencyDisplay,
} from "@/lib/proxy-binding-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { motion } from "motion/react";
export interface ProxyPoolItem {
  id: string;
  name: string;
  proxyUrl: string;
  type?: string;
  isActive?: boolean;
  boundCount?: number;
  latencyMs?: number;
  failCount?: number;
  weight?: number;
}

interface ProxyPoolsTableProps {
  pools: ProxyPoolItem[];
  selectedConnectionId: string | null;
  onAssignToSelected: (poolId: string) => void;
  onToggleActive: (poolId: string, current: boolean) => void;
  onTestPool: (poolId: string) => void;
  onDeletePool: (poolId: string) => void;
  testResults: Record<string, { ok: boolean; elapsedMs?: number; error?: string }>;
  testingMap: Record<string, boolean>;
  loading?: boolean;
  loadState?: LoadState;
  loadError?: string | null;
  onRetry?: () => void;
  isFiltered?: boolean;
  onClearFilter?: () => void;
}

function FieldInfo({ content }: { content: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="More information"
          className="inline-flex items-center text-[#9E9EA8]/70 hover:text-[#FF5B22] transition-colors cursor-help p-0.5 ml-1 bg-transparent border-0"
        >
          <HelpCircle className="size-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="center"
        className="max-w-xs text-xs bg-[#1C1C24] text-zinc-200 border border-[#23232C] shadow-xl z-50"
      >
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

function renderStatusBadge(pool: ProxyPoolItem) {
  const badge = resolvePoolLifecycleBadge(pool);
  const colorMap = {
    success: "border-[#10B981]/30 bg-[#10B981]/15 text-[#10B981]",
    warning: "border-[#F59E0B]/30 bg-[#F59E0B]/15 text-[#F59E0B]",
    error: "border-rose-500/30 bg-rose-500/15 text-rose-400",
    muted: "border-zinc-700 bg-zinc-800/60 text-zinc-400",
  };
  return (
    <Badge
      variant="outline"
      className={`text-[10px] px-1.5 py-0.5 font-medium ${colorMap[badge.tone]}`}
    >
      {badge.label}
    </Badge>
  );
}

export function ProxyPoolsTable({
  pools,
  selectedConnectionId,
  onAssignToSelected,
  onToggleActive,
  onTestPool,
  onDeletePool,
  testResults,
  testingMap,
  loading,
  loadState = "ready",
  loadError,
  onRetry,
  isFiltered,
  onClearFilter,
}: ProxyPoolsTableProps) {
  return (
    <div className="flex flex-col h-full rounded-2xl border border-[#23232C] bg-[#131318] shadow-sm overflow-hidden">
      {/* Top Header */}
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-[#23232C] bg-[#0F0F13]">
        <div className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-lg bg-[#FF5B22]/15 text-[#FF5B22] border border-[#FF5B22]/30">
            <Globe className="size-3.5" />
          </span>
          <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-100">
            Proxy Pools ({pools.length})
          </h3>
        </div>
        <div className="flex items-center gap-1.5">
          <Badge
            variant="outline"
            className="text-[10px] px-2 py-0.5 border-[#10B981]/30 bg-[#10B981]/15 text-[#10B981] font-medium"
          >
            {pools.filter((p) => p.isActive).length} Active
          </Badge>
        </div>
      </div>

      {/* Table Column Headers */}
      <div className="grid grid-cols-12 gap-2 px-4 py-2.5 bg-[#0F0F13] text-[#9E9EA8] font-semibold text-xs border-b border-[#23232C] items-center">
        <div className="col-span-5 flex items-center">
          <span>Pool / Target</span>
        </div>
        <div className="col-span-2 flex items-center">
          <span>Latency</span>
          <FieldInfo content="Round-trip network ping latency to proxy endpoint measured in milliseconds." />
        </div>
        <div className="col-span-2 flex items-center">
          <span>Fail / Wt</span>
          <FieldInfo content="Consecutive failure count before auto-failover, and routing traffic weight." />
        </div>
        <div className="col-span-3 flex items-center justify-end">
          <span>Actions</span>
        </div>
      </div>

      {/* Table Body */}
      <div className="flex-1 overflow-y-auto divide-y divide-[#23232C]/40 min-h-[450px] max-h-[620px]">
        {loadState === "loading" || loading ? (
          <div className="flex items-center justify-center h-48 text-xs text-[#9E9EA8]">
            Loading proxy pools...
          </div>
        ) : loadState === "error" ? (
          <div className="flex flex-col items-center justify-center h-48 text-rose-400 gap-2 text-xs px-4 text-center">
            <AlertCircle className="size-5" />
            <span className="font-medium">
              {loadError || "Failed to load proxy pools from node"}
            </span>
            {onRetry && (
              <Button
                size="sm"
                variant="outline"
                onClick={onRetry}
                className="h-7 text-xs border-[#23232C] bg-[#1C1C24] text-zinc-200 hover:text-white mt-1 gap-1"
              >
                <RefreshCw className="size-3" />
                Retry Connection
              </Button>
            )}
          </div>
        ) : pools.length === 0 ? (
          isFiltered ? (
            <div className="flex flex-col items-center justify-center h-48 text-[#9E9EA8] gap-2 text-xs">
              <span>No proxy pools match current search or filter</span>
              {onClearFilter && (
                <button
                  type="button"
                  onClick={onClearFilter}
                  className="text-[#FF5B22] hover:underline text-xs"
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-48 text-[#9E9EA8] gap-1.5 text-xs">
              <span>No proxy pools found on this node</span>
            </div>
          )
        ) : (
          pools.map((pool) => {
            const isTesting = Boolean(testingMap[pool.id]);
            const testResult = testResults[pool.id];
            const failCount = pool.failCount ?? (testResult && !testResult.ok ? 1 : 0);
            const weight = pool.weight ?? 1;

            return (
              <motion.div
                key={pool.id}
                initial={{ opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.15 }}
                whileHover={{ y: -1 }}
                className="grid grid-cols-12 gap-2 px-4 py-3 items-center hover:bg-white/[0.03] transition-colors"
              >
                {/* Column 1: Pool & Target */}
                <div className="col-span-5 min-w-0 pr-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-zinc-100 truncate">
                      {pool.name || "Proxy Pool"}
                    </span>
                    {renderStatusBadge(pool)}
                  </div>
                  <span
                    className="text-[11px] text-[#9E9EA8] font-mono truncate block mt-0.5"
                    title={pool.proxyUrl}
                  >
                    {pool.proxyUrl}
                  </span>
                </div>

                {/* Column 2: Latency */}
                <div className="col-span-2 flex items-center text-[11px] font-mono">
                  {(() => {
                    const lat = resolvePoolLatencyDisplay(pool, isTesting, testResult);
                    if (lat.state === "testing") {
                      return (
                        <span className="text-[#FF5B22] flex items-center gap-1 font-semibold animate-pulse">
                          <FlaskConical className="size-3 animate-spin" />
                          Pinging...
                        </span>
                      );
                    }
                    if (lat.state === "ok") {
                      return (
                        <span className="text-[#10B981] flex items-center gap-1 font-semibold">
                          <CheckCircle2 className="size-3" />
                          {lat.label}
                        </span>
                      );
                    }
                    if (lat.state === "failed") {
                      return (
                        <span
                          className="text-rose-400 flex items-center gap-1 font-medium"
                          title={lat.error || "Ping failed"}
                        >
                          <XCircle className="size-3" />
                          {lat.label}
                        </span>
                      );
                    }
                    if (lat.state === "recorded") {
                      return (
                        <span className="text-zinc-300 flex items-center gap-1">{lat.label}</span>
                      );
                    }
                    return <span className="text-zinc-600">—</span>;
                  })()}
                </div>

                {/* Column 3: Fail Count & Weight */}
                <div className="col-span-2 flex items-center gap-2 text-[11px] font-mono">
                  <span
                    className={failCount > 0 ? "text-rose-400 font-medium" : "text-zinc-400"}
                    title="Fail count"
                  >
                    {failCount}f
                  </span>
                  <span className="text-zinc-600">/</span>
                  <span className="text-zinc-400" title="Routing weight">
                    {weight}w
                  </span>
                </div>

                {/* Column 4: Actions */}
                <div className="col-span-3 flex items-center justify-end gap-1.5 shrink-0">
                  {/* Quick Assign Button */}
                  <Button
                    size="sm"
                    disabled={!selectedConnectionId}
                    onClick={() => onAssignToSelected(pool.id)}
                    title={
                      selectedConnectionId
                        ? "Bind this proxy to selected account"
                        : "Select an account on the left first"
                    }
                    className={`h-7 px-2.5 text-[11px] font-semibold gap-1 transition-all ${
                      selectedConnectionId
                        ? "bg-[#FF5B22] hover:bg-[#FF3D00] text-white shadow-sm shadow-[#FF5B22]/25 border-0"
                        : "opacity-40 text-zinc-500 bg-transparent border border-[#23232C]"
                    }`}
                  >
                    <LinkIcon className="size-3" />
                    Bind
                  </Button>

                  {/* Test Ping Latency */}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isTesting}
                    onClick={() => onTestPool(pool.id)}
                    title="Test connection latency"
                    aria-label={`Test connection latency for ${pool.name || pool.proxyUrl}`}
                    className="size-7 p-0 text-zinc-400 hover:text-[#FF5B22] hover:bg-[#FF5B22]/10 cursor-pointer"
                  >
                    <FlaskConical
                      className={`size-3.5 ${isTesting ? "animate-spin text-[#FF5B22]" : ""}`}
                    />
                  </Button>

                  {/* On/Off Switch */}
                  <Switch
                    checked={pool.isActive ?? false}
                    onCheckedChange={(checked) => onToggleActive(pool.id, checked)}
                    aria-label={`Toggle active state for proxy pool ${pool.name || pool.proxyUrl}`}
                    className="data-[state=checked]:bg-[#10B981] data-[state=unchecked]:bg-[#23232C]"
                  />

                  {/* Delete Button */}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onDeletePool(pool.id)}
                    title="Delete pool"
                    aria-label={`Delete proxy pool ${pool.name || pool.proxyUrl}`}
                    className="size-7 p-0 text-zinc-400 hover:text-[#EF4444] hover:bg-[#EF4444]/10 cursor-pointer"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </motion.div>
            );
          })
        )}
      </div>
    </div>
  );
}
