"use client";

import { useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FileText,
  Loader2,
  Play,
  RotateCcw,
  Upload,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { importIntelligenceProxies, previewIntelligenceImport } from "@/lib/proxy-intelligence-api";
import type { ProxyImportPreview, ProxyImportSummary } from "@/lib/types";

export interface ProxyImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImportSuccess: (summary: ProxyImportSummary) => void;
  onStartAudit?: (source: string) => void;
}

export function ProxyImportDialog({
  open,
  onOpenChange,
  onImportSuccess,
  onStartAudit,
}: ProxyImportDialogProps) {
  // ponytail: Simple single-text batch preview covers manual paste and text file upload. Stream/chunked parsing deferred until imports exceed 10,000 proxies.
  const [step, setStep] = useState<"input" | "preview" | "done">("input");
  const [source, setSource] = useState("imported-proxies.txt");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<ProxyImportPreview | null>(null);
  const [summary, setSummary] = useState<ProxyImportSummary | null>(null);

  const reset = () => {
    setStep("input");
    setContent("");
    setSource("imported-proxies.txt");
    setPreview(null);
    setSummary(null);
    setLoading(false);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setSource(file.name);
    setContent(text);
  };

  const handlePreview = async () => {
    if (!content.trim()) {
      toast.error("Please provide proxy list text or upload a file");
      return;
    }

    setLoading(true);
    try {
      const res = await previewIntelligenceImport({
        source,
        content,
      });
      setPreview(res);
      setStep("preview");
    } catch (err) {
      toast.error((err as Error).message || "Failed to preview import");
    } finally {
      setLoading(false);
    }
  };

  const handleCommitImport = async () => {
    if (!content.trim()) return;
    setLoading(true);
    try {
      const res = await importIntelligenceProxies({
        source,
        content,
      });
      setSummary(res);
      setStep("done");
      onImportSuccess(res);
      toast.success(`Imported ${res.inserted.toLocaleString()} proxies`);
    } catch (err) {
      toast.error((err as Error).message || "Failed to import proxies");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg max-h-[90vh] flex flex-col p-6 overflow-hidden bg-card border-border/80">
        <DialogHeader className="shrink-0">
          <DialogTitle className="text-sm font-bold font-mono flex items-center gap-2">
            <Upload className="h-4 w-4 text-primary" />
            <span>Import Proxies</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {step === "input"
              ? "Paste list or upload .txt file to preview validity before saving."
              : step === "preview"
                ? "Review parsed lines and detected protocols before committing to database."
                : "Import complete. Start an audit to verify working status."}
          </DialogDescription>
        </DialogHeader>
        {/* Step 1: Input */}
        {step === "input" && (
          <div className="overflow-y-auto min-h-0 space-y-4 py-2 text-xs pr-1">
            <div className="space-y-1.5">
              <label
                htmlFor="import-source-input"
                className="text-[11px] font-semibold text-muted-foreground uppercase"
              >
                Source Name
              </label>
              <Input
                id="import-source-input"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="e.g. residential-batch.txt"
                aria-describedby="import-source-hint"
                className="h-8 text-xs font-mono bg-surface border-border/60"
              />
              <p id="import-source-hint" className="sr-only">
                Identifier or filename for this proxy batch
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label
                  htmlFor="import-content-textarea"
                  className="text-[11px] font-semibold text-muted-foreground uppercase"
                >
                  Proxy List (host:port or protocol://user:pass@host:port)
                </label>
                <label className="text-xs text-primary hover:text-primary-hover cursor-pointer underline flex items-center gap-1">
                  <FileText className="h-3 w-3" />
                  <span>Upload .txt</span>
                  <input type="file" accept=".txt" onChange={handleFileUpload} className="hidden" />
                </label>
              </div>

              <Textarea
                id="import-content-textarea"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={
                  "192.168.1.1:8080\nsocks5://user:pass@10.0.0.1:1080\nhttp://proxy.example.com:3128"
                }
                rows={8}
                aria-describedby="import-content-hint"
                className="font-mono text-xs bg-surface border-border/60 resize-none min-h-[160px]"
              />
              <p id="import-content-hint" className="text-[11px] text-muted-foreground">
                One proxy per line. Standard auth format protocol://user:pass@host:port supported.
              </p>
            </div>
          </div>
        )}

        {/* Step 2: Preview */}
        {step === "preview" && preview && (
          <div className="overflow-y-auto min-h-0 space-y-4 py-2 text-xs pr-1">
            <div className="grid grid-cols-4 gap-2">
              <div className="rounded-lg border border-border/60 bg-surface/50 p-2 text-center">
                <span className="text-[10px] uppercase font-semibold text-muted-foreground block">
                  Total
                </span>
                <span className="font-mono text-sm font-bold text-foreground">
                  {preview.totalLines.toLocaleString()}
                </span>
              </div>
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2 text-center">
                <span className="text-[10px] uppercase font-semibold text-emerald-400 block">
                  Valid
                </span>
                <span className="font-mono text-sm font-bold text-emerald-400">
                  {preview.valid.toLocaleString()}
                </span>
              </div>
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-center">
                <span className="text-[10px] uppercase font-semibold text-amber-400 block">
                  Duplicates
                </span>
                <span className="font-mono text-sm font-bold text-amber-400">
                  {preview.duplicates.toLocaleString()}
                </span>
              </div>
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-center">
                <span className="text-[10px] uppercase font-semibold text-rose-400 block">
                  Invalid
                </span>
                <span className="font-mono text-sm font-bold text-rose-400">
                  {preview.invalid.toLocaleString()}
                </span>
              </div>
            </div>

            {/* Protocol Distribution */}
            <div className="space-y-1.5">
              <span className="text-[11px] font-semibold text-muted-foreground uppercase">
                Detected Protocols
              </span>
              <div className="flex flex-wrap gap-2">
                {Object.entries(preview.protocols).map(([proto, count]) => (
                  <Badge key={proto} variant="outline" className="text-xs font-mono py-0.5">
                    {proto.toUpperCase()}: {count.toLocaleString()}
                  </Badge>
                ))}
              </div>
            </div>

            {/* Invalid Lines List */}
            {preview.invalid > 0 && (
              <div className="space-y-1.5" role="region" aria-labelledby="invalid-lines-heading">
                <span
                  id="invalid-lines-heading"
                  className="text-[11px] font-semibold text-rose-400 uppercase flex items-center gap-1"
                >
                  <AlertTriangle className="h-3 w-3" />
                  <span>Invalid Lines Preview ({preview.invalidLines.length} shown)</span>
                </span>
                <ScrollArea className="h-28 rounded border border-rose-500/30 bg-rose-500/5 p-2 font-mono text-[11px] text-rose-300">
                  <div className="space-y-1">
                    {preview.invalidLines.map((line, idx) => (
                      <div
                        key={idx}
                        className="break-all whitespace-pre-wrap py-0.5 border-b border-rose-500/10 last:border-0"
                      >
                        <span className="font-semibold text-rose-400">Line {line.line}:</span>{" "}
                        <span className="text-foreground/80">&quot;{line.text}&quot;</span>{" "}
                        <span className="text-rose-300/80">— {line.error}</span>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}
          </div>
        )}

        {/* Step 3: Success & Next Action */}
        {step === "done" && summary && (
          <div className="overflow-y-auto min-h-0 space-y-4 py-3 text-xs text-center pr-1">
            <div className="flex flex-col items-center gap-2">
              <CheckCircle2 className="h-10 w-10 text-emerald-400" />
              <h3 className="font-bold text-sm text-foreground">Import Completed Successfully</h3>
              <p className="text-muted-foreground max-w-sm">
                Saved <strong>{summary.inserted.toLocaleString()}</strong> new proxies from{" "}
                <code className="text-foreground">{summary.source}</code> ({summary.duplicates}{" "}
                duplicates skipped).
              </p>
            </div>

            {onStartAudit && (
              <div className="rounded-lg border border-primary/40 bg-primary/10 p-3.5 flex items-center justify-between text-left gap-3">
                <div className="space-y-0.5">
                  <span className="font-semibold text-foreground text-xs block">
                    Verify Imported Proxies
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    Launch a background audit to check latency and connectivity immediately.
                  </span>
                </div>
                <Button
                  size="sm"
                  onClick={() => {
                    onStartAudit(summary.source);
                    onOpenChange(false);
                    reset();
                  }}
                  className="h-8 text-xs gap-1.5 bg-primary text-primary-foreground shrink-0 cursor-pointer"
                >
                  <Play className="h-3 w-3 fill-current" />
                  <span>Audit Now</span>
                </Button>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="shrink-0 gap-2 sm:gap-0 pt-2 border-t border-border/40">
          {step === "input" && (
            <>
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
                onClick={handlePreview}
                disabled={loading}
                className="text-xs gap-1.5"
              >
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                <span>Preview List</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </>
          )}

          {step === "preview" && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setStep("input")}
                className="text-xs"
              >
                Back
              </Button>
              <Button
                size="sm"
                onClick={handleCommitImport}
                disabled={loading || (preview?.valid ?? 0) === 0}
                className="text-xs gap-1.5 bg-primary text-primary-foreground hover:bg-primary-hover"
              >
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                <span>Import {preview?.valid.toLocaleString() ?? 0} Proxies</span>
              </Button>
            </>
          )}

          {step === "done" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onOpenChange(false);
                reset();
              }}
              className="text-xs w-full"
            >
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
