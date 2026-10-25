"use client";

import { useEffect, useState } from "react";
import { Download, Loader2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export interface ProxyExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedCount: number;
  totalFiltered: number;
  onExport: (options: {
    scope: "filtered" | "selected";
    format: "txt" | "csv";
    includeCredentials: boolean;
  }) => Promise<void>;
}

export function ProxyExportDialog({
  open,
  onOpenChange,
  selectedCount,
  totalFiltered,
  onExport,
}: ProxyExportDialogProps) {
  // ponytail: ToggleGroup single-select covers txt/csv and filtered/selected without custom radio machinery. Upgrade to full presets if multi-destination export is added.
  const [scope, setScope] = useState<"filtered" | "selected">(
    selectedCount > 0 ? "selected" : "filtered",
  );
  const [format, setFormat] = useState<"txt" | "csv">("txt");
  const [includeCredentials, setIncludeCredentials] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (selectedCount === 0 && scope === "selected") {
      setScope("filtered");
    }
  }, [selectedCount, scope]);
  const handleExecuteExport = async () => {
    setExporting(true);
    try {
      await onExport({
        scope: selectedCount > 0 ? scope : "filtered",
        format,
        includeCredentials,
      });
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message || "Export failed");
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90vh] flex flex-col p-6 overflow-hidden bg-card border-border/80">
        <DialogHeader className="shrink-0">
          <DialogTitle className="text-sm font-bold font-mono flex items-center gap-2">
            <Download className="h-4 w-4 text-primary" />
            <span>Export Proxies</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Download proxies for downstream applications, curl, or router config.
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-y-auto min-h-0 space-y-4 py-2 text-xs pr-1">
          {/* Scope Selector */}
          <div className="space-y-1.5">
            <label
              id="export-scope-label"
              className="text-[11px] font-semibold text-muted-foreground uppercase"
            >
              Export Scope
            </label>
            <ToggleGroup
              type="single"
              value={selectedCount > 0 ? scope : "filtered"}
              onValueChange={(val) => {
                if (val === "filtered" || val === "selected") {
                  setScope(val);
                }
              }}
              aria-labelledby="export-scope-label"
              className="grid grid-cols-2 gap-2 w-full"
            >
              <ToggleGroupItem
                value="filtered"
                aria-label={`Current Filters (${totalFiltered.toLocaleString()} matching)`}
                className="h-auto min-h-[44px] p-2.5 rounded-lg border text-left flex flex-col items-start justify-start transition-colors data-[state=on]:border-primary data-[state=on]:bg-primary/10 data-[state=on]:text-foreground data-[state=off]:border-border/60 data-[state=off]:bg-surface/50 data-[state=off]:text-muted-foreground hover:bg-surface cursor-pointer"
              >
                <div className="font-semibold text-xs text-foreground">Current Filters</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  All {totalFiltered.toLocaleString()} matching
                </div>
              </ToggleGroupItem>

              <ToggleGroupItem
                value="selected"
                disabled={selectedCount === 0}
                aria-label={`Selected Only (${selectedCount.toLocaleString()} selected)`}
                className="h-auto min-h-[44px] p-2.5 rounded-lg border text-left flex flex-col items-start justify-start transition-colors data-[state=on]:border-primary data-[state=on]:bg-primary/10 data-[state=on]:text-foreground data-[state=off]:border-border/60 data-[state=off]:bg-surface/50 data-[state=off]:text-muted-foreground hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-surface/20 disabled:border-border/40"
              >
                <div className="font-semibold text-xs text-foreground">Selected Only</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {selectedCount.toLocaleString()} selected
                </div>
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          {/* Format Selector */}
          <div className="space-y-1.5">
            <label
              id="export-format-label"
              className="text-[11px] font-semibold text-muted-foreground uppercase"
            >
              File Format
            </label>
            <ToggleGroup
              type="single"
              value={format}
              onValueChange={(val) => {
                if (val === "txt" || val === "csv") {
                  setFormat(val);
                }
              }}
              aria-labelledby="export-format-label"
              className="grid grid-cols-2 gap-2 w-full"
            >
              <ToggleGroupItem
                value="txt"
                aria-label="Plain Text (.txt)"
                className="h-auto min-h-[44px] p-2.5 rounded-lg border text-left flex flex-col items-start justify-start transition-colors data-[state=on]:border-primary data-[state=on]:bg-primary/10 data-[state=on]:text-foreground data-[state=off]:border-border/60 data-[state=off]:bg-surface/50 data-[state=off]:text-muted-foreground hover:bg-surface cursor-pointer"
              >
                <div className="font-semibold text-xs text-foreground font-mono">
                  Plain Text (.txt)
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  protocol://host:port lines
                </div>
              </ToggleGroupItem>

              <ToggleGroupItem
                value="csv"
                aria-label="CSV (.csv)"
                className="h-auto min-h-[44px] p-2.5 rounded-lg border text-left flex flex-col items-start justify-start transition-colors data-[state=on]:border-primary data-[state=on]:bg-primary/10 data-[state=on]:text-foreground data-[state=off]:border-border/60 data-[state=off]:bg-surface/50 data-[state=off]:text-muted-foreground hover:bg-surface cursor-pointer"
              >
                <div className="font-semibold text-xs text-foreground font-mono">CSV (.csv)</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  Structured spreadsheet rows
                </div>
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          {/* Credentials Checkbox */}
          <div className="space-y-2 pt-1 border-t border-border/40">
            <div className="flex items-start gap-2 pt-1">
              <Checkbox
                id="export-creds-toggle"
                checked={includeCredentials}
                onCheckedChange={(checked) => setIncludeCredentials(Boolean(checked))}
              />
              <div className="space-y-0.5">
                <label
                  htmlFor="export-creds-toggle"
                  className="font-medium text-xs text-foreground cursor-pointer"
                >
                  Include usernames and passwords
                </label>
                <p className="text-[11px] text-muted-foreground">
                  Credentials are off by default to prevent accidental plaintext disclosure.
                </p>
              </div>
            </div>

            {/* Privileged Credential Disclosure Warning */}
            {includeCredentials && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs space-y-1.5 animate-in fade-in duration-150">
                <div className="flex items-center gap-2 text-amber-400 font-semibold">
                  <ShieldAlert className="h-4 w-4 shrink-0" />
                  <span>Plaintext Secret Warning</span>
                </div>
                <p className="text-[11px] text-amber-300/90 leading-relaxed">
                  The exported file will contain unencrypted credentials. Anyone who obtains this
                  file can authenticate through these proxies.
                </p>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="shrink-0 gap-2 sm:gap-0 pt-2 border-t border-border/40">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            className="text-xs"
          >
            Cancel
          </Button>

          <Button
            size="sm"
            onClick={handleExecuteExport}
            disabled={exporting}
            className={`text-xs gap-1.5 cursor-pointer ${
              includeCredentials
                ? "bg-amber-600 hover:bg-amber-700 text-white"
                : "bg-primary text-primary-foreground hover:bg-primary-hover"
            }`}
          >
            {exporting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            <span>{includeCredentials ? "Export with credentials" : "Export proxies"}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
