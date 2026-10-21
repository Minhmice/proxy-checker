"use client";

import { useState, useEffect, useRef } from "react";

import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Terminal,
  Server,
  Cpu,
  Monitor,
  Copy,
  Check,
  Radio,
  ExternalLink,
  ChevronRight,
  ShieldCheck,
  AlertTriangle,
  Sparkles,
  Loader2,
  Plus,
} from "lucide-react";
import { authHeaders } from "@/lib/api";
import type { FleetNodeRecord } from "@/proxyfleet/types";

interface EnrollWorkerWizardProps {
  password?: string;
  onNodeEnrolled?: () => void;
  triggerButton?: React.ReactNode;
}

type PlatformTarget = "linux" | "arm" | "windows";

export function EnrollWorkerWizard({
  password,
  onNodeEnrolled,
  triggerButton,
}: EnrollWorkerWizardProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [platform, setPlatform] = useState<PlatformTarget>("linux");
  const [nodeName, setNodeName] = useState("");
  const [enrollToken, setEnrollToken] = useState("");
  const [tokenLoading, setTokenLoading] = useState(false);
  const [tokenError, setTokenError] = useState("");
  const [copied, setCopied] = useState(false);
  const [enrolledNode, setEnrolledNode] = useState<FleetNodeRecord | null>(null);
  const [isHandshaking, setIsHandshaking] = useState(false);
  const [controllerUrl, setControllerUrl] = useState("");
  // ponytail: dynamic origin with manual override; upgrade to registered controller discovery endpoint if fleet topology becomes multi-region.
  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  const tokenAbortRef = useRef<AbortController | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  const pollingInFlightRef = useRef(false);
  const isMountedRef = useRef(true);
  const successRef = useRef(false);


  // Auto-generate name preset based on platform
  const generatePresetName = (p: PlatformTarget) => {
    const randomHex = Math.floor(Math.random() * 899 + 100);
    if (p === "linux") return `vps-worker-${randomHex}`;
    if (p === "arm") return `pi-arm7-${randomHex}`;
    return `win-host-${randomHex}`;
  };

  const cancelPending = () => {
    clearInterval(pollingRef.current ?? undefined);
    pollingRef.current = null;
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
    pollingInFlightRef.current = false;
    tokenAbortRef.current?.abort();
    tokenAbortRef.current = null;
  };

  const stopHandshakePolling = () => {
    clearInterval(pollingRef.current ?? undefined);
    pollingRef.current = null;
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
    pollingInFlightRef.current = false;
    if (isMountedRef.current) setIsHandshaking(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      cancelPending();
      if (isMountedRef.current) {
        setIsHandshaking(false);
        setTokenLoading(false);
      }
    }
  };


  // Reset or initialize state on modal open
  useEffect(() => {
    if (open) {
      setStep(1);
      setNodeName(generatePresetName(platform));
      setControllerUrl(window.location.origin);
      setEnrollToken("");
      setTokenError("");
      setEnrolledNode(null);
      setTokenLoading(false);
      setIsHandshaking(false);
      successRef.current = false;
    }
  }, [open]);


  // Update preset name if user switches platform before typing custom name
  const handleSelectPlatform = (p: PlatformTarget) => {
    setPlatform(p);
    setNodeName(generatePresetName(p));
  };

  const parseValidatedServerUrl = (raw: string): string | null => {
    try {
      const parsed = new URL(raw.trim());
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      if (parsed.username || parsed.password) return null;
      return parsed.origin;
    } catch {
      return null;
    }
  };

  const handleGenerateToken = async () => {
    const validatedUrl = parseValidatedServerUrl(controllerUrl);
    if (!nodeName.trim()) {
      setTokenError("Node identifier is required.");
      return;
    }
    if (!validatedUrl) {
      setTokenError("Controller URL must be valid HTTP or HTTPS address without credentials.");
      return;
    }
    if (tokenLoading) return;

    tokenAbortRef.current?.abort();
    const controller = new AbortController();
    tokenAbortRef.current = controller;

    setTokenLoading(true);
    setTokenError("");
    try {
      const res = await fetch("/api/fleet/enrollment-tokens", {
        method: "POST",
        headers: { ...authHeaders(password), "Content-Type": "application/json" },
        credentials: "same-origin",
        signal: controller.signal,
        body: JSON.stringify({ nodeName: nodeName.trim(), ttlMinutes: 60 }),
      });
      const data = await res.json().catch(() => ({}));
      if (controller.signal.aborted || !isMountedRef.current) return;
      if (!res.ok) throw new Error(data.error || `Token request failed (${res.status}).`);
      if (typeof data.token !== "string" || !data.token) throw new Error("Token response was incomplete. Try again.");
      setEnrollToken(data.token);
      setStep(2);
      startHandshakePolling(nodeName.trim());
    } catch (error) {
      if (controller.signal.aborted || !isMountedRef.current) return;
      setTokenError(error instanceof Error ? error.message : "Network error while requesting token. Check connection and try again.");
    } finally {
      if (!controller.signal.aborted && isMountedRef.current) {
        setTokenLoading(false);
        if (tokenAbortRef.current === controller) tokenAbortRef.current = null;
      }
    }
  };



  // Poll for the exact node name; unrelated fleet heartbeats must not complete this enrollment.
  // Poll for exact matching online node; unrelated heartbeats or offline records cannot complete enrollment.
  const startHandshakePolling = (targetName: string) => {
    setIsHandshaking(true);
    clearInterval(pollingRef.current ?? undefined);
    pollAbortRef.current?.abort();
    pollingInFlightRef.current = false;

    pollingRef.current = setInterval(async () => {
      if (pollingInFlightRef.current) return;
      const controller = new AbortController();
      pollAbortRef.current = controller;
      pollingInFlightRef.current = true;
      try {
        const res = await fetch("/api/fleet/nodes", {
          headers: authHeaders(password),
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!res.ok || controller.signal.aborted) return;
        const data = await res.json();
        if (controller.signal.aborted || !isMountedRef.current) return;

        const match = (data.nodes || []).find(
          (node: FleetNodeRecord) => node.name === targetName && node.status === "online"
        );
        if (match && !successRef.current && isMountedRef.current) {
          successRef.current = true;
          setEnrolledNode(match);
          setStep(3);
          stopHandshakePolling();
          onNodeEnrolled?.();
        }
      } catch {
        // Polling retries on next interval; no state transition on transient network failures.
      } finally {
        pollingInFlightRef.current = false;
        if (pollAbortRef.current === controller) pollAbortRef.current = null;
      }
    }, 2500);
  };

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      cancelPending();
    };
  }, []);



  const targetServer = parseValidatedServerUrl(controllerUrl);

  const getProvisionCommand = () => {
    if (!enrollToken || !targetServer) return "";
    const trimmedNode = nodeName.trim();
    if (platform === "linux" || platform === "arm") {
      const qServer = `'${targetServer.replace(/'/g, "'\\''")}'`;
      const qToken = `'${enrollToken.replace(/'/g, "'\\''")}'`;
      const qNode = `'${trimmedNode.replace(/'/g, "'\\''")}'`;
      return `curl -fsSL ${targetServer}/install-agent.sh | sudo bash -s -- --server ${qServer} --token ${qToken} --node-name ${qNode}`;
    }

    const qServer = `'${targetServer.replace(/'/g, "''")}'`;
    const qToken = `'${enrollToken.replace(/'/g, "''")}'`;
    const qNode = `'${trimmedNode.replace(/'/g, "''")}'`;
    return `.\\bin\\proxyfleet-agent.exe --server ${qServer} --token ${qToken} --node-name ${qNode}`;
  };
  const command = getProvisionCommand();



  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {triggerButton || (
          <Button size="sm" className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm">
            <Plus className="size-4" />
            Enroll Device
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col bg-card text-card-foreground border-border p-0 overflow-hidden shadow-2xl">
        {/* Terminal Header Bar */}
        <div className="bg-muted/50 px-6 py-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex gap-1.5">
              <span className="size-2.5 rounded-full bg-rose-500/80 inline-block" />
              <span className="size-2.5 rounded-full bg-amber-500/80 inline-block" />
              <span className="size-2.5 rounded-full bg-emerald-500/80 inline-block" />
            </div>
            <div className="h-4 w-[1px] bg-border" />
            <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
              <Terminal className="size-3.5 text-emerald-400" />
              <span>FLEET_CONTROL_PLANE // ENROLL_AGENT</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Badge variant="outline" className="border-border font-mono text-[10px] text-muted-foreground">
              PHASE {step}/3
            </Badge>
          </div>
        </div>

        <div className="p-6 space-y-6 overflow-y-auto">
          {/* Step 1: Target Spec & Environment */}
          {step === 1 && (
            <div className="space-y-5">
              <DialogHeader>
                <DialogTitle className="text-xl font-bold tracking-tight text-foreground flex items-center gap-2">
                  <Server className="size-5 text-emerald-400" />
                  Target Architecture & Identity
                </DialogTitle>
                <DialogDescription className="text-muted-foreground text-xs">
                  Select target device platform and assign a unique identifier for cluster enrollment.
                </DialogDescription>
              </DialogHeader>

              {tokenError && (
                <Alert variant="destructive" id="enroll-token-error" className="py-2.5">
                  <AlertTriangle className="size-4" />
                  <AlertTitle>Enrollment Error</AlertTitle>
                  <AlertDescription className="text-xs">
                    {tokenError}
                  </AlertDescription>
                </Alert>
              )}

              {/* Platform Selector Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3" role="radiogroup" aria-label="Target Architecture">
                <button
                  type="button"
                  role="radio"
                  aria-checked={platform === "linux"}
                  onClick={() => handleSelectPlatform("linux")}
                  className={`p-3.5 rounded-xl border text-left transition-all relative flex flex-col justify-between ${
                    platform === "linux"
                      ? "border-emerald-500/60 bg-emerald-950/20 text-foreground shadow-sm ring-1 ring-emerald-500/30"
                      : "border-border bg-muted/40 text-muted-foreground hover:border-border hover:text-foreground"
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <Server className={`size-5 ${platform === "linux" ? "text-emerald-400" : "text-muted-foreground"}`} />
                      <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-[10px]">
                        Default
                      </Badge>
                    </div>
                    <div className="font-semibold text-sm">Linux VPS</div>
                    <div className="text-[11px] text-muted-foreground mt-1">Ubuntu, Debian (amd64 / arm64)</div>
                  </div>
                  <div className="mt-3 text-[10px] text-emerald-500 font-mono">Full stack: 3proxy + WG</div>
                </button>

                <button
                  type="button"
                  role="radio"
                  aria-checked={platform === "arm"}
                  onClick={() => handleSelectPlatform("arm")}
                  className={`p-3.5 rounded-xl border text-left transition-all relative flex flex-col justify-between ${
                    platform === "arm"
                      ? "border-emerald-500/60 bg-emerald-950/20 text-foreground shadow-sm ring-1 ring-emerald-500/30"
                      : "border-border bg-muted/40 text-muted-foreground hover:border-border hover:text-foreground"
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <Cpu className={`size-5 ${platform === "arm" ? "text-emerald-400" : "text-muted-foreground"}`} />
                      <Badge variant="outline" className="border-border text-muted-foreground text-[10px]">
                        ARMv7
                      </Badge>
                    </div>
                    <div className="font-semibold text-sm">Raspberry Pi</div>
                    <div className="text-[11px] text-muted-foreground mt-1">OpenWrt, Raspbian, ARM Boards</div>
                  </div>
                  <div className="mt-3 text-[10px] text-emerald-500 font-mono">Optimized binary</div>
                </button>

                <button
                  type="button"
                  role="radio"
                  aria-checked={platform === "windows"}
                  onClick={() => handleSelectPlatform("windows")}
                  className={`p-3.5 rounded-xl border text-left transition-all relative flex flex-col justify-between ${
                    platform === "windows"
                      ? "border-emerald-500/60 bg-emerald-950/20 text-foreground shadow-sm ring-1 ring-emerald-500/30"
                      : "border-border bg-muted/40 text-muted-foreground hover:border-border hover:text-foreground"
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <Monitor className={`size-5 ${platform === "windows" ? "text-emerald-400" : "text-muted-foreground"}`} />
                      <Badge variant="outline" className="border-border text-muted-foreground text-[10px]">
                        Dev Mode
                      </Badge>
                    </div>
                    <div className="font-semibold text-sm">Windows Host</div>
                    <div className="text-[11px] text-muted-foreground mt-1">Local testing / Native CLI</div>
                  </div>
                  <div className="mt-3 text-[10px] text-amber-500 font-mono">Loopback / Tailscale</div>
                </button>
              </div>

              {/* Node Identifier Input */}
              <div className="space-y-2 pt-2">
                <Label htmlFor="enroll-node-identifier" className="text-xs font-mono font-medium text-muted-foreground flex items-center justify-between">
                  <span>NODE IDENTIFIER</span>
                  <span id="enroll-node-identifier-desc" className="text-[10px] text-muted-foreground">Unique cluster identifier</span>
                </Label>
                <div className="relative">
                  <Input
                    id="enroll-node-identifier"
                    aria-describedby="enroll-node-identifier-desc"
                    aria-invalid={!!tokenError}
                    className="bg-muted/40 border-border font-mono text-sm text-foreground pl-3 pr-24 focus-visible:ring-emerald-500"
                    placeholder="e.g. vps-worker-01"
                    value={nodeName}
                    onChange={(e) => setNodeName(e.target.value)}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setNodeName(generatePresetName(platform))}
                    className="absolute right-1 top-1 h-7 text-[10px] font-mono text-muted-foreground hover:text-foreground"
                  >
                    <Sparkles className="size-3 mr-1 text-emerald-400" />
                    Auto-Name
                  </Button>
                </div>
              </div>

              {/* Controller Server Target (Tailscale Overlay) */}
              <div className="space-y-2 pt-1">
                <Label htmlFor="enroll-controller-url" className="text-xs font-mono font-medium text-muted-foreground flex items-center justify-between">
                  <span>CONTROLLER SERVER (TAILSCALE / OVERLAY)</span>
                  <span id="enroll-controller-url-desc" className="text-[10px] text-muted-foreground">Worker connects to this URL during bootstrap</span>
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="enroll-controller-url"
                    aria-describedby="enroll-controller-url-desc"
                    className="bg-muted/40 border-border font-mono text-xs text-foreground focus-visible:ring-emerald-500"
                    placeholder="http://100.x.y.z:1300 or current origin"
                    value={controllerUrl}
                    onChange={(e) => setControllerUrl(e.target.value)}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      if (typeof window !== "undefined") setControllerUrl(window.location.origin);
                    }}
                    className="border-border bg-muted hover:bg-accent text-[11px] font-mono text-foreground"
                  >
                    Origin
                  </Button>
                </div>
              </div>

              {/* Security Policy Reminder */}
              <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground flex items-start gap-2.5">
                <ShieldCheck className="size-4 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <span className="text-foreground font-medium">Automated Security:</span> Controller issues a single-use token valid for 60 minutes and provisions an overlay WireGuard mesh address in <code className="text-emerald-400 font-mono">10.77.0.x</code>.
                </div>
              </div>

              {/* Submit CTA */}
              <div className="flex justify-end pt-2">
                <Button
                  onClick={handleGenerateToken}
                  disabled={!nodeName.trim() || tokenLoading}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white font-medium px-5 gap-2"
                >
                  {tokenLoading ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Issuing Token...
                    </>
                  ) : (
                    <>
                      Generate Provisioning CLI
                      <ChevronRight className="size-4" />
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}

          {/* Step 2: Live Provisioning CLI & Handshake Pulse */}
          {step === 2 && (
            <div className="space-y-5">
              <DialogHeader>
                <DialogTitle className="text-xl font-bold tracking-tight text-foreground flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Terminal className="size-5 text-emerald-400" />
                    Execute Provisioning Command
                  </div>
                  <Badge className="bg-emerald-950/60 text-emerald-400 border-emerald-500/30 font-mono text-xs">
                    TOKEN ACTIVE
                  </Badge>
                </DialogTitle>
                <DialogDescription className="text-muted-foreground text-xs">
                  Run the command below in the target terminal with root or administrator privileges to complete bootstrap.
                </DialogDescription>
              </DialogHeader>

              {/* Terminal Box */}
              <div className="rounded-xl border border-border bg-black/90 p-4 font-mono text-xs relative group shadow-inner">
                <div className="flex items-center justify-between pb-3 mb-3 border-b border-border text-[11px] text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
                    <span>TARGET: {nodeName} ({platform.toUpperCase()})</span>
                  </div>
                  <span className="text-[10px]">TTL: 60 mins (Single-Use)</span>
                </div>

                <div className="text-emerald-400 break-all leading-relaxed pr-10 font-mono selection:bg-emerald-900 selection:text-white">
                  <span className="text-muted-foreground select-none">$ </span>
                  {command}
                </div>

                <Button
                  size="sm"
                  variant="outline"
                  className="absolute top-3.5 right-3 h-8 px-2.5 border-border bg-muted hover:bg-accent text-foreground text-xs gap-1.5"
                  onClick={() => {
                    navigator.clipboard.writeText(command);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                >
                  {copied ? (
                    <>
                      <Check className="size-3.5 text-emerald-400" />
                      <span className="text-emerald-400">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="size-3.5" />
                      <span>Copy</span>
                    </>
                  )}
                </Button>
              </div>

              {/* Handshake Radar & Live Status */}
              <div className="rounded-xl border border-border bg-muted/30 p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="relative flex items-center justify-center">
                    <span className="size-3 rounded-full bg-emerald-500 animate-ping absolute" />
                    <Radio className="size-5 text-emerald-400 relative z-10" />
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-foreground flex items-center gap-2">
                      <span>Waiting for Worker Handshake</span>
                      <Loader2 className="size-3 animate-spin text-muted-foreground" />
                    </div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">
                      Controller listening for agent handshake heartbeat at <code className="text-foreground font-mono">/api/fleet/enroll</code>...
                    </div>
                  </div>
                </div>

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    stopHandshakePolling();
                    setStep(1);
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Back
                </Button>
              </div>

              {platform === "windows" && (
                <div className="rounded-lg border border-amber-900/50 bg-amber-950/20 p-3 text-xs text-amber-300 flex items-start gap-2.5">
                  <AlertTriangle className="size-4 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <strong>Windows Notice:</strong> Ensure local proxy listens on an active port and local address (<code className="font-mono">127.0.0.1</code> or Tailscale IP). Do not bind WireGuard IP if interface driver is not configured.
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Step 3: Success State & Handshake Confirmed */}
          {step === 3 && enrolledNode && (
            <div className="space-y-5 text-center py-4">
              <div className="mx-auto size-16 rounded-full bg-emerald-950/60 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shadow-lg shadow-emerald-950/40">
                <Check className="size-8 stroke-[2.5]" />
              </div>

              <div className="space-y-1">
                <h3 className="text-xl font-bold tracking-tight text-foreground">Device Successfully Enrolled!</h3>
                <p className="text-xs text-muted-foreground">
                  Worker node established WireGuard handshake and connected securely to fleet cluster.
                </p>
              </div>

              {/* Node Summary Spec Card */}
              <div className="rounded-xl border border-border bg-muted/40 p-4 text-left font-mono text-xs space-y-2 max-w-md mx-auto">
                <div className="flex justify-between items-center py-1 border-b border-border">
                  <span className="text-muted-foreground">Node Identifier:</span>
                  <span className="text-emerald-400 font-bold">{enrolledNode.name}</span>
                </div>
                <div className="flex justify-between items-center py-1 border-b border-border">
                  <span className="text-muted-foreground">Overlay WireGuard IP:</span>
                  <span className="text-foreground">{enrolledNode.wireguard_ip}</span>
                </div>
                <div className="flex justify-between items-center py-1 border-b border-border">
                  <span className="text-muted-foreground">Status:</span>
                  <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-[10px]">
                    ONLINE
                  </Badge>
                </div>
                <div className="flex justify-between items-center py-1">
                  <span className="text-muted-foreground">Platform OS:</span>
                  <span className="text-foreground">{enrolledNode.os || platform} ({enrolledNode.arch || "amd64"})</span>
                </div>
              </div>

              <div className="flex justify-center gap-3 pt-2">
                <Button
                  variant="outline"
                  onClick={() => setOpen(false)}
                  className="border-border bg-muted hover:bg-accent text-foreground"
                >
                  Close
                </Button>
                <Button
                  onClick={() => {
                    setOpen(false);
                    router.push(`/nodes/${enrolledNode.id}`);
                  }}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2 font-medium"
                >
                  Configure Proxy Endpoints
                  <ExternalLink className="size-4" />
                </Button>
              </div>
            </div>
          )}

        </div>
      </DialogContent>
    </Dialog>
  );
}
