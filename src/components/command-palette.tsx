"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  Gauge,
  HelpCircle,
  Layers,
  Loader2,
  Network,
  Server,
  Settings,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { fetchPools } from "@/lib/api";
import type { PoolRecord } from "@/lib/types";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const router = useRouter();
  const [pools, setPools] = useState<PoolRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wasOpen = useRef(false);
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    if (wasOpen.current && !open) {
      const timer = setTimeout(() => {
        document.querySelector<HTMLElement>("[data-command-trigger]")?.focus();
      }, 0);
      wasOpen.current = false;
      return () => clearTimeout(timer);
    }
    wasOpen.current = open;
  }, [open]);

  const loadPools = useCallback(async (controller: AbortController) => {
    request.current?.abort();
    request.current = controller;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchPools(controller.signal);
      if (!controller.signal.aborted) setPools(data ?? []);
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message.toLowerCase() : "";
      if (message.includes("password") || message.includes("401") || message.includes("unauthorized")) {
        setError("Session expired or unauthorized. Please sign in again.");
      } else {
        setError("Unable to load proxy pools. Check your session and try again.");
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (request.current === controller) request.current = null;
    }
  }, []);

  const retryLoad = useCallback(() => {
    const controller = new AbortController();
    void loadPools(controller);
  }, [loadPools]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void loadPools(controller);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [open, loadPools]);

  const handleSelect = (pool: PoolRecord) => {
    onClose();
    router.push(`/proxies?q=${encodeURIComponent(pool.name)}`);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
      title="Search proxy pools"
      description="Quickly jump to a proxy pool by name, IP, URL, or tier"
    >
      <CommandInput placeholder="Search proxy pools by name, IP, URL, tier..." />
      <CommandList className="max-h-[360px] overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin text-primary" />
            <span>Loading proxy pools...</span>
          </div>
        )}
        {!loading && error && (
          <div className="flex flex-col items-center justify-center gap-2 py-8 px-4 text-center">
            <AlertCircle className="size-5 text-destructive" />
            <p className="text-xs text-destructive font-medium">{error}</p>
            <div className="flex items-center gap-2 mt-1">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={retryLoad}
              >
                Retry
              </Button>
              <Button
                asChild
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground"
                onClick={onClose}
              >
                <a href="/auth">Sign in</a>
              </Button>
            </div>
          </div>
        )}
        {!loading && !error && pools.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-1.5 py-8 px-4 text-center text-xs text-muted-foreground">
            <Server className="size-5 opacity-40 mb-1" />
            <p className="font-medium text-foreground">No proxy pools configured</p>
            <p className="text-muted-foreground/80">
              No router pools found for this session.
            </p>
          </div>
        )}
        {!loading && !error && pools.length > 0 && (
          <>
            <CommandEmpty>No matching pools or commands found.</CommandEmpty>
            <CommandGroup heading="Quick Navigation">
              <CommandItem
                value="overview dashboard traffic home"
                onSelect={() => {
                  onClose();
                  router.push("/");
                }}
                className="flex items-center gap-2.5 px-3 py-2 cursor-pointer"
              >
                <Activity className="size-4 shrink-0 text-primary" />
                <span className="font-medium text-sm text-foreground">Overview & Live Traffic</span>
              </CommandItem>
              <CommandItem
                value="proxies fleet list table"
                onSelect={() => {
                  onClose();
                  router.push("/proxies");
                }}
                className="flex items-center gap-2.5 px-3 py-2 cursor-pointer"
              >
                <Layers className="size-4 shrink-0 text-accent-violet" />
                <span className="font-medium text-sm text-foreground">Proxy Fleet & Tables</span>
              </CommandItem>
              <CommandItem
                value="nodes workers wireguard fleet mesh"
                onSelect={() => {
                  onClose();
                  router.push("/nodes");
                }}
                className="flex items-center gap-2.5 px-3 py-2 cursor-pointer"
              >
                <Network className="size-4 shrink-0 text-emerald-400" />
                <span className="font-medium text-sm text-foreground">Worker Nodes & Mesh</span>
              </CommandItem>
              <CommandItem
                value="monitoring telemetry diagnostics health"
                onSelect={() => {
                  onClose();
                  router.push("/monitoring");
                }}
                className="flex items-center gap-2.5 px-3 py-2 cursor-pointer"
              >
                <Gauge className="size-4 shrink-0 text-accent-teal" />
                <span className="font-medium text-sm text-foreground">Fleet Telemetry & Diagnostics</span>
              </CommandItem>
              <CommandItem
                value="settings configuration runtime"
                onSelect={() => {
                  onClose();
                  router.push("/settings");
                }}
                className="flex items-center gap-2.5 px-3 py-2 cursor-pointer"
              >
                <Settings className="size-4 shrink-0 text-muted-foreground" />
                <span className="font-medium text-sm text-foreground">System Settings</span>
              </CommandItem>
              <CommandItem
                value="help reference runbook documentation"
                onSelect={() => {
                  onClose();
                  router.push("/help");
                }}
                className="flex items-center gap-2.5 px-3 py-2 cursor-pointer"
              >
                <HelpCircle className="size-4 shrink-0 text-muted-foreground" />
                <span className="font-medium text-sm text-foreground">Operations Reference & Guides</span>
              </CommandItem>
            </CommandGroup>
            <CommandGroup heading={`Proxy Pools (${pools.length})`}>
              {pools.map((pool) => (
                <CommandItem
                  key={pool.localId ?? pool.name}
                  value={`${pool.name} ${pool.exit_ip ?? ""} ${pool.proxyUrl ?? ""} ${pool.tier ?? ""}`}
                  onSelect={() => handleSelect(pool)}
                  className="flex items-center justify-between gap-3 px-3 py-2 cursor-pointer"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Server className="size-4 shrink-0 text-muted-foreground" />
                    <span className="font-medium text-sm text-foreground truncate">
                      {pool.name}
                    </span>
                    {pool.tier && (
                      <Badge
                        variant="outline"
                        className="text-[10px] uppercase font-mono px-1.5 py-0 h-4"
                      >
                        {pool.tier}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {pool.exit_ip && (
                      <span className="font-mono text-xs text-muted-foreground">
                        {pool.exit_ip}
                      </span>
                    )}
                    <span className="text-[11px] text-muted-foreground/70 hidden sm:inline">
                      Jump &rarr;
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}

export function useCommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return { open, setOpen, close: () => setOpen(false) };
}
