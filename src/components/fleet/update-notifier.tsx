"use client";

import * as React from "react";
import {
  Sparkles,
  ArrowUpCircle,
  Server,
  CheckCircle2,
  AlertCircle,
  Loader2,
  RefreshCw,
  Terminal,
  ShieldAlert,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth-provider";
import { authHeaders } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSidebar } from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";

export interface ServerUpdateTargetInfo {
  id: string;
  name: string;
  host: string;
  username: string;
  currentVersion: string | null;
  hasUpdate: boolean;
  sshConfigured: boolean;
  reachable?: boolean;
  error?: string;
}

interface FleetUpdateStatusResponse {
  hasUpdate: boolean;
  latestVersion: string | null;
  checkedAt: number;
  sources: {
    npmLatest: string | null;
    routerInstances: Array<{
      url: string;
      currentVersion: string | null;
      hasUpdate: boolean;
      error?: string;
    }>;
  };
  targets?: ServerUpdateTargetInfo[];
  nodes?: Array<{
    id: string;
    name: string;
    role: string;
    status: string;
    ip: string;
    currentVersion: string | null;
    hasUpdate: boolean;
    sshConfigured: boolean;
  }>;
}

interface InteractiveUpgradeResult {
  serverId: string;
  serverName: string;
  host: string;
  status: "pending" | "running" | "success" | "failed";
  output: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
}

interface InteractiveJob {
  id: string;
  createdAt: number;
  completedAt?: number;
  status: "running" | "completed" | "failed";
  targets: Record<string, InteractiveUpgradeResult>;
}

function formatDuration(durationMs?: number) {
  if (durationMs == null) return "—";
  if (durationMs < 1000) return `${durationMs} ms`;
  return `${(durationMs / 1000).toFixed(1)} s`;
}

function formatLogTime(timestamp?: number) {
  return timestamp
    ? new Date(timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";
}

function statusLabel(status: InteractiveUpgradeResult["status"]) {
  switch (status) {
    case "running":
      return "Updating · hiding UI";
    case "success":
      return "Updated · UI hidden";
    case "failed":
      return "Update failed";
    default:
      return "Queued";
  }
}

function statusClass(status: InteractiveUpgradeResult["status"]) {
  switch (status) {
    case "running":
      return "bg-primary/20 text-primary border-primary/30";
    case "success":
      return "bg-emerald-500/20 text-emerald-400 border-emerald-500/30";
    case "failed":
      return "bg-rose-500/20 text-rose-400 border-rose-500/30";
    default:
      return "text-muted-foreground";
  }
}

function statusIcon(status: InteractiveUpgradeResult["status"]) {
  if (status === "running") return <Loader2 className="size-3 animate-spin" />;
  if (status === "success") return <CheckCircle2 className="size-3" />;
  if (status === "failed") return <AlertCircle className="size-3" />;
  return null;
}

export function FleetUpdateBanner() {
  const { password, authenticated } = useAuth();
  const { state: sidebarState } = useSidebar();
  const [updateStatus, setUpdateStatus] = React.useState<FleetUpdateStatusResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [modalOpen, setModalOpen] = React.useState(false);
  const [activeJob, setActiveJob] = React.useState<InteractiveJob | null>(null);
  const [isUpgrading, setIsUpgrading] = React.useState(false);
  const [expandedServers, setExpandedServers] = React.useState<Record<string, boolean>>({});
  const [selectedServerIds, setSelectedServerIds] = React.useState<string[]>([]);
  const hasInitializedSelection = React.useRef(false);

  const pollingRef = React.useRef<NodeJS.Timeout | null>(null);
  const fetchUpdateStatus = React.useCallback(
    async (refresh = false) => {
      if (!authenticated && !password) return;
      try {
        setLoading(true);
        const url = `/api/fleet/update-status${refresh ? "?refresh=true" : ""}`;
        const res = await fetch(url, {
          headers: authHeaders(password),
          credentials: "same-origin",
        });
        if (res.ok) {
          const data = (await res.json()) as FleetUpdateStatusResponse;
          setUpdateStatus(data);
        }
      } catch {
        // Silently fail background status check
      } finally {
        setLoading(false);
      }
    },
    [authenticated, password],
  );

  React.useEffect(() => {
    fetchUpdateStatus();
    const interval = setInterval(() => {
      fetchUpdateStatus();
    }, 120_000);
    return () => clearInterval(interval);
  }, [fetchUpdateStatus]);

  React.useEffect(() => {
    if (
      updateStatus?.targets &&
      updateStatus.targets.length > 0 &&
      !hasInitializedSelection.current
    ) {
      hasInitializedSelection.current = true;
      const needsUpdate = updateStatus.targets
        .filter((t) => t.hasUpdate && t.reachable !== false && !t.error)
        .map((t) => t.id);
      setSelectedServerIds(needsUpdate);
    }
  }, [updateStatus]);
  React.useEffect(() => {
    if (!activeJob || activeJob.status !== "running") return;

    pollingRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/fleet/upgrade/${encodeURIComponent(activeJob.id)}`, {
          headers: authHeaders(password),
          credentials: "same-origin",
        });
        if (res.ok) {
          const data = (await res.json()) as { job: InteractiveJob };
          setActiveJob(data.job);
          if (data.job.status !== "running") {
            setIsUpgrading(false);
            const targets = Object.values(data.job.targets);
            const failedCount = targets.filter((t) => t.status === "failed").length;
            if (failedCount === 0) {
              toast.success(
                "9Router updated and hidden to tray/background successfully on both servers!",
              );
            } else {
              toast.error(
                `Upgrade finished with ${failedCount} server(s) failed. Expand output to inspect.`,
              );
            }
            fetchUpdateStatus(true);
          }
        } else if (res.status === 404) {
          setIsUpgrading(false);
          toast.error("Upgrade job was not found on server. Please try again.");
          if (pollingRef.current) {
            clearInterval(pollingRef.current);
            pollingRef.current = null;
          }
        }
      } catch {
        // Retry next cycle
      }
    }, 2500);

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [activeJob, password, fetchUpdateStatus]);

  const handleStartUpgrade = async () => {
    if (isUpgrading || selectedServerIds.length === 0) return;
    setIsUpgrading(true);
    try {
      const res = await fetch("/api/fleet/upgrade", {
        method: "POST",
        headers: {
          ...authHeaders(password),
          "Content-Type": "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify({
          serverIds: selectedServerIds,
        }),
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Failed to trigger upgrade");
      }

      const data = (await res.json()) as { ok: boolean; job: InteractiveJob };
      setActiveJob(data.job);
      toast.info("Connecting via SSH to update and configure 9Router on both servers...");
    } catch (err) {
      setIsUpgrading(false);
      toast.error((err as Error).message);
    }
  };

  const toggleServerExpand = (serverId: string) => {
    setExpandedServers((prev) => ({
      ...prev,
      [serverId]: !prev[serverId],
    }));
  };
  // Nếu không có máy nào hoạt động tốt cần update (hoặc máy lỗi), không báo update
  const hasValidUpdate =
    Boolean(updateStatus?.hasUpdate) &&
    (updateStatus?.targets && updateStatus.targets.length > 0
      ? updateStatus.targets.some((t) => t.hasUpdate && t.reachable !== false && !t.error)
      : Boolean(updateStatus?.hasUpdate));

  if (!hasValidUpdate && !modalOpen && !activeJob) {
    return null;
  }
  const latestVer = updateStatus?.latestVersion || "latest";

  // Use dedicated target servers, fallback to nodes if targets not populated
  const displayServers: ServerUpdateTargetInfo[] =
    updateStatus?.targets && updateStatus.targets.length > 0
      ? updateStatus.targets
      : [
          {
            id: "server-lan",
            name: "Master Node (192.168.1.54)",
            host: "192.168.1.54",
            username: "minhmice",
            currentVersion: null,
            hasUpdate: true,
            sshConfigured: true,
          },
          {
            id: "server-vpn",
            name: "Tailscale Node (100.73.175.42)",
            host: "100.73.175.42",
            username: "netnut",
            currentVersion: null,
            hasUpdate: true,
            sshConfigured: true,
          },
        ];

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setModalOpen(true)}
            className="min-h-8 h-auto w-full justify-start gap-2 rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-left text-primary hover:bg-primary/20 hover:text-white group-data-[collapsible=icon]:size-9! group-data-[collapsible=icon]:min-h-9! group-data-[collapsible=icon]:p-0! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:border-none shadow-[0_0_12px_rgba(255,91,34,0.15)]"
            aria-label={`9Router update available${latestVer ? `, version ${latestVer}` : ""}`}
          >
            {activeJob?.status === "running" ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
            ) : (
              <ArrowUpCircle className="size-3.5 shrink-0 text-primary" />
            )}
            <span className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
              <span className="block truncate text-[11px] font-semibold text-foreground">
                {activeJob?.status === "running"
                  ? "9Router update running"
                  : "9Router update available"}
              </span>
              <span className="block truncate text-[10px] text-muted-foreground">
                {activeJob?.status === "running"
                  ? "Open progress"
                  : `Version ${latestVer} · Review details`}
              </span>
            </span>
            <ArrowUpCircle className="size-3 shrink-0 text-primary/70 group-data-[collapsible=icon]:hidden" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right" align="center" hidden={sidebarState !== "collapsed"}>
          <div className="font-semibold text-xs">9Router Update</div>
          <div className="text-[10px] text-muted-foreground">Version {latestVer} available</div>
        </TooltipContent>
      </Tooltip>

      {/* Upgrade Modal Dialog */}
      <Dialog open={modalOpen} onOpenChange={(open) => !isUpgrading && setModalOpen(open)}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto bg-card border-border text-foreground">
          <DialogHeader>
            <div className="flex items-center justify-between pr-6">
              <DialogTitle className="flex items-center gap-2 text-base font-semibold">
                <Server className="size-5 text-primary" />
                Update 9Router on dedicated servers
              </DialogTitle>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => fetchUpdateStatus(true)}
                disabled={loading || isUpgrading}
                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground gap-1"
                title="Refresh version status"
              >
                <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
                Check status
              </Button>
            </div>
            <DialogDescription className="text-xs text-muted-foreground">
              Installs the latest version over SSH, opens the Web UI, then hides it to the tray.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 my-2">
            {/* Target Servers & Sequence Info */}
            <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs space-y-1.5 font-mono">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Target version</span>
                <span className="font-semibold text-primary">v{latestVer}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Sequence</span>
                <span className="text-foreground">npm update → Web UI → Hide to Tray</span>
              </div>
            </div>

            {/* Target Servers Table */}
            <div className="rounded-xl border border-[#23232C] bg-[#131318] overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent text-[11px]">
                    <TableHead className="w-8">
                      <Checkbox
                        checked={
                          displayServers.length > 0 &&
                          displayServers.every((s) => selectedServerIds.includes(s.id))
                        }
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setSelectedServerIds(displayServers.map((s) => s.id));
                          } else {
                            setSelectedServerIds([]);
                          }
                        }}
                        disabled={isUpgrading}
                        aria-label="Select all servers"
                      />
                    </TableHead>
                    <TableHead>Server host</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>SSH user</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Output</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="text-xs">
                  {displayServers.map((server) => {
                    const jobTarget = activeJob?.targets[server.id];
                    return (
                      <React.Fragment key={server.id}>
                        <TableRow className="hover:bg-muted/40">
                          <TableCell className="w-8">
                            <Checkbox
                              checked={selectedServerIds.includes(server.id)}
                              onCheckedChange={(checked) => {
                                if (checked) {
                                  setSelectedServerIds((prev) => [...prev, server.id]);
                                } else {
                                  setSelectedServerIds((prev) =>
                                    prev.filter((id) => id !== server.id),
                                  );
                                }
                              }}
                              disabled={
                                isUpgrading || server.reachable === false || Boolean(server.error)
                              }
                              aria-label={`Select ${server.name}`}
                            />
                          </TableCell>
                          <TableCell className="font-medium text-foreground">
                            {server.name}
                            <span className="block text-[10px] text-muted-foreground font-mono">
                              {server.host}
                            </span>
                          </TableCell>
                          <TableCell className="font-mono text-[11px]">
                            {server.currentVersion ? (
                              <span
                                className={server.hasUpdate ? "text-amber-400" : "text-emerald-400"}
                              >
                                v{server.currentVersion}
                              </span>
                            ) : (
                              <span className="text-muted-foreground italic">Unknown</span>
                            )}
                          </TableCell>
                          <TableCell className="font-mono text-[11px] text-muted-foreground">
                            {server.username}
                          </TableCell>
                          <TableCell>
                            {jobTarget ? (
                              <Badge
                                variant={jobTarget.status === "pending" ? "outline" : "default"}
                                className={`${statusClass(jobTarget.status)} text-[10px] py-0.5 whitespace-nowrap inline-flex items-center gap-1`}
                              >
                                {statusIcon(jobTarget.status)}
                                {statusLabel(jobTarget.status)}
                              </Badge>
                            ) : server.reachable === false ||
                              (!server.currentVersion && server.error) ||
                              Boolean(server.error) ? (
                              <Badge
                                variant="outline"
                                className="border-rose-500/40 text-rose-400 text-[10px] py-0.5 whitespace-nowrap inline-flex items-center gap-1"
                                title={server.error || "Host unreachable"}
                              >
                                <AlertCircle className="size-3" />
                                Offline / Lỗi
                              </Badge>
                            ) : !server.hasUpdate && server.currentVersion ? (
                              <Badge
                                variant="outline"
                                className="border-emerald-500/40 text-emerald-400 text-[10px] py-0.5 whitespace-nowrap inline-flex items-center gap-1"
                              >
                                <CheckCircle2 className="size-3" />
                                Up to date
                              </Badge>
                            ) : (
                              <Badge
                                variant="outline"
                                className="border-primary/40 text-primary bg-primary/10 text-[10px] py-0.5 whitespace-nowrap inline-flex items-center gap-1"
                              >
                                <ArrowUpCircle className="size-3" />
                                Ready to update
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            {jobTarget?.output ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 min-w-[96px] text-[11px] px-2 text-primary hover:text-primary-hover"
                                onClick={() => toggleServerExpand(server.id)}
                                aria-expanded={Boolean(expandedServers[server.id])}
                                aria-controls={`upgrade-log-${server.id}`}
                              >
                                <Terminal className="size-3.5 mr-1" />
                                {expandedServers[server.id] ? "Hide output" : "View output"}
                                {expandedServers[server.id] ? (
                                  <ChevronUp className="size-3 ml-1" />
                                ) : (
                                  <ChevronDown className="size-3 ml-1" />
                                )}
                              </Button>
                            ) : (
                              <span className="text-muted-foreground text-[11px]">
                                No output yet
                              </span>
                            )}
                          </TableCell>
                        </TableRow>

                        {/* Collapsible Log Output */}
                        {jobTarget && expandedServers[server.id] && jobTarget.output && (
                          <TableRow className="bg-muted/20">
                            <TableCell colSpan={6} className="p-2">
                              <section
                                id={`upgrade-log-${server.id}`}
                                aria-label={`${server.name} terminal output`}
                                className="overflow-hidden rounded-md border border-border/70 bg-black/80"
                              >
                                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-3 py-2 text-[11px]">
                                  <div className="flex min-w-0 items-center gap-2">
                                    <Terminal className="size-3.5 shrink-0 text-primary" />
                                    <span className="truncate font-medium text-zinc-100">
                                      SSH output · {server.host}
                                    </span>
                                    <Badge
                                      variant="outline"
                                      className={`${statusClass(jobTarget.status)} text-[10px] py-0.5`}
                                    >
                                      {statusLabel(jobTarget.status)}
                                    </Badge>
                                  </div>
                                  <div className="flex items-center gap-3 font-mono text-[10px] text-zinc-400">
                                    <span>Started {formatLogTime(jobTarget.startedAt)}</span>
                                    <span>Duration {formatDuration(jobTarget.durationMs)}</span>
                                  </div>
                                </div>
                                {jobTarget.error && (
                                  <div className="flex items-start gap-2 border-b border-rose-500/20 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-300">
                                    <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
                                    <p className="min-w-0 break-words">
                                      <span className="font-semibold">Update failed.</span>{" "}
                                      {jobTarget.error} Review the output, fix the SSH or router
                                      issue, then run the update again.
                                    </p>
                                  </div>
                                )}
                                <ScrollArea className="h-52 p-3 font-mono text-[11px] leading-5 text-zinc-300 selection:bg-primary/20">
                                  <pre className="whitespace-pre-wrap break-words">
                                    {jobTarget.output}
                                  </pre>
                                </ScrollArea>
                              </section>
                            </TableCell>
                          </TableRow>
                        )}
                      </React.Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>

          <DialogFooter className="flex items-center justify-between sm:justify-between w-full">
            <div className="text-[11px] text-muted-foreground">
              {activeJob && activeJob.status === "running" ? (
                <span className="flex items-center gap-1 text-primary">
                  <Loader2 className="size-3 animate-spin" /> Updating selected servers…
                </span>
              ) : (
                <span>{selectedServerIds.length} server(s) selected</span>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setModalOpen(false)}
                disabled={isUpgrading}
              >
                Close
              </Button>
              <Button
                size="sm"
                onClick={handleStartUpgrade}
                disabled={isUpgrading || selectedServerIds.length === 0}
                className="bg-primary hover:bg-primary-hover text-primary-foreground shadow-[0_0_12px_rgba(255,91,34,0.25)] flex items-center gap-1.5"
              >
                {isUpgrading ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" /> Updating…
                  </>
                ) : (
                  <>
                    <ArrowUpCircle className="size-3.5" />
                    {selectedServerIds.every((id) => {
                      const s = displayServers.find((t) => t.id === id);
                      return s && !s.hasUpdate && s.currentVersion;
                    }) && selectedServerIds.length > 0
                      ? `Reinstall (${selectedServerIds.length})`
                      : `Start update (${selectedServerIds.length})`}
                  </>
                )}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
