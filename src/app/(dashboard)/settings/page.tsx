'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Cpu,
  Download,
  HelpCircle,
  KeyRound,
  Loader2,
  Lock,
  Network,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  Sliders,
} from 'lucide-react';
import { useAuth } from '@/components/auth-provider';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { motion, useReducedMotion } from 'motion/react';
import {
  downloadProxyExport,
  fetchSettings,
  testNineRouterConnection,
  updateSettings,
} from '@/lib/api';
import { isAbortError } from '@/lib/request-lifecycle';
import { cn } from '@/lib/utils';
import type {
  AppSettingsPublic,
  NineRouterTestResult,
  SettingsMeta,
  SettingsUpdatePayload,
} from '@/lib/types';
import { WireGuardSettingsCard } from '@/components/nodes/wireguard-settings';
import type { FleetWireGuardSettings } from '@/proxyfleet/wireguard';

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
    nineRouterPassword: '',
    nineRouterApiKey: '',
    nineRouterAutoSync: settings.nineRouterAutoSync !== false,
    activePoolLimit: String(settings.activePoolLimit),
    nineRouterSyncMinutes: String(settings.nineRouterSyncMinutes),
    checkConcurrency: String(settings.checkConcurrency),
    checkTimeoutMs: String(settings.checkTimeoutMs),
    proxyTtlMinutes: String(settings.proxyTtlMinutes),
    antigravityRotatorEnabled: settings.antigravityRotatorEnabled !== false,
    antigravityActiveLimit: String(settings.antigravityActiveLimit ?? 3),
    antigravityRotateMinutes: String(settings.antigravityRotateMinutes ?? 10),
    antigravitySessionThreshold: String(
      settings.antigravitySessionThreshold ?? 20,
    ),
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  };
}

function FieldInfo({ content }: { content: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="More information"
          className="inline-flex items-center text-muted-foreground/70 hover:text-foreground transition-colors cursor-help p-0.5 focus-visible:ring-1 focus-visible:ring-primary rounded-sm"
        >
          <HelpCircle className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" className="max-w-xs text-xs">
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

export default function SettingsPage() {
  const { password, authenticated } = useAuth();
  const [meta, setMeta] = useState<SettingsMeta | null>(null);
  const [flags, setFlags] = useState({
    controlPasswordSet: false,
    nineRouterPasswordSet: false,
    nineRouterApiKeySet: false,
  });
  const [form, setForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedTab, setSelectedTab] = useState('ninerouter');
  const isReduced = useReducedMotion();
  const [savingSection, setSavingSection] = useState<
    'access' | 'ninerouter' | 'sync' | 'antigravity' | null
  >(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<NineRouterTestResult | null>(
    null,
  );
  const [exporting, setExporting] = useState<'txt' | 'csv' | null>(null);
  const [includeCredentials, setIncludeCredentials] = useState(false);
  const [fleetWireguard, setFleetWireguard] = useState<
    FleetWireGuardSettings | null | undefined
  >(undefined);

  const isSaving = savingSection !== null;
  const isActionPending = isSaving || testing || exporting !== null;

  async function handleExport(format: 'txt' | 'csv') {
    if ((!password && !authenticated) || isActionPending) {
      if (!password && !authenticated) toast.error('Not authenticated');
      return;
    }
    if (includeCredentials) {
      const confirmed = window.confirm(
        'Export proxies with plaintext credentials? Anyone with access to this file will have full proxy authentication access.',
      );
      if (!confirmed) return;
    }
    setExporting(format);
    try {
      const { blob, filename } = password
        ? await downloadProxyExport(password, format, includeCredentials)
        : await downloadProxyExport(format, includeCredentials);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
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

  const load = useCallback(
    async (signal?: AbortSignal) => {
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
        const message =
          (error as Error).message || 'Failed to load configuration';
        setLoadError(message);
        toast.error(message);
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [password, authenticated],
  );

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

  async function handleSave(
    section: 'access' | 'ninerouter' | 'sync' | 'antigravity',
  ) {
    if ((!password && !authenticated) || !form || isActionPending) return;
    setSavingSection(section);
    try {
      const payload: SettingsUpdatePayload = {};

      if (section === 'access') {
        if (form.newPassword || form.confirmPassword || form.currentPassword) {
          if (!form.currentPassword)
            throw new Error('Enter current control password');
          if (!form.newPassword) throw new Error('Enter new control password');
          if (form.newPassword !== form.confirmPassword)
            throw new Error('Passwords do not match');
          payload.currentPassword = form.currentPassword;
          payload.controlPassword = form.newPassword;
        } else {
          toast.message('No password changes to save');
          setSavingSection(null);
          return;
        }
      }

      if (section === 'ninerouter') {
        const trimmedUrl = form.nineRouterUrl.trim();
        if (!trimmedUrl) throw new Error('9Router URL cannot be empty');
        payload.nineRouterUrl = trimmedUrl;
        if (form.nineRouterPassword.trim())
          payload.nineRouterPassword = form.nineRouterPassword;
        if (form.nineRouterApiKey.trim())
          payload.nineRouterApiKey = form.nineRouterApiKey.trim();
      }

      if (section === 'sync') {
        payload.activePoolLimit = Number(form.activePoolLimit);
        payload.nineRouterAutoSync = form.nineRouterAutoSync;
        payload.nineRouterSyncMinutes = Number(form.nineRouterSyncMinutes);
        payload.checkConcurrency = Number(form.checkConcurrency);
        payload.checkTimeoutMs = Number(form.checkTimeoutMs);
        payload.proxyTtlMinutes = Number(form.proxyTtlMinutes);
      }

      if (section === 'antigravity') {
        const activeLimit = Number(form.antigravityActiveLimit);
        if (Number.isNaN(activeLimit) || activeLimit < 1) {
          throw new Error('Active accounts limit must be at least 1');
        }
        const rotateMinutes = Number(form.antigravityRotateMinutes);
        if (Number.isNaN(rotateMinutes) || rotateMinutes < 1) {
          throw new Error('Rotation interval must be at least 1 minute');
        }
        const sessionThreshold = Number(form.antigravitySessionThreshold);
        if (
          Number.isNaN(sessionThreshold) ||
          sessionThreshold < 5 ||
          sessionThreshold > 50
        ) {
          throw new Error('Session quota threshold must be 5% - 50%');
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
              nineRouterPassword: '',
              nineRouterApiKey: '',
              currentPassword: '',
              newPassword: '',
              confirmPassword: '',
            }
          : current,
      );

      if (payload.controlPassword) {
        toast.success('Password updated — please sign in again');
      } else {
        toast.success('Settings saved');
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
      if (!trimmedUrl) throw new Error('Enter 9Router URL to test connection');
      const result = await testNineRouterConnection(password, {
        nineRouterUrl: trimmedUrl,
        nineRouterPassword: form.nineRouterPassword.trim() || undefined,
        nineRouterApiKey: form.nineRouterApiKey.trim() || undefined,
      });
      setTestResult(result);
      if (result.ok) toast.success(`Connected (${result.poolCount} pools)`);
      else toast.error(result.error || 'Connection failed');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setTesting(false);
    }
  }

  if (loading && !form) {
    return (
      <div className="space-y-6 max-w-5xl">
        <div className="space-y-2">
          <Skeleton className="h-8 w-44 rounded-md" />
          <Skeleton className="h-4 w-72 rounded-md" />
        </div>
        <Skeleton className="h-12 w-full rounded-xl" />
        <Card>
          <CardHeader className="space-y-2">
            <Skeleton className="h-6 w-40 rounded-md" />
            <Skeleton className="h-4 w-64 rounded-md" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-9 w-full rounded-md" />
            <Skeleton className="h-9 w-full rounded-md" />
          </CardContent>
          <CardFooter className="border-t py-3">
            <Skeleton className="h-9 w-28 rounded-md" />
          </CardFooter>
        </Card>
      </div>
    );
  }

  if (loadError && !form) {
    return (
      <div className="space-y-6 max-w-3xl">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Settings
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Runtime configuration
          </p>
        </div>
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Failed to load configuration</AlertTitle>
          <AlertDescription className="space-y-3 pt-2">
            <p className="text-xs">{loadError}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void load()}
            >
              <RefreshCw className="size-3.5 mr-1.5" />
              Retry loading
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!form) {
    return (
      <div className="max-w-2xl">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Lock className="size-5 text-muted-foreground" />
              <CardTitle>Settings Restricted</CardTitle>
            </div>
            <CardDescription>
              Sign in with your control password to access configuration.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-6 w-full max-w-none 3xl:max-w-none 4xl:max-w-[3400px]">
        {/* Page Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              Settings
            </h1>
            <p className="text-xs text-muted-foreground mt-1">
              Runtime controls for 9Router pools, daemon rotations, health
              verification, and network mesh.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  className="font-mono text-xs py-1 px-2.5 cursor-help"
                >
                  Source: {meta?.source === 'settings' ? 'database' : '.env'}
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                Active config loaded from{' '}
                {meta?.source === 'settings'
                  ? 'data/settings.json'
                  : '.env bootstrap'}
              </TooltipContent>
            </Tooltip>

            {flags.controlPasswordSet ? (
              <Badge
                variant="secondary"
                className="text-xs py-1 px-2.5 text-emerald-400 bg-emerald-500/10 border border-emerald-500/20"
              >
                <ShieldCheck className="size-3.5 mr-1 text-emerald-400" />
                Protected
              </Badge>
            ) : (
              <Badge variant="destructive" className="text-xs py-1 px-2.5">
                <AlertCircle className="size-3.5 mr-1" />
                No Password
              </Badge>
            )}
          </div>
        </div>

        {loadError && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Refresh failed</AlertTitle>
            <AlertDescription className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
              <span className="text-xs">{loadError}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0 w-full sm:w-auto"
                onClick={() => void load()}
              >
                <RefreshCw className="size-3.5 mr-1.5" />
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {/* High-Contrast Clear Tabs Navigation */}
        <Tabs
          value={selectedTab}
          onValueChange={setSelectedTab}
          className="space-y-6"
        >
          <TabsList className="flex flex-wrap sm:flex-nowrap w-full h-auto p-1.5 bg-surface-raised border border-border rounded-xl gap-1.5 shadow-sm 3xl:p-2 3xl:max-w-4xl">
            <TabsTrigger
              value="ninerouter"
              className="relative flex-1 min-w-[130px] flex items-center justify-center gap-2 py-2.5 px-3 text-xs sm:text-sm font-semibold rounded-lg border border-transparent transition-colors text-muted-foreground hover:text-foreground z-10 data-[state=active]:text-primary-foreground"
            >
              {selectedTab === 'ninerouter' && (
                <motion.div
                  layoutId={isReduced ? undefined : 'settings-active-pill'}
                  className="absolute inset-0 rounded-lg bg-primary shadow-md shadow-primary/25 -z-10"
                  transition={{ type: 'spring', stiffness: 450, damping: 35 }}
                />
              )}
              <Server className="size-4 shrink-0" />
              <span>9Router</span>
            </TabsTrigger>

            <TabsTrigger
              value="sync"
              className="relative flex-1 min-w-[130px] flex items-center justify-center gap-2 py-2.5 px-3 text-xs sm:text-sm font-semibold rounded-lg border border-transparent transition-colors text-muted-foreground hover:text-foreground z-10 data-[state=active]:text-primary-foreground"
            >
              {selectedTab === 'sync' && (
                <motion.div
                  layoutId={isReduced ? undefined : 'settings-active-pill'}
                  className="absolute inset-0 rounded-lg bg-primary shadow-md shadow-primary/25 -z-10"
                  transition={{ type: 'spring', stiffness: 450, damping: 35 }}
                />
              )}
              <RefreshCw className="size-4 shrink-0" />
              <span>Sync & Health</span>
            </TabsTrigger>

            <TabsTrigger
              value="antigravity"
              className="relative flex-1 min-w-[130px] flex items-center justify-center gap-2 py-2.5 px-3 text-xs sm:text-sm font-semibold rounded-lg border border-transparent transition-colors text-muted-foreground hover:text-foreground z-10 data-[state=active]:text-primary-foreground"
            >
              {selectedTab === 'antigravity' && (
                <motion.div
                  layoutId={isReduced ? undefined : 'settings-active-pill'}
                  className="absolute inset-0 rounded-lg bg-primary shadow-md shadow-primary/25 -z-10"
                  transition={{ type: 'spring', stiffness: 450, damping: 35 }}
                />
              )}
              <Cpu className="size-4 shrink-0" />
              <span>Antigravity</span>
            </TabsTrigger>

            <TabsTrigger
              value="security"
              className="relative flex-1 min-w-[130px] flex items-center justify-center gap-2 py-2.5 px-3 text-xs sm:text-sm font-semibold rounded-lg border border-transparent transition-colors text-muted-foreground hover:text-foreground z-10 data-[state=active]:text-primary-foreground"
            >
              {selectedTab === 'security' && (
                <motion.div
                  layoutId={isReduced ? undefined : 'settings-active-pill'}
                  className="absolute inset-0 rounded-lg bg-primary shadow-md shadow-primary/25 -z-10"
                  transition={{ type: 'spring', stiffness: 450, damping: 35 }}
                />
              )}
              <ShieldCheck className="size-4 shrink-0" />
              <span>Security & Export</span>
            </TabsTrigger>

            <TabsTrigger
              value="wireguard"
              className="relative flex-1 min-w-[130px] flex items-center justify-center gap-2 py-2.5 px-3 text-xs sm:text-sm font-semibold rounded-lg border border-transparent transition-colors text-muted-foreground hover:text-foreground z-10 data-[state=active]:text-primary-foreground"
            >
              {selectedTab === 'wireguard' && (
                <motion.div
                  layoutId={isReduced ? undefined : 'settings-active-pill'}
                  className="absolute inset-0 rounded-lg bg-primary shadow-md shadow-primary/25 -z-10"
                  transition={{ type: 'spring', stiffness: 450, damping: 35 }}
                />
              )}
              <Network className="size-4 shrink-0" />
              <span>WireGuard</span>
            </TabsTrigger>
          </TabsList>

          {/* 1. 9ROUTER TAB */}
          <TabsContent value="ninerouter" className="space-y-6">
            <Card className="shadow-sm">
              <CardHeader>
                <div className="flex items-center gap-2.5">
                  <div className="p-2 rounded-lg bg-primary/10 text-primary border border-primary/20">
                    <Server className="size-4" />
                  </div>
                  <div>
                    <CardTitle className="text-base">
                      9Router Connection
                    </CardTitle>
                    <CardDescription>
                      Endpoint and credentials for syncing proxy pools.
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 3xl:grid-cols-12 gap-6 items-start">
                  <div className="3xl:col-span-8 space-y-4">
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-1.5">
                        <Label
                          htmlFor="ninerouter-url"
                          className="text-xs font-semibold"
                        >
                          Endpoint URL{' '}
                          <span className="text-destructive">*</span>
                        </Label>
                        <FieldInfo content="Host and port of your 9Router service (e.g. http://127.0.0.1:20128 or https://domain.com)" />
                      </div>
                      <Input
                        id="ninerouter-url"
                        type="text"
                        inputMode="url"
                        placeholder="http://127.0.0.1:20128"
                        value={form.nineRouterUrl}
                        onChange={(event) =>
                          patchForm('nineRouterUrl', event.target.value)
                        }
                        className="font-mono text-xs"
                      />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1.5">
                          <Label
                            htmlFor="ninerouter-password"
                            className="text-xs font-semibold"
                          >
                            Dashboard Password
                          </Label>
                          <FieldInfo content="Used to authenticate against 9Router sync endpoints. Leave blank to keep existing password." />
                        </div>
                        <Input
                          id="ninerouter-password"
                          type="password"
                          placeholder={
                            flags.nineRouterPasswordSet
                              ? '•••••••• (saved)'
                              : 'Enter password'
                          }
                          value={form.nineRouterPassword}
                          onChange={(event) =>
                            patchForm('nineRouterPassword', event.target.value)
                          }
                          className="text-xs"
                        />
                      </div>

                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1.5">
                          <Label
                            htmlFor="ninerouter-api-key"
                            className="text-xs font-semibold"
                          >
                            API Key (Optional)
                          </Label>
                          <FieldInfo content="Optional header token if your 9Router deployment enforces bearer/token authentication." />
                        </div>
                        <Input
                          id="ninerouter-api-key"
                          type="password"
                          placeholder={
                            flags.nineRouterApiKeySet
                              ? '•••••••• (saved)'
                              : 'Optional'
                          }
                          value={form.nineRouterApiKey}
                          onChange={(event) =>
                            patchForm('nineRouterApiKey', event.target.value)
                          }
                          className="text-xs"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="3xl:col-span-4 rounded-xl border border-border/70 bg-muted/20 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                        <Activity className="size-3.5 text-primary" />{' '}
                        Connection Diagnostic
                      </span>
                      {testResult?.ok && (
                        <Badge
                          variant="outline"
                          className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-[10px] py-0"
                        >
                          Live
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Verifies endpoint latency, 9Router protocol handshake, and
                      active pools.
                    </p>

                    {testResult ? (
                      <Alert
                        variant={testResult.ok ? 'default' : 'destructive'}
                        className={cn(
                          'py-2',
                          testResult.ok &&
                            'border-emerald-500/30 bg-emerald-500/10 text-emerald-300 [&>svg]:text-emerald-400',
                        )}
                      >
                        {testResult.ok ? (
                          <CheckCircle2 className="size-4" />
                        ) : (
                          <AlertCircle className="size-4" />
                        )}
                        <AlertTitle className="text-xs font-semibold">
                          {testResult.ok ? 'Connected' : 'Connection Failed'}
                        </AlertTitle>
                        <AlertDescription className="text-xs mt-0.5">
                          {testResult.ok
                            ? `Available pools: ${testResult.poolCount}`
                            : testResult.error ||
                              'Unable to reach 9Router endpoint'}
                        </AlertDescription>
                      </Alert>
                    ) : (
                      <div className="text-xs text-muted-foreground/75 font-mono p-2.5 rounded-lg border border-border/50 bg-background/50">
                        Ready for test check. Click &quot;Test connection&quot;
                        below.
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
              <CardFooter className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 border-t bg-muted/10 px-6 py-4">
                <span className="text-xs text-muted-foreground order-2 sm:order-1">
                  Updates endpoint and credentials immediately.
                </span>
                <div className="flex items-center gap-2 order-1 sm:order-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={(!password && !authenticated) || isActionPending}
                    onClick={handleTestConnection}
                  >
                    {testing ? (
                      <>
                        <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                        Testing…
                      </>
                    ) : (
                      'Test connection'
                    )}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={(!password && !authenticated) || isActionPending}
                    onClick={() => handleSave('ninerouter')}
                  >
                    {savingSection === 'ninerouter' ? (
                      <>
                        <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                        Saving…
                      </>
                    ) : (
                      'Save changes'
                    )}
                  </Button>
                </div>
              </CardFooter>
            </Card>
          </TabsContent>

          {/* 2. SYNC & HEALTH TAB */}
          <TabsContent value="sync" className="space-y-6">
            <Card className="shadow-sm">
              <CardHeader>
                <div className="flex items-center gap-2.5">
                  <div className="p-2 rounded-lg bg-primary/10 text-primary border border-primary/20">
                    <RefreshCw className="size-4" />
                  </div>
                  <div>
                    <CardTitle className="text-base">
                      Sync and Health Checks
                    </CardTitle>
                    <CardDescription>
                      Background cadence, concurrent checks, and verification
                      timeouts.
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid grid-cols-1 3xl:grid-cols-2 gap-6 items-start">
                  {/* Left Column: Auto Sync Toggle + Pool Schedules */}
                  <div className="space-y-6">
                    {/* Auto Sync Toggle */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-lg border bg-muted/20 p-4 transition-colors">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <Label
                            htmlFor="auto-sync"
                            className="text-sm font-semibold cursor-pointer"
                          >
                            Automatic Background Sync
                          </Label>
                          {form.nineRouterAutoSync ? (
                            <Badge
                              variant="secondary"
                              className="text-[10px] py-0 px-1.5 text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
                            >
                              Active
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="text-[10px] py-0 px-1.5 text-muted-foreground"
                            >
                              Paused
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Periodically synchronizes and refreshes stale pools
                          from 9Router.
                        </p>
                      </div>
                      <Switch
                        id="auto-sync"
                        checked={form.nineRouterAutoSync}
                        onCheckedChange={(checked) =>
                          patchForm('nineRouterAutoSync', checked)
                        }
                      />
                    </div>

                    {/* Pool Schedules */}
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 text-xs font-semibold text-foreground uppercase tracking-wider">
                        <Sliders className="size-3.5 text-primary" />
                        Pool Schedules
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-1.5">
                            <Label
                              htmlFor="active-limit"
                              className="text-xs font-semibold"
                            >
                              Active Pool Limit
                            </Label>
                            <FieldInfo content="Maximum number of active proxy pools kept in 9Router concurrently (1 - 200)." />
                          </div>
                          <Input
                            id="active-limit"
                            type="number"
                            min={1}
                            max={200}
                            value={form.activePoolLimit}
                            onChange={(event) =>
                              patchForm('activePoolLimit', event.target.value)
                            }
                            className="text-xs"
                          />
                        </div>

                        <div className="space-y-1.5">
                          <div className="flex items-center gap-1.5">
                            <Label
                              htmlFor="sync-minutes"
                              className="text-xs font-semibold"
                            >
                              Sync Interval (Minutes)
                            </Label>
                            <FieldInfo content="Minutes between background sync executions (1 - 1440m). Disabled when auto-sync is off." />
                          </div>
                          <Input
                            id="sync-minutes"
                            type="number"
                            min={1}
                            max={1440}
                            disabled={!form.nineRouterAutoSync}
                            value={form.nineRouterSyncMinutes}
                            onChange={(event) =>
                              patchForm(
                                'nineRouterSyncMinutes',
                                event.target.value,
                              )
                            }
                            className="text-xs"
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Right Column: Health Verification */}
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-xs font-semibold text-foreground uppercase tracking-wider">
                      <ShieldCheck className="size-3.5 text-primary" />
                      Health Verification
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 3xl:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1.5">
                          <Label
                            htmlFor="check-concurrency"
                            className="text-xs font-semibold"
                          >
                            Check Concurrency
                          </Label>
                          <FieldInfo content="Number of parallel workers testing proxy latency simultaneously (1 - 50)." />
                        </div>
                        <Input
                          id="check-concurrency"
                          type="number"
                          min={1}
                          max={50}
                          value={form.checkConcurrency}
                          onChange={(event) =>
                            patchForm('checkConcurrency', event.target.value)
                          }
                          className="text-xs"
                        />
                      </div>

                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1.5">
                          <Label
                            htmlFor="check-timeout"
                            className="text-xs font-semibold"
                          >
                            Timeout (ms)
                          </Label>
                          <FieldInfo content="Max milliseconds to wait for a proxy handshake before marking failed (2000 - 30000ms)." />
                        </div>
                        <Input
                          id="check-timeout"
                          type="number"
                          min={2000}
                          max={30000}
                          step={500}
                          value={form.checkTimeoutMs}
                          onChange={(event) =>
                            patchForm('checkTimeoutMs', event.target.value)
                          }
                          className="text-xs"
                        />
                      </div>

                      <div className="space-y-1.5 sm:col-span-3 3xl:col-span-2">
                        <div className="flex items-center gap-1.5">
                          <Label
                            htmlFor="proxy-ttl"
                            className="text-xs font-semibold"
                          >
                            Input TTL (Minutes)
                          </Label>
                          <FieldInfo content="Re-check interval for legacy input/ lists before re-evaluating liveliness." />
                        </div>
                        <Input
                          id="proxy-ttl"
                          type="number"
                          min={1}
                          max={1440}
                          value={form.proxyTtlMinutes}
                          onChange={(event) =>
                            patchForm('proxyTtlMinutes', event.target.value)
                          }
                          className="text-xs"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </CardContent>
              <CardFooter className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 border-t bg-muted/10 px-6 py-4">
                <span className="text-xs text-muted-foreground order-2 sm:order-1">
                  Changes apply to the next scheduled verification run.
                </span>
                <Button
                  type="button"
                  size="sm"
                  className="order-1 sm:order-2"
                  disabled={(!password && !authenticated) || isActionPending}
                  onClick={() => handleSave('sync')}
                >
                  {savingSection === 'sync' ? (
                    <>
                      <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                      Saving…
                    </>
                  ) : (
                    'Save sync settings'
                  )}
                </Button>
              </CardFooter>
            </Card>
          </TabsContent>

          {/* 3. ANTIGRAVITY ROTATOR TAB */}
          <TabsContent value="antigravity" className="space-y-6">
            <Card className="shadow-sm">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-lg bg-primary/10 text-primary border border-primary/20">
                      <Cpu className="size-4" />
                    </div>
                    <div>
                      <CardTitle className="text-base">
                        Antigravity Account Rotator
                      </CardTitle>
                      <CardDescription>
                        Autonomous rotation based strictly on Gemini session
                        quota.
                      </CardDescription>
                    </div>
                  </div>
                  {form.antigravityRotatorEnabled ? (
                    <Badge
                      variant="secondary"
                      className="text-xs text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
                    >
                      Daemon Running
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="text-xs text-muted-foreground"
                    >
                      Daemon Paused
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid grid-cols-1 3xl:grid-cols-12 gap-6 items-start">
                  <div className="3xl:col-span-8 space-y-6">
                    {/* Rotator Toggle */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-lg border bg-muted/20 p-4 transition-colors">
                      <div className="space-y-1">
                        <Label
                          htmlFor="ag-rotator-toggle"
                          className="text-sm font-semibold cursor-pointer"
                        >
                          Automatic Account Rotation
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          Deactivate accounts at/below quota threshold; promote
                          standbys by earliest reset time.
                        </p>
                      </div>
                      <Switch
                        id="ag-rotator-toggle"
                        checked={form.antigravityRotatorEnabled}
                        onCheckedChange={(checked) =>
                          patchForm('antigravityRotatorEnabled', checked)
                        }
                      />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1.5">
                          <Label
                            htmlFor="ag-active-limit"
                            className="text-xs font-semibold"
                          >
                            Active Accounts Limit
                          </Label>
                          <FieldInfo content="Maximum number of Antigravity accounts active simultaneously (default: 3, range: 1 - 10)." />
                        </div>
                        <Input
                          id="ag-active-limit"
                          type="number"
                          min={1}
                          max={10}
                          value={form.antigravityActiveLimit}
                          onChange={(event) =>
                            patchForm(
                              'antigravityActiveLimit',
                              event.target.value,
                            )
                          }
                          className="text-xs"
                        />
                      </div>

                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1.5">
                          <Label
                            htmlFor="ag-rotate-minutes"
                            className="text-xs font-semibold"
                          >
                            Check Interval (Minutes)
                          </Label>
                          <FieldInfo content="Frequency in minutes that the background daemon evaluates Gemini session quota (default: 10m)." />
                        </div>
                        <Input
                          id="ag-rotate-minutes"
                          type="number"
                          min={1}
                          max={60}
                          disabled={!form.antigravityRotatorEnabled}
                          value={form.antigravityRotateMinutes}
                          onChange={(event) =>
                            patchForm(
                              'antigravityRotateMinutes',
                              event.target.value,
                            )
                          }
                          className="text-xs"
                        />
                      </div>

                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1.5">
                          <Label
                            htmlFor="ag-session-threshold"
                            className="text-xs font-semibold"
                          >
                            Quota Threshold (%)
                          </Label>
                          <FieldInfo content="Deactivate accounts when Gemini session quota ≤ this percentage. Standby accounts > threshold activate by earliest reset time (default: 20%)." />
                        </div>
                        <Input
                          id="ag-session-threshold"
                          type="number"
                          min={5}
                          max={50}
                          value={form.antigravitySessionThreshold}
                          onChange={(event) =>
                            patchForm(
                              'antigravitySessionThreshold',
                              event.target.value,
                            )
                          }
                          className="text-xs"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="3xl:col-span-4 rounded-xl border border-border/70 bg-muted/20 p-4 space-y-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                      <Cpu className="size-3.5 text-primary" /> Session Quota
                      Policy
                    </span>
                    <p className="text-xs text-muted-foreground">
                      Evaluates Gemini session quota only. Claude, GPT, and
                      weekly limits are ignored for rotation.
                    </p>
                    <div className="text-[11px] font-mono text-slate-300 space-y-1.5 p-3 rounded-lg border border-border/50 bg-background/50">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">
                          Trigger threshold:
                        </span>
                        <span className="text-amber-400 font-semibold">
                          &le; {form.antigravitySessionThreshold}%
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">
                          Max concurrent:
                        </span>
                        <span className="text-emerald-400 font-semibold">
                          {form.antigravityActiveLimit} accounts
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">
                          Promotion sort:
                        </span>
                        <span className="text-foreground">Earliest reset</span>
                      </div>
                    </div>
                  </div>
                </div>
              </CardContent>
              <CardFooter className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 border-t bg-muted/10 px-6 py-4">
                <span className="text-xs text-muted-foreground order-2 sm:order-1">
                  Rotation daemon updates instantly upon saving.
                </span>
                <Button
                  type="button"
                  size="sm"
                  className="order-1 sm:order-2"
                  disabled={(!password && !authenticated) || isActionPending}
                  onClick={() => handleSave('antigravity')}
                >
                  {savingSection === 'antigravity' ? (
                    <>
                      <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                      Saving…
                    </>
                  ) : (
                    'Save rotator settings'
                  )}
                </Button>
              </CardFooter>
            </Card>
          </TabsContent>

          <TabsContent
            value="security"
            className="space-y-6 3xl:space-y-0 3xl:grid 3xl:grid-cols-2 3xl:gap-6 3xl:items-start"
          >
            {/* Dashboard Access */}
            <Card className="shadow-sm">
              <CardHeader>
                <div className="flex items-center gap-2.5">
                  <div className="p-2 rounded-lg bg-primary/10 text-primary border border-primary/20">
                    <KeyRound className="size-4" />
                  </div>
                  <div>
                    <CardTitle className="text-base">
                      Dashboard Access
                    </CardTitle>
                    <CardDescription>
                      Update the control password used to unlock this dashboard.
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="current-password"
                      className="text-xs font-semibold"
                    >
                      Current Password
                    </Label>
                    <Input
                      id="current-password"
                      type="password"
                      autoComplete="current-password"
                      placeholder="Current password"
                      value={form.currentPassword}
                      onChange={(event) =>
                        patchForm('currentPassword', event.target.value)
                      }
                      className="text-xs"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label
                      htmlFor="new-password"
                      className="text-xs font-semibold"
                    >
                      New Password
                    </Label>
                    <Input
                      id="new-password"
                      type="password"
                      autoComplete="new-password"
                      placeholder="New password"
                      value={form.newPassword}
                      onChange={(event) =>
                        patchForm('newPassword', event.target.value)
                      }
                      className="text-xs"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label
                      htmlFor="confirm-password"
                      className="text-xs font-semibold"
                    >
                      Confirm Password
                    </Label>
                    <Input
                      id="confirm-password"
                      type="password"
                      autoComplete="new-password"
                      placeholder="Confirm password"
                      value={form.confirmPassword}
                      onChange={(event) =>
                        patchForm('confirmPassword', event.target.value)
                      }
                      className="text-xs"
                    />
                  </div>
                </div>
              </CardContent>
              <CardFooter className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 border-t bg-muted/10 px-6 py-4">
                <span className="text-xs text-muted-foreground order-2 sm:order-1">
                  Requires re-login immediately after updating.
                </span>
                <Button
                  type="button"
                  size="sm"
                  className="order-1 sm:order-2"
                  disabled={(!password && !authenticated) || isActionPending}
                  onClick={() => handleSave('access')}
                >
                  {savingSection === 'access' ? (
                    <>
                      <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                      Updating…
                    </>
                  ) : (
                    'Update password'
                  )}
                </Button>
              </CardFooter>
            </Card>

            {/* Export Working Proxies */}
            <Card className="shadow-sm">
              <CardHeader>
                <div className="flex items-center gap-2.5">
                  <div className="p-2 rounded-lg bg-primary/10 text-primary border border-primary/20">
                    <Download className="size-4" />
                  </div>
                  <div>
                    <CardTitle className="text-base">
                      Export Working Proxies
                    </CardTitle>
                    <CardDescription>
                      Export verified proxies that strictly passed safety audit
                      (PASS, reliability ≥ 90%, 24h).
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between rounded-lg border bg-muted/20 p-3.5">
                  <div className="flex items-center gap-2.5">
                    <Checkbox
                      id="include-creds-toggle"
                      checked={includeCredentials}
                      onCheckedChange={(checked) =>
                        setIncludeCredentials(checked === true)
                      }
                    />
                    <Label
                      htmlFor="include-creds-toggle"
                      className="font-medium text-xs text-foreground cursor-pointer"
                    >
                      Include authentication credentials in export
                    </Label>
                  </div>
                  <FieldInfo content="Credentials are omitted by default to prevent leaking plaintext secrets. Check this box only if your consumer requires username:password format." />
                </div>

                {includeCredentials && (
                  <Alert
                    variant="destructive"
                    className="border-amber-500/40 bg-amber-500/10 text-amber-200 [&>svg]:text-amber-400 py-2.5"
                  >
                    <ShieldAlert className="size-4" />
                    <AlertTitle className="text-xs font-semibold text-amber-400">
                      Plaintext Credentials Warning
                    </AlertTitle>
                    <AlertDescription className="text-xs text-amber-300/90 mt-0.5">
                      The exported file will contain plaintext secrets. Protect
                      this file accordingly.
                    </AlertDescription>
                  </Alert>
                )}
              </CardContent>
              <CardFooter className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 border-t bg-muted/10 px-6 py-4">
                <span className="text-xs text-muted-foreground order-2 sm:order-1">
                  Safety-audited proxies from database only.
                </span>
                <div className="flex items-center gap-2 order-1 sm:order-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={(!password && !authenticated) || isActionPending}
                    onClick={() => handleExport('txt')}
                  >
                    {exporting === 'txt' ? (
                      <>
                        <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                        Exporting…
                      </>
                    ) : (
                      'Download .txt'
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={(!password && !authenticated) || isActionPending}
                    onClick={() => handleExport('csv')}
                  >
                    {exporting === 'csv' ? (
                      <>
                        <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                        Exporting…
                      </>
                    ) : (
                      'Download .csv'
                    )}
                  </Button>
                </div>
              </CardFooter>
            </Card>
          </TabsContent>

          {/* 5. WIREGUARD TAB */}
          <TabsContent
            value="wireguard"
            forceMount
            className="data-[state=inactive]:hidden space-y-6"
          >
            <WireGuardSettingsCard
              initialSettings={fleetWireguard}
              onSettingsSaved={(saved) => setFleetWireguard(saved)}
            />
          </TabsContent>
        </Tabs>

        {/* Footnote */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-2 border-t pt-4 text-xs text-muted-foreground">
          <div>
            Configuration source:{' '}
            <span className="font-semibold text-foreground">
              {meta?.source === 'settings'
                ? 'data/settings.json'
                : '.env bootstrap'}
            </span>
          </div>
          <div>
            {flags.controlPasswordSet ? (
              <span className="text-emerald-400">
                Control password is active
              </span>
            ) : (
              <span className="text-amber-400">
                Set a control password to secure the dashboard
              </span>
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
