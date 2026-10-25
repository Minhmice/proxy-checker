"use client";

import React from "react";
import { Check, Mail, Unlink, AlertCircle, HelpCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { motion } from "motion/react";
export interface AntigravityConnection {
  id: string;
  name?: string;
  email?: string;
  isActive?: boolean;
  providerSpecificData?: {
    proxyPoolId?: string;
    [key: string]: unknown;
  };
}

interface AccountBindingsTableProps {
  connections: AntigravityConnection[];
  selectedConnectionId: string | null;
  onSelectConnection: (id: string) => void;
  onToggleActive: (id: string, current: boolean) => void;
  onUnbind: (id: string) => void;
  poolMap: Record<string, { name: string; url: string; index?: number }>;
  loading?: boolean;
}

function FieldInfo({ content }: { content: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="button"
          tabIndex={0}
          aria-label="More information"
          className="inline-flex items-center text-[#9E9EA8]/70 hover:text-[#FF5B22] transition-colors cursor-help p-0.5 ml-1"
        >
          <HelpCircle className="size-3" />
        </span>
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

export function AccountBindingsTable({
  connections,
  selectedConnectionId,
  onSelectConnection,
  onToggleActive,
  onUnbind,
  poolMap,
  loading,
}: AccountBindingsTableProps) {
  return (
    <div className="flex flex-col h-full rounded-2xl border border-[#23232C] bg-[#131318] shadow-sm overflow-hidden">
      {/* Top Header */}
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-[#23232C] bg-[#0F0F13]">
        <div className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-lg bg-[#FF5B22]/15 text-[#FF5B22] border border-[#FF5B22]/30">
            <Mail className="size-3.5" />
          </span>
          <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-100">
            Antigravity Accounts ({connections.length})
          </h3>
        </div>
        <span className="text-[11px] text-[#9E9EA8]">Click row to select for binding</span>
      </div>

      {/* Table Column Headers */}
      <div className="grid grid-cols-12 gap-2 px-4 py-2.5 bg-[#0F0F13] text-[#9E9EA8] font-semibold text-xs border-b border-[#23232C] items-center">
        <div className="col-span-6 flex items-center">
          <span>Identity / Account</span>
        </div>
        <div className="col-span-3 flex items-center">
          <span>Assigned Pool</span>
          <FieldInfo content="Dedicated 9Router upstream proxy pool mapped to this Antigravity session." />
        </div>
        <div className="col-span-3 flex items-center justify-end">
          <span>Controls</span>
          <FieldInfo content="Quick switch activation toggle and proxy unbind control." />
        </div>
      </div>

      {/* Table Body */}
      <div className="flex-1 overflow-y-auto divide-y divide-[#23232C]/40 min-h-[450px] max-h-[620px]">
        {loading ? (
          <div className="flex items-center justify-center h-48 text-xs text-[#9E9EA8]">
            Loading connections...
          </div>
        ) : connections.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-[#9E9EA8] gap-1.5 text-xs">
            <AlertCircle className="size-5 text-zinc-600" />
            <span>No Antigravity accounts configured on this node</span>
          </div>
        ) : (
          connections.map((conn) => {
            const isSelected = selectedConnectionId === conn.id;
            const poolId = conn.providerSpecificData?.proxyPoolId;
            const boundPool = poolId ? poolMap[poolId] : null;
            const isActive = conn.isActive !== false;

            return (
              <motion.div
                key={conn.id}
                initial={{ opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.15 }}
                whileHover={{ y: -1 }}
                onClick={() => onSelectConnection(conn.id)}
                className={`grid grid-cols-12 gap-2 px-4 py-3 items-center cursor-pointer transition-colors ${
                  isSelected
                    ? "bg-[#FF5B22]/10 border-l-2 border-[#FF5B22] shadow-[inset_0_0_12px_rgba(255,91,34,0.06)]"
                    : "hover:bg-white/[0.03]"
                }`}
              >
                {/* Column 1: Identity & Status Indicator */}
                <div className="col-span-6 flex items-center gap-2.5 min-w-0 pr-2">
                  <div
                    className={`size-2 rounded-full shrink-0 ${
                      isActive ? "bg-[#10B981] shadow-[0_0_6px_#10B981]" : "bg-zinc-600"
                    }`}
                  />
                  <div className="min-w-0">
                    <span className="text-xs font-semibold text-zinc-100 block truncate">
                      {conn.email || conn.name || conn.id}
                    </span>
                    <span className="text-[10px] text-[#9E9EA8] font-mono truncate block">
                      ID: {conn.id.slice(0, 14)}...
                    </span>
                  </div>
                </div>

                {/* Column 2: Bound Pool */}
                <div className="col-span-3 min-w-0 flex items-center">
                  {boundPool ? (
                    <Badge
                      variant="outline"
                      className="text-[10px] px-1.5 py-0.5 border-[#10B981]/30 text-[#10B981] bg-[#10B981]/15 font-mono truncate max-w-[170px]"
                      title={boundPool.url}
                    >
                      {boundPool.name || `Proxy #${boundPool.index ?? "Pool"}`}
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="text-[10px] px-1.5 py-0.5 border-[#23232C] text-[#9E9EA8] bg-[#1C1C24]"
                    >
                      Direct (No Proxy)
                    </Badge>
                  )}
                </div>

                {/* Column 3: Controls */}
                <div
                  className="col-span-3 flex items-center justify-end gap-2 shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  {boundPool && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onUnbind(conn.id)}
                      title="Unbind proxy pool"
                      className="size-7 p-0 text-[#9E9EA8] hover:text-[#EF4444] hover:bg-[#EF4444]/10"
                    >
                      <Unlink className="size-3.5" />
                    </Button>
                  )}

                  <Switch
                    checked={isActive}
                    onCheckedChange={(checked) => onToggleActive(conn.id, checked)}
                    className="data-[state=checked]:bg-[#10B981] data-[state=unchecked]:bg-[#23232C]"
                  />

                  {isSelected ? (
                    <span className="flex size-5 items-center justify-center rounded-full bg-[#FF5B22] text-white shadow-sm shadow-[#FF5B22]/30">
                      <Check className="size-3 stroke-[3]" />
                    </span>
                  ) : (
                    <span className="size-5" />
                  )}
                </div>
              </motion.div>
            );
          })
        )}
      </div>
    </div>
  );
}
