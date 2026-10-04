"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { downloadProxyExport, fetchSettings, testNineRouterConnection, updateSettings } from "@/lib/api";
import { Switch } from "@/components/ui/switch";
import type { AppSettingsPublic, NineRouterTestResult, SettingsMeta, SettingsUpdatePayload } from "@/lib/types";
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
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<NineRouterTestResult | null>(null);
  const [exporting, setExporting] = useState<"txt" | "csv" | null>(null);

  async function handleExport(format: "txt" | "csv") {
    if (!password && !authenticated) {
      toast.error("Not authenticated");
      return;
    }
    setExporting(format);
    const withCreds = (document.getElementById("include-creds-toggle") as HTMLInputElement)?.checked;
    try {
      const { blob, filename } = await downloadProxyExport(password, format, withCreds);
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

  const load = useCallback(async () => {
    if (!password && !authenticated) {
      setLoading(false);
      return;
    }
    try {
      const data = await fetchSettings(password);
      setMeta(data.meta);
      setFlags({
        controlPasswordSet: data.settings.controlPasswordSet,
        nineRouterPasswordSet: data.settings.nineRouterPasswordSet,
        nineRouterApiKeySet: data.settings.nineRouterApiKeySet,
      });
      setForm(toForm(data.settings));
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [password, authenticated]);

  useEffect(() => {
    load();
  }, [load]);

  function patchForm<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  }

  async function handleSave(section: "access" | "ninerouter" | "sync" | "antigravity") {
    if ((!password && !authenticated) || !form) return;
    setSaving(true);
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
          setSaving(false);
          return;
        }
      }

      if (section === "ninerouter") {
        payload.nineRouterUrl = form.nineRouterUrl;
        if (form.nineRouterPassword.trim()) payload.nineRouterPassword = form.nineRouterPassword;
        payload.nineRouterApiKey = form.nineRouterApiKey.trim();
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
        payload.antigravityRotatorEnabled = form.antigravityRotatorEnabled;
        payload.antigravityActiveLimit = Number(form.antigravityActiveLimit);
        payload.antigravityRotateMinutes = Number(form.antigravityRotateMinutes);
        payload.antigravitySessionThreshold = Number(form.antigravitySessionThreshold);
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
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    if ((!password && !authenticated) || !form) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testNineRouterConnection(password, {
        nineRouterUrl: form.nineRouterUrl,
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

  if (loading || !form) {
    return (
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>Loading configuration…</p>
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
              <Button type="button" disabled={(!password && !authenticated) || saving} onClick={() => handleSave("access")}>
                Update password
              </Button>
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
                  <FieldLabel htmlFor="ninerouter-url">Base URL</FieldLabel>
                  <FieldContent>
                    <Input
                      id="ninerouter-url"
                      type="url"
                      value={form.nineRouterUrl}
                      onChange={(event) => patchForm("nineRouterUrl", event.target.value)}
                    />
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
              <div className="settings-actions">
                <Button type="button" variant="secondary" disabled={(!password && !authenticated) || testing} onClick={handleTestConnection}>
                  {testing ? "Testing…" : "Test connection"}
                </Button>
                <Button type="button" disabled={(!password && !authenticated) || saving} onClick={() => handleSave("ninerouter")}>
                  Save 9Router
                </Button>
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
                <Field className="flex flex-row items-center justify-between rounded-lg border p-3 shadow-xs">
                  <div className="space-y-0.5">
                    <FieldLabel htmlFor="auto-sync" className="cursor-pointer">Automatic pool sync</FieldLabel>
                    <FieldDescription>Run scheduled background sync and refresh stale pools.</FieldDescription>
                  </div>
                  <Switch
                    id="auto-sync"
                    checked={form.nineRouterAutoSync}
                    onCheckedChange={(checked) => patchForm("nineRouterAutoSync", checked)}
                  />
                </Field>
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
              <Button type="button" disabled={(!password && !authenticated) || saving} onClick={() => handleSave("sync")}>
                Save sync settings
              </Button>
            </FieldSet>
          </CardContent>
        </Card>
        <Card className="settings-card">
          <CardHeader>
            <CardTitle>Antigravity Account Rotator</CardTitle>
            <CardDescription>
              Automatically rotate 9Router Antigravity accounts when Gemini session quota falls below threshold, enforcing safe proxy multiplexing.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldSet>
              <FieldGroup>
                <Field className="flex flex-row items-center justify-between rounded-lg border p-3 shadow-xs">
                  <div className="space-y-0.5">
                    <FieldLabel htmlFor="ag-rotator-toggle" className="cursor-pointer">
                      Automatic account rotation
                    </FieldLabel>
                    <FieldDescription>
                      Turn OFF accounts when Gemini session ≤ threshold, promote accounts with lowest reset window.
                    </FieldDescription>
                  </div>
                  <Switch
                    id="ag-rotator-toggle"
                    checked={form.antigravityRotatorEnabled}
                    onCheckedChange={(checked) => patchForm("antigravityRotatorEnabled", checked)}
                  />
                </Field>

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
                    <FieldDescription>Maximum number of Antigravity accounts active simultaneously (default 3).</FieldDescription>
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
                    <FieldDescription>Accounts with Gemini session quota ≤ this percentage are turned off (default 20%).</FieldDescription>
                  </FieldContent>
                </Field>
              </FieldGroup>

              <Button
                type="button"
                disabled={(!password && !authenticated) || saving}
                onClick={() => handleSave("antigravity")}
              >
                Save rotator settings
              </Button>
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
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" id="include-creds-toggle" className="rounded border-input" />
                  <span>Include credentials in output</span>
                </label>
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={(!password && !authenticated) || exporting !== null}
                  onClick={() => handleExport("txt")}
                >
                  {exporting === "txt" ? "Exporting…" : "Download .txt (URLs)"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={(!password && !authenticated) || exporting !== null}
                  onClick={() => handleExport("csv")}
                >
                  {exporting === "csv" ? "Exporting…" : "Download .csv"}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <p className="settings-footnote">
        Config source: <strong>{meta?.source === "settings" ? "data/settings.json" : ".env bootstrap"}</strong>
        {flags.controlPasswordSet ? "" : " — set a control password to secure the dashboard"}
      </p>
    </>
  );
}
