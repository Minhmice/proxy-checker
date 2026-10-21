"use client";

import type { ReactNode } from "react";
import { Copy, ExternalLink, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { FleetNodeRecord } from "@/proxyfleet/types";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

export function NodeContextMenu({
  node,
  children,
  onManage,
  onAddEndpoint,
  enrollCommand,
  onDelete,
}: {
  node: FleetNodeRecord;
  children: ReactNode;
  onManage: () => void;
  onAddEndpoint: () => void;
  enrollCommand?: string;
  onDelete?: () => void;
}) {
  async function copy(label: string, value: string | null) {
    if (!value) {
      toast.error(`${label} unavailable`);
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch {
      toast.error(`Could not copy ${label.toLowerCase()}`);
    }
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onSelect={onManage}>
          <ExternalLink className="size-4 mr-2" /> Manage node
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void copy("Node ID", node.id)}>
          <Copy className="size-4 mr-2" /> Copy node ID
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void copy("WireGuard IP", node.wireguard_ip)}>
          <Copy className="size-4 mr-2" /> Copy WireGuard IP
        </ContextMenuItem>
        {node.public_ip && (
          <ContextMenuItem onSelect={() => void copy("Public IP", node.public_ip)}>
            <Copy className="size-4 mr-2" /> Copy public IP
          </ContextMenuItem>
        )}
        {enrollCommand && (
          <ContextMenuItem onSelect={() => void copy("Enroll command", enrollCommand)}>
            <Copy className="size-4 mr-2" /> Copy enroll command
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onAddEndpoint}>
          <Plus className="size-4 mr-2" /> Add endpoint
        </ContextMenuItem>
        {node.role !== "controller-worker" && node.id !== "controller-node-master" && onDelete && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={onDelete} className="text-rose-400 focus:text-rose-300">
              <Trash2 className="size-4 mr-2" /> Delete node
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
