"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, ShieldAlert, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth-provider";
import { authHeaders } from "@/lib/api";
import { isAbortError } from "@/lib/request-lifecycle";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { FleetRemovalRecord } from "@/proxyfleet/types";

export interface DeleteNodeDialogProps {
  nodeId: string | null;
  nodeName?: string;
  role?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (removal: FleetRemovalRecord) => void;
}

export function DeleteNodeDialog({
  nodeId,
  nodeName,
  role,
  open,
  onOpenChange,
  onSuccess,
}: DeleteNodeDialogProps) {
  const { password } = useAuth();
  const [endpointCount, setEndpointCount] = useState<number | null>(null);
  const [fetchingDetails, setFetchingDetails] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isController = role === "controller-worker" || nodeId === "controller-node-master";

  useEffect(() => {
    if (!open || !nodeId || isController) {
      setEndpointCount(null);
      setError(null);
      return;
    }

    const abortController = new AbortController();
    setFetchingDetails(true);
    setError(null);

    fetch(`/api/fleet/nodes/${encodeURIComponent(nodeId)}`, {
      headers: authHeaders(password),
      credentials: "same-origin",
      signal: abortController.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Failed to inspect node endpoints (HTTP ${res.status})`);
        }
        const data = await res.json();
        if (abortController.signal.aborted) return;
        if (!data || !Array.isArray(data.endpoints)) {
          throw new Error("Invalid node inspection response: endpoints array missing");
        }
        setEndpointCount(data.endpoints.length);
      })
      .catch((err: unknown) => {
        if (abortController.signal.aborted || isAbortError(err)) return;
        setEndpointCount(null);
        setError(err instanceof Error ? err.message : "Failed to inspect node endpoints");
      })
      .finally(() => {
        if (!abortController.signal.aborted) {
          setFetchingDetails(false);
        }
      });

    return () => {
      abortController.abort();
    };
  }, [open, nodeId, isController, password]);

  async function handleDelete() {
    if (!nodeId || isController) return;
    setDeleting(true);
    setError(null);

    try {
      const res = await fetch(`/api/fleet/nodes/${encodeURIComponent(nodeId)}`, {
        method: "DELETE",
        headers: authHeaders(password),
        credentials: "same-origin",
      });

      const data = await res.json().catch(() => ({}));

      if (res.status === 409) {
        const msg = data.error || "Cannot remove controller node";
        setError(msg);
        toast.error(msg);
        return;
      }

      if (!res.ok) {
        const msg = data.error || `Failed to remove node (HTTP ${res.status})`;
        setError(msg);
        toast.error(msg);
        return;
      }

      const removal: FleetRemovalRecord = data.removal || {
        nodeId,
        nodeName: nodeName || nodeId,
        wireguardIp: "",
        publicKey: null,
        status: res.status === 202 ? "pending" : "completed",
        lastError: null,
        requestedAt: Date.now(),
        completedAt: res.status === 200 ? Date.now() : null,
      };

      if (res.status === 202 || removal.status === "pending") {
        toast.info(`Node "${nodeName || nodeId}" removal queued. Cleanup is pending.`);
      } else {
        toast.success(`Node "${nodeName || nodeId}" removed.`);
      }

      onSuccess?.(removal);
      onOpenChange(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Network error during deletion";
      setError(msg);
      toast.error(msg);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-rose-400">
            {isController ? (
              <>
                <ShieldAlert className="size-5 text-amber-400" />
                Controller Node Protected
              </>
            ) : (
              <>
                <Trash2 className="size-5 text-rose-400" />
                Delete Node
              </>
            )}
          </DialogTitle>
          <DialogDescription>
            {isController
              ? "The controller node runs central infrastructure and cannot be removed."
              : `Review consequences before decommissioning "${nodeName || nodeId}".`}
          </DialogDescription>
        </DialogHeader>

        {isController ? (
          <Alert
            variant="destructive"
            className="border-amber-500/40 bg-amber-500/10 text-amber-200"
          >
            <ShieldAlert className="size-4 text-amber-400" />
            <AlertTitle className="text-amber-300 font-semibold">Protected Role</AlertTitle>
            <AlertDescription className="text-xs text-amber-200/90 mt-1">
              Nodes with role <code>controller-worker</code> or ID{" "}
              <code>controller-node-master</code> cannot be deleted.
            </AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-3 py-2 text-xs text-muted-foreground">
            {fetchingDetails ? (
              <div className="flex items-center gap-2 text-muted-foreground py-2">
                <Loader2 className="size-4 animate-spin" />
                <span>Checking attached endpoints...</span>
              </div>
            ) : endpointCount !== null && endpointCount > 0 ? (
              <Alert
                variant="destructive"
                className="border-rose-500/40 bg-rose-500/10 text-rose-200"
              >
                <AlertTriangle className="size-4 text-rose-400" />
                <AlertTitle className="text-rose-300 font-semibold">Active Endpoints</AlertTitle>
                <AlertDescription className="text-xs text-rose-200/90 mt-1">
                  This node hosts <strong>{endpointCount}</strong> proxy endpoint
                  {endpointCount === 1 ? "" : "s"}. Deleting the node will purge all associated
                  proxy listeners.
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="rounded-md border border-border/60 bg-muted/30 p-3 space-y-1.5">
              <div className="font-semibold text-foreground/90">Decommissioning Behavior</div>
              <ul className="list-disc pl-4 space-y-1 text-muted-foreground">
                <li>WireGuard peer allocation and tunnel routes will be revoked.</li>
                <li>
                  If the host machine is currently offline, agent daemon and local 3proxy processes
                  cannot be uninstalled remotely and require manual cleanup on that host.
                </li>
              </ul>
            </div>

            {error && (
              <Alert variant="destructive" className="text-xs py-2">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleting}>
            Cancel
          </Button>
          {!isController && (
            <Button
              variant="destructive"
              onClick={() => void handleDelete()}
              disabled={deleting || fetchingDetails || endpointCount === null}
            >
              {deleting ? (
                <>
                  <Loader2 className="size-4 animate-spin mr-1.5" />
                  Decommissioning...
                </>
              ) : (
                "Confirm Decommission"
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
