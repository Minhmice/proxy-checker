"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  Copy,
  Key,
  Loader2,
  Network,
  RefreshCw,
  Server,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth-provider";
import { authHeaders, updateSettings } from "@/lib/api";
import { isAbortError } from "@/lib/request-lifecycle";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { CopyButton } from "@/components/ui/copy-button";
import type { FleetWireGuardSettings } from "@/proxyfleet/wireguard";
import type { FleetNodeRecord } from "@/proxyfleet/types";

interface WireGuardStatusResponse {
  configured: boolean;
  settings?: FleetWireGuardSettings | null;
  observation?: {
    state: "healthy" | "unhealthy" | "unknown";
    interfacePresent: boolean | null;
    peerPresent: boolean | null;
    lastHandshakeAt: number | null;
    error: string | null;
  } | null;
  publicKey?: string | null;
  error?: string | null;
}

export function WireGuardSettingsCard({
  initialSettings,
  onSettingsSaved,
}: {
  initialSettings?: FleetWireGuardSettings | null;
  onSettingsSaved?: (newSettings: FleetWireGuardSettings | null) => void;
}) {
  const { password } = useAuth();

  // Status from /api/fleet/wireguard
  const [statusLoading, setStatusLoading] = useState(true);
  const [status, setStatus] = useState<WireGuardStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  // Form state
  const [managementEnabled, setManagementEnabled] = useState<boolean>(
    initialSettings !== null && initialSettings !== undefined,
  );
  const [interfaceName, setInterfaceName] = useState<string>(
    initialSettings?.interfaceName || "proxyfleet",
  );
  const [controllerCidr, setControllerCidr] = useState<string>(
    initialSettings?.controllerAddressCidr || "10.77.0.1/24",
  );
  const [publicEndpoint, setPublicEndpoint] = useState<string>(
    initialSettings?.publicEndpoint || "",
  );
  const [listenPort, setListenPort] = useState<string>(
    initialSettings?.listenPort ? String(initialSettings.listenPort) : "51820",
  );
  const [mtu, setMtu] = useState<string>(initialSettings?.mtu ? String(initialSettings.mtu) : "");

  const [saving, setSaving] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  // Migration state
  const [workerNodes, setWorkerNodes] = useState<FleetNodeRecord[]>([]);
  const [selectedMigrateNodeIds, setSelectedMigrateNodeIds] = useState<string[]>([]);
  const [migrating, setMigrating] = useState(false);
  const hasHydratedRef = useRef(false);

  const abortRef = useRef<AbortController | null>(null);

  const fetchStatus = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setStatusLoading(true);
        setStatusError(null);
        const res = await fetch("/api/fleet/wireguard", {
          headers: authHeaders(password),
          credentials: "same-origin",
          signal,
        });

        if (!res.ok) {
          throw new Error(`Failed to query WireGuard controller (HTTP ${res.status})`);
        }

        const data: WireGuardStatusResponse = await res.json();
        if (signal?.aborted) return;
        setStatus(data);
        if (data.settings && !hasHydratedRef.current) {
          hasHydratedRef.current = true;
          setManagementEnabled(true);
          setInterfaceName("proxyfleet");
          setControllerCidr("10.77.0.1/24");
          setPublicEndpoint(data.settings.publicEndpoint || "");
          setListenPort(String(data.settings.listenPort));
          setMtu(data.settings.mtu ? String(data.settings.mtu) : "");
        }

        // Load candidate worker nodes for migration
        try {
          const nodesRes = await fetch("/api/fleet/nodes", {
            headers: authHeaders(password),
            credentials: "same-origin",
            signal,
          });
          if (nodesRes.ok) {
            const nodesData = await nodesRes.json();
            const allNodes = (nodesData.nodes || []) as FleetNodeRecord[];
            const workers = allNodes.filter(
              (n) => n.role !== "controller-worker" && n.id !== "controller-node-master",
            );
            setWorkerNodes(workers);
          }
        } catch {
          // ignore node fetch errors for settings view
        }
      } catch (err: unknown) {
        if (isAbortError(err)) return;
        setStatusError(err instanceof Error ? err.message : "Failed to load WireGuard status");
      } finally {
        setStatusLoading(false);
      }
    },
    [password],
  );

  useEffect(() => {
    const ac = new AbortController();
    abortRef.current = ac;
    void fetchStatus(ac.signal);
    return () => {
      ac.abort();
    };
  }, [fetchStatus]);

  async function handleSaveSettings() {
    setSaving(true);
    try {
      let payloadSettings: FleetWireGuardSettings | null = null;

      if (managementEnabled) {
        const portNum = Number(listenPort);
        if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
          toast.error("Valid listen port (1-65535) is required");
          setSaving(false);
          return;
        }

        const mtuNum = mtu.trim() ? Number(mtu) : null;
        if (mtuNum !== null && (!Number.isInteger(mtuNum) || mtuNum < 1280 || mtuNum > 9000)) {
          toast.error("MTU must be between 1280 and 9000 (or leave empty)");
          setSaving(false);
          return;
        }

        if (!controllerCidr.includes("/")) {
          toast.error("Controller address must be in CIDR format (e.g. 10.77.0.1/24)");
          setSaving(false);
          return;
        }

        payloadSettings = {
          interfaceName: interfaceName.trim() || "proxyfleet",
          controllerAddressCidr: controllerCidr.trim(),
          publicEndpoint: publicEndpoint.trim(),
          listenPort: portNum,
          mtu: mtuNum,
        };
      }

      await updateSettings(password, { fleetWireguard: payloadSettings });
      toast.success(
        payloadSettings
          ? "WireGuard configuration saved"
          : "WireGuard management disabled (external tunnels untouched)",
      );
      onSettingsSaved?.(payloadSettings);
      void fetchStatus();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to save WireGuard configuration");
    } finally {
      setSaving(false);
    }
  }

  async function handleExplicitSetup() {
    setSettingUp(true);
    try {
      const res = await fetch("/api/fleet/wireguard/setup", {
        method: "POST",
        headers: authHeaders(password),
        credentials: "same-origin",
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const msg = data.error || `Setup failed (HTTP ${res.status})`;
        toast.error(msg);
        return;
      }

      toast.success("WireGuard interface initialized on controller");
      void fetchStatus();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Network error during WireGuard setup");
    } finally {
      setSettingUp(false);
    }
  }

  async function copyPublicKey(key: string) {
    try {
      await navigator.clipboard.writeText(key);
      toast.success("Controller public key copied");
    } catch {
      toast.error("Could not copy public key");
    }
  }

  async function handleMigrateSelected() {
    if (selectedMigrateNodeIds.length === 0) return;
    setMigrating(true);
    try {
      const res = await fetch("/api/fleet/wireguard/migrate", {
        method: "POST",
        headers: authHeaders(password),
        credentials: "same-origin",
        body: JSON.stringify({ nodeIds: selectedMigrateNodeIds }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data.error || `Migration failed (HTTP ${res.status})`;
        toast.error(msg);
        return;
      }
      toast.success(`Approved and migrated ${selectedMigrateNodeIds.length} worker peer(s)`);
      setSelectedMigrateNodeIds([]);
      void fetchStatus();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Network error during worker migration");
    } finally {
      setMigrating(false);
    }
  }

  function toggleMigrateNode(nodeId: string) {
    setSelectedMigrateNodeIds((prev) =>
      prev.includes(nodeId) ? prev.filter((id) => id !== nodeId) : [...prev, nodeId],
    );
  }

  function toggleSelectAllMigrate() {
    if (selectedMigrateNodeIds.length === workerNodes.length) {
      setSelectedMigrateNodeIds([]);
    } else {
      setSelectedMigrateNodeIds(workerNodes.map((n) => n.id));
    }
  }
  return (
    <Card className="border-border/60 bg-card/60 shadow-none overflow-hidden">
      <CardHeader className="border-b border-border/40 pb-3 bg-muted/10">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Network className="size-4 text-primary" />
              Fleet WireGuard Overlay
              {status?.configured ? (
                <Badge
                  variant="outline"
                  className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300 gap-1 text-[11px] font-normal"
                >
                  <ShieldCheck className="size-3" /> Configured
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="border-amber-500/40 bg-amber-500/10 text-amber-300 gap-1 text-[11px] font-normal"
                >
                  <ShieldAlert className="size-3" /> Unconfigured
                </Badge>
              )}
            </CardTitle>
            <CardDescription className="text-xs">
              Direct peer-to-peer overlay subnet (10.77.0.0/24) for worker egress tunnels.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchStatus()}
            disabled={statusLoading}
            className="h-8 gap-1.5 text-xs self-start sm:self-auto"
          >
            <RefreshCw className={`size-3.5 ${statusLoading ? "animate-spin" : ""}`} />
            Refresh Status
          </Button>
        </div>
      </CardHeader>

      <CardContent className="p-4 space-y-5">
        {/* Status & Observation Banner */}
        {status?.error && (
          <Alert variant="destructive" className="py-2.5">
            <ShieldAlert className="size-4" />
            <AlertTitle className="text-xs font-semibold">Interface Error</AlertTitle>
            <AlertDescription className="text-xs mt-0.5">{status.error}</AlertDescription>
          </Alert>
        )}

        {status?.publicKey && (
          <div className="rounded-md border border-border/50 bg-background/50 p-3 space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-foreground flex items-center gap-1.5">
                <Key className="size-3.5 text-primary" /> Controller Public Key
              </span>
              <CopyButton
                value={status.publicKey}
                label="Public key"
                size="sm"
                className="h-6 px-2 text-[11px]"
              />
            </div>
            <div className="font-mono text-xs text-muted-foreground break-all select-all">
              {status.publicKey}
            </div>
            <div className="text-[10px] text-muted-foreground">
              Private keys are strictly guarded and never exposed to the client browser.
            </div>
          </div>
        )}

        {/* Management Toggle */}
        <div className="flex items-center justify-between rounded-md border border-border/50 bg-muted/10 p-3">
          <div className="space-y-0.5">
            <Label htmlFor="wg-manage-switch" className="text-xs font-semibold text-foreground">
              Enable Controller Overlay Management
            </Label>
            <div className="text-[11px] text-muted-foreground">
              When disabled, management is turned off without destroying host network interfaces.
            </div>
          </div>
          <Switch
            id="wg-manage-switch"
            checked={managementEnabled}
            onCheckedChange={setManagementEnabled}
          />
        </div>

        {managementEnabled && (
          <div className="space-y-4 pt-1">
            <div className="grid grid-cols-1 sm:grid-cols-2 3xl:grid-cols-4 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="wg-iface" className="text-xs font-medium">
                  Interface Name
                </Label>
                <Input
                  id="wg-iface"
                  value="proxyfleet"
                  readOnly
                  className="h-9 text-xs font-mono bg-muted/40 cursor-not-allowed text-muted-foreground"
                />
                <p className="text-[10px] text-muted-foreground">
                  Fixed: <code>proxyfleet</code>. Enforced by controller allocator.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="wg-cidr" className="text-xs font-medium">
                  Controller Address (CIDR)
                </Label>
                <Input
                  id="wg-cidr"
                  value="10.77.0.1/24"
                  readOnly
                  className="h-9 text-xs font-mono bg-muted/40 cursor-not-allowed text-muted-foreground"
                />
                <p className="text-[10px] text-muted-foreground">
                  Fixed subnet: <code>10.77.0.0/24</code>. Controller occupies{" "}
                  <code>10.77.0.1</code>.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="wg-endpoint" className="text-xs font-medium">
                  Public Endpoint (Host / IP : Port)
                </Label>
                <Input
                  id="wg-endpoint"
                  value={publicEndpoint}
                  onChange={(e) => setPublicEndpoint(e.target.value)}
                  placeholder="203.0.113.10:51820 or vpn.example.com:51820"
                  className="h-9 text-xs font-mono"
                />
                <p className="text-[10px] text-muted-foreground">
                  Reachable UDP address where worker nodes establish handshake.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="wg-port" className="text-xs font-medium">
                    Listen Port
                  </Label>
                  <Input
                    id="wg-port"
                    type="number"
                    value={listenPort}
                    onChange={(e) => setListenPort(e.target.value)}
                    placeholder="51820"
                    className="h-9 text-xs font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wg-mtu" className="text-xs font-medium">
                    MTU (Optional)
                  </Label>
                  <Input
                    id="wg-mtu"
                    type="number"
                    value={mtu}
                    onChange={(e) => setMtu(e.target.value)}
                    placeholder="1420"
                    className="h-9 text-xs font-mono"
                  />
                </div>
              </div>
            </div>
          </div>
        )}
        {/* Worker Migration Section */}
        {managementEnabled && workerNodes.length > 0 && (
          <div className="rounded-md border border-border/50 bg-background/50 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                  <Users className="size-3.5 text-primary" /> Explicit Worker Peer Migration
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  Select existing worker nodes to reconcile and approve into WireGuard overlay
                  routes.
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[11px] px-2 text-muted-foreground"
                onClick={toggleSelectAllMigrate}
              >
                {selectedMigrateNodeIds.length === workerNodes.length
                  ? "Deselect All"
                  : "Select All"}
              </Button>
            </div>

            <div className="max-h-40 overflow-y-auto space-y-1.5 pr-1">
              {workerNodes.map((w) => (
                <label
                  key={w.id}
                  className="flex items-center justify-between p-2 rounded border border-border/40 hover:bg-muted/20 cursor-pointer text-xs"
                >
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={selectedMigrateNodeIds.includes(w.id)}
                      onCheckedChange={() => toggleMigrateNode(w.id)}
                    />
                    <span className="font-medium text-foreground">{w.name}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      ({w.wireguard_ip})
                    </span>
                  </div>
                  <Badge variant="outline" className="text-[10px] font-mono">
                    {w.status}
                  </Badge>
                </label>
              ))}
            </div>

            <div className="flex justify-end pt-1">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void handleMigrateSelected()}
                disabled={migrating || selectedMigrateNodeIds.length === 0}
                className="h-7 text-xs gap-1.5"
              >
                {migrating && <Loader2 className="size-3 animate-spin" />}
                Migrate {selectedMigrateNodeIds.length} Selected Worker
                {selectedMigrateNodeIds.length === 1 ? "" : "s"}
              </Button>
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-4">
          <div className="text-[11px] text-muted-foreground">
            {managementEnabled
              ? "Saving updates settings in app config."
              : "Disabling removes the WireGuard overlay configuration on save."}
          </div>
          <div className="flex items-center gap-2">
            {managementEnabled && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleExplicitSetup()}
                disabled={settingUp || saving}
                className="h-8 text-xs gap-1.5"
              >
                {settingUp && <Loader2 className="size-3.5 animate-spin" />}
                Setup Interface Now
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => void handleSaveSettings()}
              disabled={saving || settingUp}
              className="h-8 text-xs gap-1.5"
            >
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              Save WireGuard Settings
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
