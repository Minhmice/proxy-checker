"use client";

import React from "react";
import { Link2, X, Server, ShieldCheck, ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AntigravityConnection } from "./account-bindings-table";
import { resolveBindingContext } from "@/lib/proxy-binding-state";

export interface BindingContextBarProps {
  account: AntigravityConnection | null;
  nodeName: string;
  poolMap: Record<string, { name: string; url: string; index?: number }>;
  onChangePool: () => void;
  onDeselect: () => void;
  isBusy?: boolean;
}

export function BindingContextBar({
  account,
  nodeName,
  poolMap,
  onChangePool,
  onDeselect,
  isBusy = false,
}: BindingContextBarProps) {
  if (!account) return null;

  const ctx = resolveBindingContext(account, poolMap, nodeName);
  if (!ctx) return null;

  return (
    <div
      role="region"
      aria-label="Active Account Binding Session"
      className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-xl border border-[#FF5B22]/35 bg-[#171214] shadow-[0_0_20px_rgba(255,91,34,0.1)] transition-all"
    >
      {/* Account & Target Info */}
      <div className="flex items-center gap-2.5 flex-wrap min-w-0">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[#FF5B22]/20 text-[#FF5B22] border border-[#FF5B22]/40">
          <ShieldCheck className="size-4" />
        </div>

        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-bold text-zinc-100 truncate max-w-[200px] sm:max-w-[280px]">
              {ctx.accountLabel}
            </span>
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0 border-[#23232C] bg-[#1C1C24] text-[#9E9EA8] font-mono flex items-center gap-1"
            >
              <Server className="size-2.5" />
              {ctx.nodeName}
            </Badge>
          </div>
          <span className="text-[10px] text-[#9E9EA8] font-mono truncate">{ctx.accountSub}</span>
        </div>

        <ArrowRight className="size-3.5 text-[#9E9EA8]/60 shrink-0 hidden sm:block" />

        {/* Bound Proxy Information */}
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-[#9E9EA8]">Assigned:</span>
          {ctx.isBound ? (
            <Badge
              variant="outline"
              className="text-[11px] px-2 py-0.5 border-[#10B981]/40 bg-[#10B981]/15 text-[#10B981] font-mono font-semibold"
            >
              {ctx.poolName}
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="text-[11px] px-2 py-0.5 border-[#23232C] bg-[#1C1C24] text-[#9E9EA8] font-mono"
            >
              Direct (No Proxy)
            </Badge>
          )}
        </div>
      </div>

      {/* Action Controls */}
      <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
        <Button
          size="sm"
          onClick={onChangePool}
          disabled={isBusy}
          className="h-7 px-3 text-xs font-semibold bg-[#FF5B22] hover:bg-[#FF3D00] text-white shadow-sm shadow-[#FF5B22]/30 border-0 gap-1.5 cursor-pointer"
        >
          <Link2 className="size-3" />
          <span>Change Proxy</span>
        </Button>

        <Button
          size="sm"
          variant="ghost"
          onClick={onDeselect}
          disabled={isBusy}
          className="h-7 px-2 text-xs text-[#9E9EA8] hover:text-zinc-100 hover:bg-white/[0.06] cursor-pointer"
          title="Deselect account"
          aria-label="Deselect account"
        >
          <X className="size-3.5" />
          <span className="hidden sm:inline">Deselect</span>
        </Button>
      </div>
    </div>
  );
}
