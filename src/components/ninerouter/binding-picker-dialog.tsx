"use client";

import React, { useState, useMemo } from "react";
import { Search, Check, AlertTriangle, Link2, Loader2, Globe } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AntigravityConnection } from "./account-bindings-table";
import type { ProxyPoolItem } from "./proxy-pools-table";
import { resolvePoolAssignmentState } from "@/lib/proxy-binding-state";

export interface BindingPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: AntigravityConnection | null;
  pools: ProxyPoolItem[];
  currentPoolId?: string | null;
  busyPoolId?: string | null;
  onBind: (poolId: string) => Promise<void> | void;
}

export function BindingPickerDialog({
  open,
  onOpenChange,
  account,
  pools,
  currentPoolId,
  busyPoolId,
  onBind,
}: BindingPickerDialogProps) {
  const [filterQuery, setFilterQuery] = useState("");

  const filteredPools = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    if (!q) return pools;
    return pools.filter(
      (p) =>
        (p.name && p.name.toLowerCase().includes(q)) ||
        (p.proxyUrl && p.proxyUrl.toLowerCase().includes(q)) ||
        p.id.toLowerCase().includes(q),
    );
  }, [pools, filterQuery]);

  if (!account) return null;

  const targetAccountLabel = account.email || account.name || account.id;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl bg-[#131318] border-[#23232C] text-zinc-100 p-6 rounded-2xl shadow-2xl">
        <DialogHeader className="space-y-1.5 pb-2 border-b border-[#23232C]">
          <DialogTitle className="text-base font-bold text-zinc-100 flex items-center gap-2">
            <span className="flex size-6 items-center justify-center rounded-md bg-[#FF5B22]/20 text-[#FF5B22]">
              <Link2 className="size-3.5" />
            </span>
            <span>Assign Proxy Pool</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-[#9E9EA8]">
            Select an upstream 9Router proxy pool to dedicate to{" "}
            <strong className="text-zinc-200">{targetAccountLabel}</strong>.
          </DialogDescription>
        </DialogHeader>

        {/* Filter / Search within Dialog */}
        <div className="relative mt-2">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-[#9E9EA8]" />
          <Input
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder="Search candidate pools by name or URL..."
            className="h-8 pl-8 text-xs bg-[#1C1C24] border-[#23232C] text-zinc-100 placeholder:text-[#9E9EA8] focus-visible:ring-1 focus-visible:ring-[#FF5B22] rounded-lg"
          />
        </div>

        {/* Candidate Pools List */}
        <div className="max-h-[380px] overflow-y-auto divide-y divide-[#23232C]/50 border border-[#23232C] rounded-xl bg-[#0F0F13] my-2">
          {filteredPools.length === 0 ? (
            <div className="py-12 text-center text-xs text-[#9E9EA8]">
              {pools.length === 0
                ? "No proxy pools found on this node."
                : "No proxy pools match your search."}
            </div>
          ) : (
            filteredPools.map((pool) => {
              const state = resolvePoolAssignmentState(pool, currentPoolId);
              const isBusy = busyPoolId === pool.id;

              return (
                <div
                  key={pool.id}
                  className={`p-3 flex items-center justify-between gap-3 transition-colors ${
                    state.isCurrent ? "bg-[#10B981]/5" : "hover:bg-white/[0.03]"
                  }`}
                >
                  {/* Pool Identity */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold text-zinc-100 truncate">
                        {pool.name || "Proxy Pool"}
                      </span>
                      {state.isCurrent ? (
                        <Badge
                          variant="outline"
                          className="text-[10px] px-1.5 py-0 border-[#10B981]/40 bg-[#10B981]/15 text-[#10B981] font-mono flex items-center gap-1"
                        >
                          <Check className="size-2.5" />
                          Current
                        </Badge>
                      ) : !pool.isActive ? (
                        <Badge
                          variant="outline"
                          className="text-[10px] px-1.5 py-0 border-zinc-700 bg-zinc-800 text-zinc-400 font-mono"
                        >
                          Inactive
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="text-[10px] px-1.5 py-0 border-[#10B981]/30 bg-[#10B981]/10 text-[#10B981] font-mono"
                        >
                          Active
                        </Badge>
                      )}
                    </div>
                    <span
                      className="text-[11px] text-[#9E9EA8] font-mono truncate block mt-0.5"
                      title={pool.proxyUrl}
                    >
                      {pool.proxyUrl}
                    </span>
                  </div>

                  {/* Latency */}
                  <div className="text-[11px] font-mono text-zinc-400 shrink-0 text-right">
                    {pool.latencyMs ? `${pool.latencyMs}ms` : "—"}
                  </div>

                  {/* Action Button */}
                  <div className="shrink-0">
                    {state.isCurrent ? (
                      <Button
                        size="sm"
                        disabled
                        className="h-7 px-2.5 text-xs opacity-50 bg-transparent border border-[#23232C] text-zinc-500"
                      >
                        Bound
                      </Button>
                    ) : state.isInactive ? (
                      <Button
                        size="sm"
                        disabled={Boolean(busyPoolId)}
                        onClick={async () => {
                          await onBind(pool.id);
                          onOpenChange(false);
                        }}
                        className="h-7 px-2.5 text-xs border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 gap-1 cursor-pointer"
                      >
                        {isBusy ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <AlertTriangle className="size-3" />
                        )}
                        <span>Bind Inactive</span>
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        disabled={Boolean(busyPoolId)}
                        onClick={async () => {
                          await onBind(pool.id);
                          onOpenChange(false);
                        }}
                        className="h-7 px-3 text-xs bg-[#FF5B22] hover:bg-[#FF3D00] text-white shadow-sm shadow-[#FF5B22]/25 border-0 gap-1 font-semibold cursor-pointer"
                      >
                        {isBusy ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <Globe className="size-3" />
                        )}
                        <span>Assign</span>
                      </Button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <DialogFooter className="pt-2 border-t border-[#23232C] flex items-center justify-between sm:justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            className="h-8 text-xs text-[#9E9EA8] hover:text-zinc-100"
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
