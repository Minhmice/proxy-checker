"use client";

import { Download, Loader2, Plus, RotateCcw, Search, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ProxyWorkspaceQuery } from "@/lib/proxy-url-state";
import { cn } from "@/lib/utils";

export interface ProxyToolbarProps {
  query: ProxyWorkspaceQuery;
  onQueryChange: (patch: Partial<ProxyWorkspaceQuery>) => void;
  onSync9Router: () => void;
  syncing: boolean;
  onOpenImport: () => void;
  onOpenExport: () => void;
  onOpenAdd: () => void;
}

export function ProxyToolbar({
  query,
  onQueryChange,
  onSync9Router,
  syncing,
  onOpenImport,
  onOpenExport,
  onOpenAdd,
}: ProxyToolbarProps) {
  const protocolLabels: Record<string, string> = {
    all: "All Protocols",
    socks5: "SOCKS5",
    http: "HTTP",
    https: "HTTPS",
    socks4: "SOCKS4",
  };

  const sortLabels: Record<string, string> = {
    health: "Sort: Health",
    latency: "Sort: Latency",
    lastChecked: "Sort: Checked time",
    endpoint: "Sort: Endpoint",
  };

  return (
    <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3">
      {/* Search & Filter Group */}
      <div className="flex flex-wrap sm:flex-nowrap flex-1 items-center gap-2 max-w-full lg:max-w-md 3xl:max-w-xl 5xl:max-w-2xl">
        <div className="relative flex-1 min-w-[160px]">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none"
            aria-hidden="true"
          />
          <Input
            value={query.q}
            onChange={(e) => onQueryChange({ q: e.target.value, page: 1 })}
            placeholder="Search host, port, exit IP, ISP..."
            className="pl-8.5 h-9 text-xs bg-surface border-border/60 focus-visible:ring-primary/40 min-w-0 w-full"
            aria-label="Search proxies"
          />
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Segmented Protocol Switcher (on wide screens) */}
          <div className="hidden 2xl:flex items-center rounded-lg bg-surface border border-border/60 p-0.5 text-xs">
            {Object.entries(protocolLabels).map(([proto, label]) => {
              const active = query.protocol === proto;
              return (
                <button
                  key={proto}
                  type="button"
                  onClick={() =>
                    onQueryChange({ protocol: proto as ProxyWorkspaceQuery["protocol"], page: 1 })
                  }
                  className={cn(
                    "px-2.5 py-1 rounded-md font-medium transition-all text-xs cursor-pointer",
                    active
                      ? "bg-primary text-primary-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label === "All Protocols" ? "All" : label}
                </button>
              );
            })}
          </div>

          {/* Protocol Selector Dropdown (mobile & compact) */}
          <div className="2xl:hidden">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 px-3 text-xs bg-surface border-border/60 text-muted-foreground hover:text-foreground shrink-0 cursor-pointer"
                >
                  {protocolLabels[query.protocol] || "Protocol"}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="bg-popover border-border/80">
                {Object.entries(protocolLabels).map(([proto, label]) => (
                  <DropdownMenuItem
                    key={proto}
                    onClick={() =>
                      onQueryChange({ protocol: proto as ProxyWorkspaceQuery["protocol"], page: 1 })
                    }
                    className="text-xs cursor-pointer"
                  >
                    {label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Sort Selector */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-9 px-3 text-xs bg-surface border-border/60 text-muted-foreground hover:text-foreground shrink-0 cursor-pointer"
              >
                {sortLabels[query.sort] || "Sort"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="bg-popover border-border/80">
              {Object.entries(sortLabels).map(([sortKey, label]) => (
                <DropdownMenuItem
                  key={sortKey}
                  onClick={() => onQueryChange({ sort: sortKey as ProxyWorkspaceQuery["sort"] })}
                  className="text-xs cursor-pointer"
                >
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Primary Actions */}
      <div className="flex flex-wrap items-center gap-2 shrink-0">
        <Button
          variant="outline"
          size="sm"
          onClick={onSync9Router}
          disabled={syncing}
          className="h-9 text-xs gap-1.5 border-border/60 bg-surface hover:bg-surface-raised cursor-pointer"
        >
          {syncing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCcw className="h-3.5 w-3.5" />
          )}
          <span>Sync 9Router</span>
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={onOpenImport}
          className="h-9 text-xs gap-1.5 border-border/60 bg-surface hover:bg-surface-raised cursor-pointer"
        >
          <Upload className="h-3.5 w-3.5" />
          <span>Import</span>
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={onOpenExport}
          className="h-9 text-xs gap-1.5 border-border/60 bg-surface hover:bg-surface-raised cursor-pointer"
        >
          <Download className="h-3.5 w-3.5" />
          <span>Export</span>
        </Button>

        <Button
          size="sm"
          onClick={onOpenAdd}
          className="h-9 text-xs gap-1.5 bg-primary text-primary-foreground hover:bg-primary-hover shadow-sm cursor-pointer"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>New proxy</span>
        </Button>
      </div>
    </div>
  );
}
