"use client";

import type { ReactNode } from "react";
import { Copy, ExternalLink, Eye, Loader2, MoreHorizontal, Power, PowerOff } from "lucide-react";
import type { FleetProxyEndpointRecord } from "@/proxyfleet/types";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface EndpointMenuProps {
  endpoint: FleetProxyEndpointRecord;
  onReveal: () => void;
  onCopyUrl: () => void;
  onJumpToNode: () => void;
  onToggle: () => void;
  isRevealing?: boolean;
}

export function EndpointContextMenu({
  endpoint,
  children,
  onReveal,
  onCopyUrl,
  onJumpToNode,
  onToggle,
  isRevealing,
}: EndpointMenuProps & { children: ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onSelect={onReveal} disabled={isRevealing}>
          {isRevealing ? <Loader2 className="size-4 animate-spin mr-2" /> : <Eye className="size-4 mr-2" />}
          <span>Reveal credentials</span>
        </ContextMenuItem>
        <ContextMenuItem onSelect={onCopyUrl}>
          <Copy className="size-4 mr-2" />
          <span>Copy proxy URL</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onJumpToNode}>
          <ExternalLink className="size-4 mr-2" />
          <span>Go to node</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onToggle}>
          {endpoint.enabled ? <PowerOff className="size-4 mr-2 text-destructive" /> : <Power className="size-4 mr-2 text-emerald-500" />}
          <span>{endpoint.enabled ? "Disable endpoint" : "Enable endpoint"}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ponytail: unified dropdown menu for mobile touch targets without requiring desktop right-click context menu.
export function EndpointActionsDropdown({
  endpoint,
  onReveal,
  onCopyUrl,
  onJumpToNode,
  onToggle,
  isRevealing = false,
  align = "end",
}: EndpointMenuProps & { align?: "start" | "end" | "center" }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-9 sm:size-8 min-h-[44px] min-w-[44px] sm:min-h-[32px] sm:min-w-[32px] text-muted-foreground hover:text-foreground"
          aria-label={`Actions for endpoint ${endpoint.listen_ip}:${endpoint.listen_port}`}
        >
          {isRevealing ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <MoreHorizontal className="size-4" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-56">
        <DropdownMenuItem onSelect={onReveal} disabled={isRevealing}>
          {isRevealing ? <Loader2 className="size-4 animate-spin mr-2" /> : <Eye className="size-4 mr-2" />}
          <span>Reveal credentials</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onCopyUrl}>
          <Copy className="size-4 mr-2" />
          <span>Copy proxy URL</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onJumpToNode}>
          <ExternalLink className="size-4 mr-2" />
          <span>Go to node</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onToggle}>
          {endpoint.enabled ? (
            <>
              <PowerOff className="size-4 mr-2 text-destructive" />
              <span>Disable endpoint</span>
            </>
          ) : (
            <>
              <Power className="size-4 mr-2 text-emerald-500" />
              <span>Enable endpoint</span>
            </>
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
