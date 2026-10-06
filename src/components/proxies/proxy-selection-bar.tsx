"use client";

import { CheckSquare, Download, Pin, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface ProxySelectionBarProps {
  selectedCount: number;
  totalMatching: number;
  selectAllMatching: boolean;
  onSelectAllMatchingToggle: (select: boolean) => void;
  onPinSelected?: () => void;
  onDeleteSelected?: () => void;
  onExportSelected: () => void;
  onClearSelection: () => void;
}

export function ProxySelectionBar({
  selectedCount,
  totalMatching,
  selectAllMatching,
  onSelectAllMatchingToggle,
  onPinSelected,
  onDeleteSelected,
  onExportSelected,
  onClearSelection,
}: ProxySelectionBarProps) {
  if (selectedCount === 0) return null;

  return (
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 p-3 rounded-lg border border-primary/40 bg-primary/10 text-foreground animate-in fade-in duration-150">
      <div className="flex items-center gap-2.5 text-xs font-medium">
        <CheckSquare className="h-4 w-4 text-primary shrink-0" aria-hidden="true" />
        <span>
          <strong className="font-semibold text-primary">{selectedCount.toLocaleString()}</strong> proxy
          {selectedCount > 1 ? "ies" : ""} selected
        </span>

        {totalMatching > selectedCount && !selectAllMatching && (
          <button
            type="button"
            onClick={() => onSelectAllMatchingToggle(true)}
            className="text-xs text-primary underline hover:text-primary-hover font-semibold ml-2 cursor-pointer"
          >
            Select all {totalMatching.toLocaleString()} matching proxies
          </button>
        )}

        {selectAllMatching && (
          <span className="text-xs text-muted-foreground ml-2">
            (All {totalMatching.toLocaleString()} matching proxies targeted)
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {onPinSelected && (
          <Button
            variant="outline"
            size="sm"
            onClick={onPinSelected}
            className="h-8 text-xs gap-1.5 border-border/80 bg-surface hover:bg-surface-raised cursor-pointer text-amber-400"
            aria-label="Pin selected proxies"
          >
            <Pin className="h-3 w-3 fill-current" />
            <span>Ghim đã chọn</span>
          </Button>
        )}

        {onDeleteSelected && (
          <Button
            variant="outline"
            size="sm"
            onClick={onDeleteSelected}
            className="h-8 text-xs gap-1.5 border-rose-500/40 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 cursor-pointer"
            aria-label="Delete selected proxies"
          >
            <Trash2 className="h-3 w-3" />
            <span>Xóa đã chọn</span>
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={onExportSelected}
          className="h-8 text-xs gap-1.5 border-border/80 bg-surface hover:bg-surface-raised cursor-pointer"
          aria-label="Export selected proxies"
        >
          <Download className="h-3 w-3" />
          <span>Export selected</span>
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={onClearSelection}
          className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground cursor-pointer"
          aria-label="Clear proxy selection"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
