"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, StopCircle, X, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  cancelIntelligenceJob,
  fetchIntelligenceJob,
  type IntelligenceJob,
} from "@/lib/proxy-intelligence-api";

export interface AuditJobIndicatorProps {
  activeJobId: string | null;
  onJobFinished?: () => void;
  onDismiss?: () => void;
}

export function AuditJobIndicator({
  activeJobId,
  onJobFinished,
  onDismiss,
}: AuditJobIndicatorProps) {
  const [job, setJob] = useState<IntelligenceJob | null>(null);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    if (!activeJobId) {
      setJob(null);
      return;
    }

    const controller = new AbortController();
    let timer: NodeJS.Timeout | null = null;

    async function poll() {
      try {
        const current = await fetchIntelligenceJob(activeJobId!, controller.signal);
        setJob(current);

        const isRunning =
          current.status === "queued" ||
          current.status === "running" ||
          current.status === "cancelling";
        if (isRunning && !controller.signal.aborted) {
          timer = setTimeout(poll, 1200);
        } else if (!isRunning) {
          if (onJobFinished) onJobFinished();
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error("Job poll failed:", err);
        }
      }
    }

    void poll();

    return () => {
      controller.abort();
      clearTimeout(timer ?? undefined);
    };
  }, [activeJobId, onJobFinished]);

  if (!job) return null;

  const percent = job.total > 0 ? Math.min(100, Math.round((job.checked / job.total) * 100)) : 0;
  const isRunning =
    job.status === "queued" || job.status === "running" || job.status === "cancelling";
  const isInterrupted = job.status === "interrupted";

  const handleCancel = async () => {
    if (!job || cancelling) return;
    setCancelling(true);
    try {
      const res = await cancelIntelligenceJob(job.id);
      setJob(res);
      toast.info("Audit job cancellation requested");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="rounded-lg border border-border/70 bg-card p-3.5 space-y-2.5 text-xs shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isRunning ? (
            <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
          ) : isInterrupted ? (
            <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden="true" />
          ) : job.failCount > 0 ? (
            <XCircle className="h-4 w-4 text-rose-500" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden="true" />
          )}

          <span className="font-semibold text-foreground">
            {isRunning
              ? "Auditing proxy fleet..."
              : isInterrupted
                ? "Audit interrupted (server restart)"
                : "Audit job complete"}
          </span>

          <span className="font-mono text-muted-foreground text-[11px]">
            {job.checked.toLocaleString()} / {job.total.toLocaleString()} ({percent}%)
          </span>
        </div>

        <div className="flex items-center gap-2">
          {isRunning && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleCancel}
              disabled={cancelling || job.status === "cancelling"}
              className="h-7 px-2.5 text-xs text-rose-400 border-rose-500/40 hover:bg-rose-500/10 cursor-pointer"
            >
              <StopCircle className="h-3 w-3 mr-1" />
              <span>{cancelling || job.status === "cancelling" ? "Stopping..." : "Cancel"}</span>
            </Button>
          )}

          {!isRunning && onDismiss && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDismiss}
              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground cursor-pointer"
              aria-label="Dismiss job indicator"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      <Progress value={percent} className="h-1.5 bg-muted/40" />

      <div className="flex items-center gap-4 text-[11px] font-mono text-muted-foreground">
        <span className="flex items-center gap-1 text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          PASS {job.passCount.toLocaleString()}
        </span>
        <span className="flex items-center gap-1 text-amber-400">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          WARN {job.warnCount.toLocaleString()}
        </span>
        <span className="flex items-center gap-1 text-rose-400">
          <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
          FAIL {job.failCount.toLocaleString()}
        </span>
      </div>
    </div>
  );
}
