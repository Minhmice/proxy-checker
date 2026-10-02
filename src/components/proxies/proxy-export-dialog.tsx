"use client";

import { useState } from "react";
import { AlertTriangle, Download, Loader2, ShieldAlert } from "lucide-react";
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
  const [scope, setScope] = useState<"filtered" | "selected">(selectedCount > 0 ? "selected" : "filtered");
  const [format, setFormat] = useState<"txt" | "csv">("txt");
  const [includeCredentials, setIncludeCredentials] = useState(false);
  const [exporting, setExporting] = useState(false);

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
      toast.error((err as Error).message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md bg-card border-border/80">
        <DialogHeader>
          <DialogTitle className="text-sm font-bold font-mono flex items-center gap-2">
            <Download className="h-4 w-4 text-primary" />
            <span>Export Proxies</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Download proxies for downstream applications, curl, or router config.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2 text-xs">
          {/* Scope Selector */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-muted-foreground uppercase">
              Export Scope
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setScope("filtered")}
                className={`p-2.5 rounded-lg border text-left cursor-pointer transition-colors ${
                  scope === "filtered"
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border/60 bg-surface/50 text-muted-foreground hover:bg-surface"
                }`}
              >
                <div className="font-semibold text-xs text-foreground">Current Filters</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  All {totalFiltered.toLocaleString()} matching
                </div>
              </button>

              <button
                type="button"
                onClick={() => setScope("selected")}
                disabled={selectedCount === 0}
                className={`p-2.5 rounded-lg border text-left transition-colors ${
                  selectedCount === 0
                    ? "opacity-50 cursor-not-allowed border-border/40 bg-surface/20"
                    : scope === "selected"
                    ? "border-primary bg-primary/10 text-foreground cursor-pointer"
                    : "border-border/60 bg-surface/50 text-muted-foreground hover:bg-surface cursor-pointer"
                }`}
              >
                <div className="font-semibold text-xs text-foreground">Selected Only</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {selectedCount.toLocaleString()} selected
                </div>
              </button>
            </div>
          </div>

          {/* Format Selector */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-muted-foreground uppercase">
              File Format
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setFormat("txt")}
                className={`p-2.5 rounded-lg border text-left cursor-pointer transition-colors ${
                  format === "txt"
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border/60 bg-surface/50 text-muted-foreground hover:bg-surface"
                }`}
              >
                <div className="font-semibold text-xs text-foreground font-mono">Plain Text (.txt)</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">protocol://host:port lines</div>
              </button>

              <button
                type="button"
                onClick={() => setFormat("csv")}
                className={`p-2.5 rounded-lg border text-left cursor-pointer transition-colors ${
                  format === "csv"
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border/60 bg-surface/50 text-muted-foreground hover:bg-surface"
                }`}
              >
                <div className="font-semibold text-xs text-foreground font-mono">CSV (.csv)</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">Structured spreadsheet rows</div>
              </button>
            </div>
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
                  The exported file will contain unencrypted credentials. Anyone who obtains this file can authenticate through these proxies.
                </p>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} className="text-xs">
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
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            <span>{includeCredentials ? "Export with credentials" : "Export proxies"}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
