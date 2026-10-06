"use client";

import * as React from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Copy,
  ExternalLink,
  Pin,
  PinOff,
  Play,
  SlidersHorizontal,
  Trash2,
  Unlink,
  UploadCloud,
} from "lucide-react";
import { toast } from "sonner";
import type { UnifiedProxyItem } from "@/lib/types";

export interface ProxyContextMenuProps {
  proxy: UnifiedProxyItem;
  children: React.ReactNode;
  onTest?: (proxy: UnifiedProxyItem) => void;
  onTogglePin?: (proxy: UnifiedProxyItem) => void;
  onUnlinkRouter?: (proxy: UnifiedProxyItem) => void;
  onPushRouter?: (proxy: UnifiedProxyItem) => void;
  onHardDelete?: (proxy: UnifiedProxyItem) => void;
  onOpenDetail?: (proxy: UnifiedProxyItem) => void;
}

export function ProxyContextMenu({
  proxy,
  children,
  onTest,
  onTogglePin,
  onUnlinkRouter,
  onPushRouter,
  onHardDelete,
  onOpenDetail,
}: ProxyContextMenuProps) {
  const endpoint = `${proxy.host}:${proxy.port}`;
  const fullUrl = `${proxy.protocol}://${endpoint}`;

  const handleCopyEndpoint = (e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(endpoint);
    toast.success(`Copied endpoint: ${endpoint}`);
  };

  const handleCopyUrl = (e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(fullUrl);
    toast.success(`Copied proxy URL: ${fullUrl}`);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56 text-xs">
        {/* 9Router Actions */}
        <ContextMenuItem
          onClick={() => onTest?.(proxy)}
          className="gap-2 cursor-pointer"
        >
          <Play className="h-3.5 w-3.5 text-primary" />
          <span>Kiểm tra sức khỏe (9Router)</span>
        </ContextMenuItem>

        {proxy.routerState === "removed" ? (
          <ContextMenuItem
            onClick={() => onPushRouter?.(proxy)}
            className="gap-2 cursor-pointer text-emerald-400"
          >
            <UploadCloud className="h-3.5 w-3.5" />
            <span>Đẩy lên 9Router</span>
          </ContextMenuItem>
        ) : (
          <ContextMenuItem
            onClick={() => onUnlinkRouter?.(proxy)}
            className="gap-2 cursor-pointer text-amber-400"
          >
            <Unlink className="h-3.5 w-3.5" />
            <span>Gỡ khỏi 9Router (giữ trong app)</span>
          </ContextMenuItem>
        )}

        <ContextMenuSeparator />

        {/* Protection / Pin */}
        <ContextMenuItem
          onClick={() => onTogglePin?.(proxy)}
          className="gap-2 cursor-pointer"
        >
          {proxy.isPinned ? (
            <>
              <PinOff className="h-3.5 w-3.5 text-muted-foreground" />
              <span>Bỏ ghim bảo vệ</span>
            </>
          ) : (
            <>
              <Pin className="h-3.5 w-3.5 text-amber-400" />
              <span>Ghim bảo vệ (Protected)</span>
            </>
          )}
        </ContextMenuItem>

        {/* Copy Tools */}
        <ContextMenuItem
          onClick={handleCopyEndpoint}
          className="gap-2 cursor-pointer"
        >
          <Copy className="h-3.5 w-3.5" />
          <span>Sao chép IP:Port</span>
        </ContextMenuItem>
        <ContextMenuItem onClick={handleCopyUrl} className="gap-2 cursor-pointer">
          <ExternalLink className="h-3.5 w-3.5" />
          <span>Sao chép Proxy URL</span>
        </ContextMenuItem>

        {/* Inspect Details */}
        <ContextMenuItem
          onClick={() => onOpenDetail?.(proxy)}
          className="gap-2 cursor-pointer"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          <span>Xem chi tiết</span>
        </ContextMenuItem>

        <ContextMenuSeparator />

        {/* Hard Delete */}
        <ContextMenuItem
          onClick={() => onHardDelete?.(proxy)}
          className="gap-2 cursor-pointer text-rose-400 focus:text-rose-400 focus:bg-rose-500/10"
        >
          <Trash2 className="h-3.5 w-3.5" />
          <span>Xóa vĩnh viễn (Hard delete)</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
