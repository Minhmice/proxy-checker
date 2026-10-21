"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth-provider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { downloadProxyExport, fetchSettings, testNineRouterConnection, updateSettings } from "@/lib/api";
import { isAbortError } from "@/lib/request-lifecycle";
import type { AppSettingsPublic, NineRouterTestResult, SettingsMeta, SettingsUpdatePayload } from "@/lib/types";
import { WireGuardSettingsCard } from "@/components/nodes/wireguard-settings";
import type { FleetWireGuardSettings } from "@/proxyfleet/wireguard";
type FormState = {
  nineRouterUrl: string;
  nineRouterPassword: string;
  nineRouterApiKey: string;
  nineRouterAutoSync: boolean;
  activePoolLimit: string;
  nineRouterSyncMinutes: string;
  checkConcurrency: string;
  checkTimeoutMs: string;
  proxyTtlMinutes: string;
  antigravityRotatorEnabled: boolean;
  antigravityActiveLimit: string;
  antigravityRotateMinutes: string;
  antigravitySessionThreshold: string;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

function toForm(settings: AppSettingsPublic): FormState {
  return {
    nineRouterUrl: settings.nineRouterUrl,
    nineRouterPassword: "",
    nineRouterApiKey: "",
    nineRouterAutoSync: settings.nineRouterAutoSync !== false,
    activePoolLimit: String(settings.activePoolLimit),
    nineRouterSyncMinutes: String(settings.nineRouterSyncMinutes),
    checkConcurrency: String(settings.checkConcurrency),
    checkTimeoutMs: String(settings.checkTimeoutMs),
    proxyTtlMinutes: String(settings.proxyTtlMinutes),
    antigravityRotatorEnabled: settings.antigravityRotatorEnabled !== false,
    antigravityActiveLimit: String(settings.antigravityActiveLimit ?? 3),
    antigravityRotateMinutes: String(settings.antigravityRotateMinutes ?? 10),
    antigravitySessionThreshold: String(settings.antigravitySessionThreshold ?? 20),
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  };
}

export default function SettingsPage() {
  const { password, authenticated } = useAuth();
  const [meta, setMeta] = useState<SettingsMeta | null>(null);
  const [flags, setFlags] = useState({ controlPasswordSet: false, nineRouterPasswordSet: false, nineRouterApiKeySet: false });
  const [form, setForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingSection, setSavingSection] = useState<"access" | "ninerouter" | "sync" | "antigravity" | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<NineRouterTestResult | null>(null);
  const [exporting, setExporting] = useState<"txt" | "csv" | null>(null);
  const [includeCredentials, setIncludeCredentials] = useState(false);
  const [fleetWireguard, setFleetWireguard] = useState<FleetWireGuardSettings | null | undefined>(undefined);

  const isSaving = savingSection !== null;
  const isActionPending = isSaving || testing || exporting !== null;

  async function handleExport(format: "txt" | "csv") {
    if ((!password && !authenticated) || isActionPending) {
      if (!password && !authenticated) toast.error("Not authenticated");
      return;
    }
    if (includeCredentials) {
      const confirmed = window.confirm(
        "Export proxies with plaintext credentials? Anyone with access to this file will have full proxy authentication access."
      );
      if (!confirmed) return;
    }
    setExporting(format);
    try {
      const { blob, filename } = password
        ? await downloadProxyExport(password, format, includeCredentials)
        : await downloadProxyExport(format, includeCredentials);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`Exported ${filename}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setExporting(null);
    }
  }

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!password && !authenticated) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchSettings(password, signal);
      if (signal?.aborted) return;
      setMeta(data.meta);
      setFlags({
        controlPasswordSet: data.settings.controlPasswordSet,
        nineRouterPasswordSet: data.settings.nineRouterPasswordSet,
        nineRouterApiKeySet: data.settings.nineRouterApiKeySet,
      });
      setForm(toForm(data.settings));
      setFleetWireguard(data.settings.fleetWireguard ?? null);
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) return;
      const message = (error as Error).message || "Failed to load configuration";
      setLoadError(message);
      toast.error(message);
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, [password, authenticated]);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    const controller = new AbortController();
    abortRef.current = controller;

    void load(controller.signal);
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, [load]);

  function patchForm<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  }

  async function handleSave(section: "access" | "ninerouter" | "sync" | "antigravity") {
    if ((!password && !authenticated) || !form || isActionPending) return;
    setSavingSection(section);
    try {
      const payload: SettingsUpdatePayload = {};

      if (section === "access") {
        if (form.newPassword || form.confirmPassword || form.currentPassword) {
          if (!form.currentPassword) throw new Error("Enter your current control password");
          if (!form.newPassword) throw new Error("Enter a new control password");
          if (form.newPassword !== form.confirmPassword) throw new Error("New passwords do not match");
          payload.currentPassword = form.currentPassword;
          payload.controlPassword = form.newPassword;
        } else {
          toast.message("No password changes to save");
          setSavingSection(null);
          return;
        }
      }

      if (section === "ninerouter") {
        const trimmedUrl = form.nineRouterUrl.trim();
        if (!trimmedUrl) throw new Error("9Router URL cannot be empty");
        payload.nineRouterUrl = trimmedUrl;
        if (form.nineRouterPassword.trim()) payload.nineRouterPassword = form.nineRouterPassword;
        if (form.nineRouterApiKey.trim()) payload.nineRouterApiKey = form.nineRouterApiKey.trim();
      }

      if (section === "sync") {
        payload.activePoolLimit = Number(form.activePoolLimit);
        payload.nineRouterAutoSync = form.nineRouterAutoSync;
        payload.nineRouterSyncMinutes = Number(form.nineRouterSyncMinutes);
        payload.checkConcurrency = Number(form.checkConcurrency);
        payload.checkTimeoutMs = Number(form.checkTimeoutMs);
        payload.proxyTtlMinutes = Number(form.proxyTtlMinutes);
      }

      if (section === "antigravity") {
        const activeLimit = Number(form.antigravityActiveLimit);
        if (Number.isNaN(activeLimit) || activeLimit < 1) {
          throw new Error("Concurrent active accounts must be at least 1");
        }
        const rotateMinutes = Number(form.antigravityRotateMinutes);
        if (Number.isNaN(rotateMinutes) || rotateMinutes < 1) {
          throw new Error("Rotation interval must be at least 1 minute");
        }
        const sessionThreshold = Number(form.antigravitySessionThreshold);
        if (Number.isNaN(sessionThreshold) || sessionThreshold < 5 || sessionThreshold > 50) {
          throw new Error("Session quota threshold must be between 5% and 50%");
        }
        payload.antigravityRotatorEnabled = form.antigravityRotatorEnabled;
        payload.antigravityActiveLimit = activeLimit;
        payload.antigravityRotateMinutes = rotateMinutes;
        payload.antigravitySessionThreshold = sessionThreshold;
      }

      const data = await updateSettings(password, payload);
      setMeta(data.meta);
      setFlags({
        controlPasswordSet: data.settings.controlPasswordSet,
        nineRouterPasswordSet: data.settings.nineRouterPasswordSet,
        nineRouterApiKeySet: data.settings.nineRouterApiKeySet,
      });
      setForm((current) =>
        current
          ? {
              ...toForm(data.settings),
              nineRouterPassword: "",
              nineRouterApiKey: "",
              currentPassword: "",
              newPassword: "",
              confirmPassword: "",
            }
          : current
      );

      if (payload.controlPassword) {
        toast.success("Control password updated — sign in again with the new password");
      } else {
        toast.success("Settings saved");
      }
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSavingSection(null);
    }
  }

  async function handleTestConnection() {
    if ((!password && !authenticated) || !form || isActionPending) return;
    setTesting(true);
    setTestResult(null);
    try {
      const trimmedUrl = form.nineRouterUrl.trim();
      if (!trimmedUrl) throw new Error("Enter 9Router URL to test connection");
      const result = await testNineRouterConnection(password, {
        nineRouterUrl: trimmedUrl,
        nineRouterPassword: form.nineRouterPassword.trim() || undefined,
        nineRouterApiKey: form.nineRouterApiKey.trim() || undefined,
      });
      setTestResult(result);
      if (result.ok) toast.success(`Connected — ${result.poolCount} pools found`);
      else toast.error(result.error || "Connection failed");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setTesting(false);
    }
  }

  if (loading && !form) {
    return (
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>Loading configuration…</p>
        </div>
      </div>
    );
  }

  if (loadError && !form) {
    return (
      <div className="space-y-6">
        <div className="page-header">
          <div>
            <h1>Settings</h1>
            <p>Runtime configuration</p>
          </div>
        </div>
        <Alert variant="destructive" className="max-w-xl">
          <AlertTitle>Failed to load configuration</AlertTitle>
          <AlertDescription className="space-y-3 pt-2">
            <p>{loadError}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-[44px] sm:min-h-8"
              onClick={() => void load()}
            >
              Retry loading
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!form) {
    return (
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>Sign in to view and edit settings</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>Runtime configuration — changes apply without editing <code className="mono">.env</code></p>
        </div>
      </div>

      {loadError && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Configuration refresh failed</AlertTitle>
          <AlertDescription className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
            <span>{loadError}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-[44px] sm:min-h-8 shrink-0 w-full sm:w-auto"
              onClick={() => load()}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="settings-layout">
        <Card className="settings-card">
          <CardHeader>
            <CardTitle>Dashboard access</CardTitle>
            <CardDescription>Change the control password used to sign in to this dashboard.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldSet>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="current-password">Current password</FieldLabel>
                  <FieldContent>
                    <Input
                      id="current-password"
                      type="password"
                      autoComplete="current-password"
                      value={form.currentPassword}
                      onChange={(event) => patchForm("currentPassword", event.target.value)}
                    />
                  </FieldContent>
                </Field>
                <Field>
                  <FieldLabel htmlFor="new-password">New password</FieldLabel>
                  <FieldContent>
                    <Input
                      id="new-password"
                      type="password"
                      autoComplete="new-password"
                      value={form.newPassword}
                      onChange={(event) => patchForm("newPassword", event.target.value)}
                    />
                  </FieldContent>
                </Field>
                <Field>
                  <FieldLabel htmlFor="confirm-password">Confirm new password</FieldLabel>
                  <FieldContent>
                    <Input
                      id="confirm-password"
                      type="password"
                      autoComplete="new-password"
                      value={form.confirmPassword}
                      onChange={(event) => patchForm("confirmPassword", event.target.value)}
                    />
                  </FieldContent>
                </Field>
              </FieldGroup>
              <div className="pt-2">
                <Button
                  type="button"
                  className="min-h-[44px] sm:min-h-9 w-full sm:w-auto"
                  disabled={(!password && !authenticated) || isActionPending}
                  onClick={() => handleSave("access")}
                >
                  {savingSection === "access" ? "Updating password…" : "Update password"}
                </Button>
                <FieldDescription className="mt-1.5">
                  Saves control password only. Requires re-login after update.
                </FieldDescription>
              </div>
            </FieldSet>
          </CardContent>
        </Card>

        <Card className="settings-card">
          <CardHeader>
            <CardTitle>9Router connection</CardTitle>
            <CardDescription>Credentials for syncing proxy pools from your 9Router instance.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldSet>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="ninerouter-url">9Router URL</FieldLabel>
                  <FieldContent>
                    <Input
                      id="ninerouter-url"
                      type="text"
                      inputMode="url"
                      placeholder="e.g. http://127.0.0.1:20128 or https://9router.minhmice.com"
                      value={form.nineRouterUrl}
                      onChange={(event) => patchForm("nineRouterUrl", event.target.value)}
                    />
                    <FieldDescription>
                      Endpoint URL of your 9Router instance (supports http://, https://, or IP:port).
                    </FieldDescription>
                  </FieldContent>
                </Field>
                <Field>
                  <FieldLabel htmlFor="ninerouter-password">Dashboard password</FieldLabel>
                  <FieldContent>
                    <Input
                      id="ninerouter-password"
                      type="password"
                      placeholder={flags.nineRouterPasswordSet ? "••••••••" : "Required for sync"}
                      value={form.nineRouterPassword}
                      onChange={(event) => patchForm("nineRouterPassword", event.target.value)}
                    />
                    <FieldDescription>Leave blank to keep the saved password.</FieldDescription>
                  </FieldContent>
                </Field>
                <Field>
                  <FieldLabel htmlFor="ninerouter-api-key">API key (optional)</FieldLabel>
                  <FieldContent>
                    <Input
                      id="ninerouter-api-key"
                      type="password"
                      placeholder={flags.nineRouterApiKeySet ? "••••••••" : "Usually not needed for pool sync"}
                      value={form.nineRouterApiKey}
                      onChange={(event) => patchForm("nineRouterApiKey", event.target.value)}
                    />
                  </FieldContent>
                </Field>
              </FieldGroup>
              <div className="pt-2">
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    className="min-h-[44px] sm:min-h-9"
                    disabled={(!password && !authenticated) || isActionPending}
                    onClick={handleTestConnection}
                  >
                    {testing ? "Testing…" : "Test connection"}
                  </Button>
                  <Button
                    type="button"
                    className="min-h-[44px] sm:min-h-9"
                    disabled={(!password && !authenticated) || isActionPending}
                    onClick={() => handleSave("ninerouter")}
                  >
                    {savingSection === "ninerouter" ? "Saving 9Router…" : "Save 9Router"}
                  </Button>
                </div>
                <FieldDescription className="mt-1.5">
                  Saves 9Router endpoint and authentication only. Does not alter sync schedules or rotator settings.
                </FieldDescription>
              </div>
              {testResult && (
                <p className="settings-test-result" role="status" aria-live="polite">
                  {testResult.ok
                    ? `Connected — ${testResult.poolCount} proxy pools available`
                    : `Failed — ${testResult.error}`}
                </p>
              )}
            </FieldSet>
          </CardContent>
        </Card>

        <Card className="settings-card">
          <CardHeader>
            <CardTitle>Sync and health checks</CardTitle>
            <CardDescription>Control how often pools sync and how proxies are checked.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldSet>
              <FieldLegend>Pool sync</FieldLegend>
              <FieldGroup>
                <div className="flex flex-row items-center justify-between rounded-lg border p-3 shadow-xs">
                  <div className="space-y-0.5 pr-4">
                    <FieldLabel htmlFor="auto-sync" className="cursor-pointer">Automatic pool sync</FieldLabel>
                    <FieldDescription>Run scheduled background sync and refresh stale pools.</FieldDescription>
                  </div>
                  <Switch
                    id="auto-sync"
                    checked={form.nineRouterAutoSync}
                    onCheckedChange={(checked) => patchForm("nineRouterAutoSync", checked)}
                  />
                </div>
                <Field>
                  <FieldLabel htmlFor="active-limit">Active pool limit</FieldLabel>
                  <FieldContent>
                    <Input
                      id="active-limit"
                      type="number"
                      min={1}
                      max={200}
                      value={form.activePoolLimit}
                      onChange={(event) => patchForm("activePoolLimit", event.target.value)}
                    />
                  </FieldContent>
                </Field>
                <Field>
                  <FieldLabel htmlFor="sync-minutes">Auto-sync interval (minutes)</FieldLabel>
                  <FieldContent>
                    <Input
                      id="sync-minutes"
                      min={1}
                      max={1440}
                      disabled={!form.nineRouterAutoSync}
                      value={form.nineRouterSyncMinutes}
                      onChange={(event) => patchForm("nineRouterSyncMinutes", event.target.value)}
                    />
                    {!form.nineRouterAutoSync && (
                      <FieldDescription>Automatic background sync is currently paused.</FieldDescription>
                    )}
                  </FieldContent>
                </Field>
              </FieldGroup>
              <FieldLegend>Health checks</FieldLegend>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="check-concurrency">Check concurrency</FieldLabel>
                  <FieldContent>
                    <Input
                      id="check-concurrency"
                      type="number"
                      min={1}
                      max={50}
                      value={form.checkConcurrency}
                      onChange={(event) => patchForm("checkConcurrency", event.target.value)}
                    />
                    <FieldDescription>Higher is faster but uses more connections.</FieldDescription>
                  </FieldContent>
                </Field>
                <Field>
                  <FieldLabel htmlFor="check-timeout">Check timeout (ms)</FieldLabel>
                  <FieldContent>
                    <Input
                      id="check-timeout"
                      type="number"
                      min={2000}
                      max={30000}
                      step={500}
                      value={form.checkTimeoutMs}
                      onChange={(event) => patchForm("checkTimeoutMs", event.target.value)}
                    />
                    <FieldDescription>Dead proxies wait up to this long before failing.</FieldDescription>
                  </FieldContent>
                </Field>
                <Field>
                  <FieldLabel htmlFor="proxy-ttl">Input proxy TTL (minutes)</FieldLabel>
                  <FieldContent>
                    <Input
                      id="proxy-ttl"
                      type="number"
                      min={1}
                      max={1440}
                      value={form.proxyTtlMinutes}
                      onChange={(event) => patchForm("proxyTtlMinutes", event.target.value)}
                    />
                    <FieldDescription>Re-check interval for legacy <code className="mono">input/</code> lists.</FieldDescription>
                  </FieldContent>
                </Field>
              </FieldGroup>
              <div className="pt-2">
                <Button
                  type="button"
                  className="min-h-[44px] sm:min-h-9 w-full sm:w-auto"
                  disabled={(!password && !authenticated) || isActionPending}
                  onClick={() => handleSave("sync")}
                >
                  {savingSection === "sync" ? "Saving sync settings…" : "Save sync settings"}
                </Button>
                <FieldDescription className="mt-1.5">
                  Saves automatic pool sync, active pool limit, and health check timeouts.
                </FieldDescription>
              </div>
            </FieldSet>
          </CardContent>
        </Card>
        <Card className="settings-card">
          <CardHeader>
            <CardTitle>Antigravity Account Rotator</CardTitle>
            <CardDescription>
              Automatically rotate 9Router Antigravity accounts based on Gemini session quota. Accounts at or below the configured session threshold are turned off; standby accounts above threshold are activated by earliest reset time.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldSet>
              <FieldGroup>
                <div className="flex flex-row items-center justify-between rounded-lg border p-3 shadow-xs">
                  <div className="space-y-0.5 pr-4">
                    <FieldLabel htmlFor="ag-rotator-toggle" className="cursor-pointer">
                      Automatic account rotation
                    </FieldLabel>
                    <FieldDescription>
                      Turn off accounts when Gemini session quota ≤ {form.antigravitySessionThreshold || "20"}%. Promote standby accounts with session quota &gt; {form.antigravitySessionThreshold || "20"}% by earliest reset time (maintains up to {form.antigravityActiveLimit || "3"} active). Claude, GPT, and weekly quotas are informational only.
                    </FieldDescription>
                  </div>
                  <Switch
                    id="ag-rotator-toggle"
                    checked={form.antigravityRotatorEnabled}
                    onCheckedChange={(checked) => patchForm("antigravityRotatorEnabled", checked)}
                  />
                </div>

                <Field>
                  <FieldLabel htmlFor="ag-active-limit">Concurrent active accounts</FieldLabel>
                  <FieldContent>
                    <Input
                      id="ag-active-limit"
                      type="number"
                      min={1}
                      max={10}
                      value={form.antigravityActiveLimit}
                      onChange={(event) => patchForm("antigravityActiveLimit", event.target.value)}
                    />
                    <FieldDescription>Maximum number of Antigravity accounts active simultaneously (configured: {form.antigravityActiveLimit || "3"}, default 3).</FieldDescription>
                  </FieldContent>
                </Field>

                <Field>
                  <FieldLabel htmlFor="ag-rotate-minutes">Rotation interval (minutes)</FieldLabel>
                  <FieldContent>
                    <Input
                      id="ag-rotate-minutes"
                      type="number"
                      min={1}
                      max={60}
                      disabled={!form.antigravityRotatorEnabled}
                      value={form.antigravityRotateMinutes}
                      onChange={(event) => patchForm("antigravityRotateMinutes", event.target.value)}
                    />
                    <FieldDescription>How often the background daemon checks quotas and rotates accounts (default 10m).</FieldDescription>
                  </FieldContent>
                </Field>

                <Field>
                  <FieldLabel htmlFor="ag-session-threshold">Session quota threshold (%)</FieldLabel>
                  <FieldContent>
                    <Input
                      id="ag-session-threshold"
                      type="number"
                      min={5}
                      max={50}
                      value={form.antigravitySessionThreshold}
                      onChange={(event) => patchForm("antigravitySessionThreshold", event.target.value)}
                    />
                    <FieldDescription>Accounts with Gemini session quota ≤ this configured percentage (currently {form.antigravitySessionThreshold || "20"}%) are deactivated. Standby accounts with quota &gt; this threshold are eligible for activation in order of earliest reset time (default 20%).</FieldDescription>
                  </FieldContent>
                </Field>
              </FieldGroup>

              <div className="pt-2">
                <Button
                  type="button"
                  className="min-h-[44px] sm:min-h-9 w-full sm:w-auto"
                  disabled={(!password && !authenticated) || isActionPending}
                  onClick={() => handleSave("antigravity")}
                >
                  {savingSection === "antigravity" ? "Saving rotator settings…" : "Save rotator settings"}
                </Button>
                <FieldDescription className="mt-1.5">
                  Saves rotator toggle, active accounts limit, rotation interval, and Gemini session threshold.
                </FieldDescription>
              </div>
            </FieldSet>
          </CardContent>
        </Card>
        <Card className="settings-card">
          <CardHeader>
            <CardTitle>Export Working Proxies</CardTitle>
            <CardDescription>
              Export verified proxies that strictly passed safety audit (PASS, reliability ≥ 90%, no critical risks, audited within 24h).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4 text-xs">
              <div className="flex items-start gap-3">
                <Checkbox
                  id="include-creds-toggle"
                  checked={includeCredentials}
                  onCheckedChange={(checked) => setIncludeCredentials(checked === true)}
                />
                <div className="space-y-1">
                  <label
                    htmlFor="include-creds-toggle"
                    className="font-medium text-xs text-foreground cursor-pointer"
                  >
                    Include credentials in output
                  </label>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    Credentials are off by default to prevent accidental plaintext disclosure.
                  </p>
                </div>
              </div>

              {includeCredentials && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs space-y-1 text-amber-200">
                  <p className="font-semibold text-amber-400">Plaintext credentials warning</p>
                  <p className="text-[11px] text-amber-300/90 leading-relaxed">
                    The exported file will contain unencrypted credentials. Anyone who obtains this file can authenticate through these proxies.
                  </p>
                </div>
              )}

              <div className="pt-1">
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="min-h-[44px] sm:min-h-8"
                    disabled={(!password && !authenticated) || isActionPending}
                    onClick={() => handleExport("txt")}
                  >
                    {exporting === "txt" ? "Exporting…" : "Download .txt (URLs)"}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="min-h-[44px] sm:min-h-8"
                    disabled={(!password && !authenticated) || isActionPending}
                    onClick={() => handleExport("csv")}
                  >
                    {exporting === "csv" ? "Exporting…" : "Download .csv"}
                  </Button>
                </div>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  Exports safety-audited proxies currently stored in database. Does not modify server settings.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        <WireGuardSettingsCard
          initialSettings={fleetWireguard}
          onSettingsSaved={(saved) => setFleetWireguard(saved)}
        />
      </div>

      <p className="settings-footnote">
        Config source: <strong>{meta?.source === "settings" ? "data/settings.json" : ".env bootstrap"}</strong>
        {flags.controlPasswordSet ? "" : " — set a control password to secure the dashboard"}
      </p>
    </>
  );
}
