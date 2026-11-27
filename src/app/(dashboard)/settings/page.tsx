"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  CheckCircle2,
  Cpu,
  Database,
  Download,
  HelpCircle,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  Server,
  ShieldCheck,
} from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { SpotifyLinkCard } from "@/components/spotify-link-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { motion, useReducedMotion } from "motion/react";
import {
  fetchSettings,
  testNineRouterConnection,
  fetchBackupStatus,
  triggerBackupSync,
  restoreBackup,
  type BackupStatusResponse,
  updateSettings,
} from "@/lib/api";
import { isAbortError } from "@/lib/request-lifecycle";
import { cn } from "@/lib/utils";
import { ROTATION_POLICY } from "@/lib/types";
import type {
  AppSettingsPublic,
  NineRouterTestResult,
  SettingsMeta,
  SettingsUpdatePayload,
} from "@/lib/types";

type FormState = {
  nineRouterUrl: string;
  nineRouterPassword: string;
  nineRouterApiKey: string;
  antigravityRotatorEnabled: boolean;
  antigravityRotateMinutes: string;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};
type InMemorySettingsDraft = {
  form: FormState;
  selectedTab: string;
};

let inMemorySettingsDraft: InMemorySettingsDraft | null = null;

function cacheSettingsDraft(form: FormState, selectedTab: string) {
  inMemorySettingsDraft = { form: { ...form }, selectedTab };
}

function clearSettingsDraft() {
  inMemorySettingsDraft = null;
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (event) => {
    if (!inMemorySettingsDraft) return;
    event.preventDefault();
    event.returnValue = "";
  });
  window.addEventListener("settings:before-navigate", (event) => {
    if (!inMemorySettingsDraft) return;
    if (!window.confirm("Unsaved Settings changes will stay in memory while you navigate.")) {
      event.preventDefault();
    }
  });
  window.addEventListener("dashboard:before-session-clear", (event) => {
    if (!inMemorySettingsDraft) return;
    if (!window.confirm("Unsaved Settings changes will be discarded when you sign out.")) {
      event.preventDefault();
    }
  });
  window.addEventListener("dashboard:session-cleared", clearSettingsDraft);
}

function toForm(settings: AppSettingsPublic): FormState {
  return {
    nineRouterUrl: settings.nineRouterUrl || "",
    nineRouterPassword: "",
    nineRouterApiKey: "",
    antigravityRotatorEnabled: settings.antigravityRotatorEnabled !== false,
    antigravityRotateMinutes: String(settings.antigravityRotateMinutes ?? 10),
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  };
}

function FieldInfo({ content, label }: { content: string; label?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label ? `Help for ${label}` : "More information"}
          className="cursor-help"
        >
          <HelpCircle className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="center"
        className="max-w-xs text-xs bg-[#1C1C24] text-zinc-200 border border-[#23232C] shadow-xl z-50"
      >
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

export default function SettingsPage() {
  const { password, authenticated, setPassword } = useAuth();
  const [meta, setMeta] = useState<SettingsMeta | null>(null);
  const [flags, setFlags] = useState({
    controlPasswordSet: false,
    nineRouterPasswordSet: false,
    nineRouterApiKeySet: false,
  });
  const [form, setForm] = useState<FormState | null>(null);
  const [baselineForm, setBaselineForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedTab, setSelectedTab] = useState("ninerouter");
  const isReduced = useReducedMotion();
  const [savingSection, setSavingSection] = useState<
    "access" | "ninerouter" | "antigravity" | null
  >(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<NineRouterTestResult | null>(null);
  const [backupStatus, setBackupStatus] = useState<BackupStatusResponse["status"] | null>(null);
  const [backupStatusError, setBackupStatusError] = useState<string | null>(null);
  const [backupStatusUpdatedAt, setBackupStatusUpdatedAt] = useState<number | null>(null);
  const [backupLoading, setBackupLoading] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);

  const isSaving = savingSection !== null;
  const isActionPending = isSaving || testing || backupLoading || restoreLoading;

  const isSectionDirty = useCallback(
    (section: "ninerouter" | "antigravity" | "access"): boolean => {
      if (!form || !baselineForm) return false;
      switch (section) {
        case "ninerouter":
          return (
            form.nineRouterUrl !== baselineForm.nineRouterUrl ||
            Boolean(form.nineRouterPassword) ||
            Boolean(form.nineRouterApiKey)
          );
        case "antigravity":
          return (
            form.antigravityRotatorEnabled !== baselineForm.antigravityRotatorEnabled ||
            form.antigravityRotateMinutes !== baselineForm.antigravityRotateMinutes
          );
        case "access":
          return Boolean(form.currentPassword || form.newPassword || form.confirmPassword);
        default:
          return false;
      }
    },
    [form, baselineForm],
  );

  const dirtySectionNames = [
    isSectionDirty("ninerouter") ? "9Router" : null,
    isSectionDirty("antigravity") ? "Antigravity & Codex" : null,
    isSectionDirty("access") ? "Access & Security" : null,
  ].filter((name): name is string => Boolean(name));
  const isAnyDirty = dirtySectionNames.length > 0;

  useEffect(() => {
    if (!form || !baselineForm) return;
    if (isAnyDirty) cacheSettingsDraft(form, selectedTab);
    else clearSettingsDraft();
  }, [form, baselineForm, isAnyDirty, selectedTab]);

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
        const initial = toForm(data.settings);
        const cached = inMemorySettingsDraft;
        setForm(cached?.form ?? initial);
        setBaselineForm(initial);
        if (cached) setSelectedTab(cached.selectedTab);
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

  const loadBackupStatus = useCallback(async () => {
    setBackupLoading(true);
    try {
      const res = await fetchBackupStatus(password || undefined);
      if (!res.ok || !res.status) throw new Error(res.error || "Backup status unavailable");
      setBackupStatus(res.status);
      setBackupStatusUpdatedAt(Date.now());
      setBackupStatusError(null);
    } catch (error) {
      setBackupStatusError((error as Error).message || "Backup status unavailable");
    } finally {
      setBackupLoading(false);
    }
  }, [password]);

  useEffect(() => {
    if (selectedTab === "backup") {
      void loadBackupStatus();
    }
  }, [selectedTab, loadBackupStatus]);

  async function handleBackupNow() {
    if ((!password && !authenticated) || isActionPending) return;
    setBackupLoading(true);
    try {
      const res = await triggerBackupSync(true, password || undefined);
      if (!res.ok) throw new Error(res.error || "Backup failed");
      toast.success(
        res.git?.committed
          ? `Backed up & committed to Git (${res.git.commitSha})`
          : "Backup snapshot refreshed (No changes to commit)",
      );
      await loadBackupStatus();
    } catch (err) {
      toast.error((err as Error).message || "Failed to trigger backup");
    } finally {
      setBackupLoading(false);
    }
  }

  async function handleRestoreNow() {
    if ((!password && !authenticated) || isActionPending) return;
    const draftWarning = isAnyDirty
      ? `\n\nUnsaved drafts in ${dirtySectionNames.join(", ")} will also be discarded.`
      : "";
    const confirmed = window.confirm(
      `CRITICAL ACTION: Restoring settings and database from Git backups will overwrite settings.json and application registries. Any uncommitted data will be permanently lost.${draftWarning}\n\nAre you sure you want to proceed with restore?`,
    );
    if (!confirmed) return;
    setRestoreLoading(true);
    try {
      const res = await restoreBackup(password || undefined);
      if (!res.ok) throw new Error(res.error || res.errors?.[0] || "Restore failed");
      clearSettingsDraft();
      toast.success(`Restored ${res.restoredFiles?.length ?? 0} files from backup`);
      await loadBackupStatus();
      void load();
    } catch (err) {
      toast.error((err as Error).message || "Restore failed");
    } finally {
      setRestoreLoading(false);
    }
  }

  function patchForm<K extends keyof FormState>(key: K, value: FormState[K]) {
    if (key === "nineRouterUrl" && testResult) {
      setTestResult(null);
    }
    setForm((current) => (current ? { ...current, [key]: value } : current));
  }

  async function handleTestConnection() {
    if (!form || testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const payload: {
        nineRouterUrl?: string;
        nineRouterPassword?: string;
        nineRouterApiKey?: string;
      } = {
        nineRouterUrl: form.nineRouterUrl.trim(),
      };
      if (form.nineRouterPassword) payload.nineRouterPassword = form.nineRouterPassword;
      if (form.nineRouterApiKey) payload.nineRouterApiKey = form.nineRouterApiKey.trim();

      const result = await testNineRouterConnection(password || undefined, payload);
      setTestResult(result);
      if (result.ok) {
        toast.success("9Router connection successful");
      } else {
        toast.error(result.error || "Connection failed");
      }
    } catch (err) {
      const message = (err as Error).message || "Failed to test connection";
      setTestResult({ ok: false, error: message });
      toast.error(message);
    } finally {
      setTesting(false);
    }
  }

  async function handleSave(section: "access" | "ninerouter" | "antigravity") {
    if ((!password && !authenticated) || !form || isActionPending) return;
    setSavingSection(section);
    try {
      const payload: SettingsUpdatePayload = {};

      if (section === "access") {
        if (form.newPassword || form.confirmPassword || form.currentPassword) {
          if (!form.currentPassword) throw new Error("Enter current control password");
          if (!form.newPassword) throw new Error("Enter new control password");
          if (form.newPassword !== form.confirmPassword) throw new Error("Passwords do not match");
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

      if (section === "antigravity") {
        const rotateMinutes = Number(form.antigravityRotateMinutes);
        if (
          Number.isNaN(rotateMinutes) ||
          !Number.isInteger(rotateMinutes) ||
          rotateMinutes < 1 ||
          rotateMinutes > 60
        ) {
          throw new Error("Rotation interval must be an integer between 1 and 60 minutes");
        }
        payload.antigravityRotatorEnabled = form.antigravityRotatorEnabled;
        payload.antigravityRotateMinutes = rotateMinutes;
      }

      const data = await updateSettings(password, payload);
      setMeta(data.meta);
      setFlags({
        controlPasswordSet: data.settings.controlPasswordSet,
        nineRouterPasswordSet: data.settings.nineRouterPasswordSet,
        nineRouterApiKeySet: data.settings.nineRouterApiKeySet,
      });

      if (section === "access" && payload.controlPassword) {
        setPassword(payload.controlPassword);
      }

      setForm((current) => {
        if (!current) return current;
        const next = { ...current };
        if (section === "ninerouter") {
          next.nineRouterUrl = data.settings.nineRouterUrl;
          next.nineRouterPassword = "";
          next.nineRouterApiKey = "";
        } else if (section === "antigravity") {
          next.antigravityRotatorEnabled = data.settings.antigravityRotatorEnabled !== false;
          next.antigravityRotateMinutes = String(data.settings.antigravityRotateMinutes ?? 10);
        } else if (section === "access") {
          next.currentPassword = "";
          next.newPassword = "";
          next.confirmPassword = "";
        }
        return next;
      });

      setBaselineForm((current) => {
        if (!current) return current;
        const next = { ...current };
        if (section === "ninerouter") {
          next.nineRouterUrl = data.settings.nineRouterUrl;
          next.nineRouterPassword = "";
          next.nineRouterApiKey = "";
        } else if (section === "antigravity") {
          next.antigravityRotatorEnabled = data.settings.antigravityRotatorEnabled !== false;
          next.antigravityRotateMinutes = String(data.settings.antigravityRotateMinutes ?? 10);
        } else if (section === "access") {
          next.currentPassword = "";
          next.newPassword = "";
          next.confirmPassword = "";
        }
        return next;
      });

      toast.success(
        section === "access"
          ? "Control password updated"
          : section === "ninerouter"
            ? "9Router connection saved"
            : "Rotator settings saved",
      );
    } catch (error) {
      toast.error((error as Error).message || "Save failed");
    } finally {
      setSavingSection(null);
    }
  }

  if (loading && !form) {
    return (
      <div className="space-y-6 max-w-5xl mx-auto p-4 sm:p-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-6 max-w-5xl mx-auto pb-16 text-foreground">
        <div className="pb-4">
          <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-zinc-100">
            Settings &amp; Configuration
          </h1>
          <p className="text-xs sm:text-sm text-zinc-400 mt-1">
            Configure 9Router endpoints, autonomous Antigravity and Codex account rotation, Git
            backups, and access security.
          </p>
        </div>

        {loadError && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertDescription className="text-xs">{loadError}</AlertDescription>
          </Alert>
        )}
        {isAnyDirty && (
          <Alert>
            <AlertCircle className="size-4" />
            <AlertDescription>
              Unsaved changes: {dirtySectionNames.join(", ")}. Drafts stay in memory during internal
              navigation, but are lost on reload or sign out. Save each section to apply changes.
            </AlertDescription>
          </Alert>
        )}

        <Tabs value={selectedTab} onValueChange={setSelectedTab} className="space-y-6">
          <TabsList className="flex flex-wrap sm:flex-nowrap w-full group-data-[orientation=horizontal]/tabs:h-auto p-1.5 bg-surface border border-border rounded-xl gap-1.5 shadow-sm 3xl:p-2 3xl:max-w-4xl [&>[role=tab]]:h-auto [&>[role=tab]]:min-h-11 sm:[&>[role=tab]]:min-h-9">
            <TabsTrigger
              value="ninerouter"
              className="relative min-w-[130px] flex-1 gap-2 px-3 text-xs sm:text-sm font-semibold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
            >
              {selectedTab === "ninerouter" && (
                <motion.span
                  layoutId={isReduced ? undefined : "settings-active-pill"}
                  className="absolute inset-0 rounded-lg bg-[#FF5B22] shadow-md shadow-[#FF5B22]/25 -z-10"
                  transition={{ type: "spring", stiffness: 450, damping: 35 }}
                />
              )}
              <Server className="size-4 shrink-0" />
              <span>9Router</span>
              {isSectionDirty("ninerouter") && (
                <span
                  className="size-1.5 rounded-full bg-amber-400 ring-2 ring-background animate-pulse"
                  title="Unsaved changes in 9Router"
                />
              )}
            </TabsTrigger>

            <TabsTrigger
              value="antigravity"
              className="relative min-w-[130px] flex-1 gap-2 px-3 text-xs sm:text-sm font-semibold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
            >
              {selectedTab === "antigravity" && (
                <motion.span
                  layoutId={isReduced ? undefined : "settings-active-pill"}
                  className="absolute inset-0 rounded-lg bg-[#FF5B22] shadow-md shadow-[#FF5B22]/25 -z-10"
                  transition={{ type: "spring", stiffness: 450, damping: 35 }}
                />
              )}
              <Cpu className="size-4 shrink-0" />
              <span>Antigravity &amp; Codex</span>
              {isSectionDirty("antigravity") && (
                <span
                  className="size-1.5 rounded-full bg-amber-400 ring-2 ring-background animate-pulse"
                  title="Unsaved changes in Antigravity"
                />
              )}
            </TabsTrigger>

            <TabsTrigger
              value="backup"
              className="relative min-w-[130px] flex-1 gap-2 px-3 text-xs sm:text-sm font-semibold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
            >
              {selectedTab === "backup" && (
                <motion.span
                  layoutId={isReduced ? undefined : "settings-active-pill"}
                  className="absolute inset-0 rounded-lg bg-[#FF5B22] shadow-md shadow-[#FF5B22]/25 -z-10"
                  transition={{ type: "spring", stiffness: 450, damping: 35 }}
                />
              )}
              <Database className="size-4 shrink-0" />
              <span>Backup &amp; Git</span>
            </TabsTrigger>

            <TabsTrigger
              value="access"
              className="relative min-w-[130px] flex-1 gap-2 px-3 text-xs sm:text-sm font-semibold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
            >
              {selectedTab === "access" && (
                <motion.span
                  layoutId={isReduced ? undefined : "settings-active-pill"}
                  className="absolute inset-0 rounded-lg bg-[#FF5B22] shadow-md shadow-[#FF5B22]/25 -z-10"
                  transition={{ type: "spring", stiffness: 450, damping: 35 }}
                />
              )}
              <KeyRound className="size-4 shrink-0" />
              <span>Access &amp; Security</span>
              {isSectionDirty("access") && (
                <span
                  className="size-1.5 rounded-full bg-amber-400 ring-2 ring-background animate-pulse"
                  title="Unsaved changes in Password"
                />
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent
            value="ninerouter"
            forceMount
            className="data-[state=inactive]:hidden space-y-6"
          >
            <Card className="shadow-sm">
              <CardHeader>
                <div className="flex items-center gap-2.5">
                  <div className="p-2 rounded-lg bg-primary/10 text-primary border border-primary/20">
                    <Server className="size-4" />
                  </div>
                  <div>
                    <CardTitle className="text-base">9Router Endpoint</CardTitle>
                    <CardDescription>
                      Configure the upstream 9Router service endpoint and authentication
                      credentials.
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <Label htmlFor="ninerouter-url" className="text-xs font-semibold">
                      9Router URL
                    </Label>
                    <FieldInfo content="HTTP or HTTPS base URL of the 9Router instance (e.g. http://127.0.0.1:20128 or https://9router.example.com)." />
                  </div>
                  <Input
                    id="ninerouter-url"
                    type="url"
                    placeholder="http://127.0.0.1:20128"
                    value={form?.nineRouterUrl || ""}
                    onChange={(e) => patchForm("nineRouterUrl", e.target.value)}
                    className="text-xs font-mono"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <Label htmlFor="ninerouter-password" className="text-xs font-semibold">
                        9Router Dashboard Password
                      </Label>
                      {flags.nineRouterPasswordSet && (
                        <Badge
                          variant="outline"
                          className="text-[10px] py-0 px-1 border-emerald-500/30 text-emerald-400"
                        >
                          Configured
                        </Badge>
                      )}
                      <FieldInfo content="Password used for /api/auth/login on 9Router." />
                    </div>
                    <Input
                      id="ninerouter-password"
                      type="password"
                      autoComplete="new-password"
                      placeholder={
                        flags.nineRouterPasswordSet ? "•••••••• (unchanged)" : "Enter password"
                      }
                      value={form?.nineRouterPassword || ""}
                      onChange={(e) => patchForm("nineRouterPassword", e.target.value)}
                      className="text-xs font-mono"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <Label htmlFor="ninerouter-apikey" className="text-xs font-semibold">
                        9Router API Key (Optional)
                      </Label>
                      {flags.nineRouterApiKeySet && (
                        <Badge
                          variant="outline"
                          className="text-[10px] py-0 px-1 border-emerald-500/30 text-emerald-400"
                        >
                          Configured
                        </Badge>
                      )}
                      <FieldInfo content="Optional bearer token or API key if configured on 9Router." />
                    </div>
                    <Input
                      id="ninerouter-apikey"
                      type="password"
                      autoComplete="off"
                      placeholder={
                        flags.nineRouterApiKeySet ? "•••••••• (unchanged)" : "Optional bearer key"
                      }
                      value={form?.nineRouterApiKey || ""}
                      onChange={(e) => patchForm("nineRouterApiKey", e.target.value)}
                      className="text-xs font-mono"
                    />
                  </div>
                </div>

                {testResult && (
                  <div
                    className={cn(
                      "text-xs p-3 rounded-lg border",
                      testResult.ok
                        ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                        : "bg-rose-500/10 border-rose-500/20 text-rose-400",
                    )}
                  >
                    {testResult.ok ? (
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="size-4 shrink-0" />
                        <span>
                          Connected to 9Router successfully. Found{" "}
                          {"accountCount" in testResult &&
                          typeof testResult.accountCount === "number"
                            ? testResult.accountCount
                            : (testResult.poolCount ?? 0)}{" "}
                          accounts.
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <AlertCircle className="size-4 shrink-0" />
                        <span>{testResult.error || "Failed to connect to 9Router"}</span>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
              <CardFooter className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 border-t bg-muted/10 px-6 py-4">
                <span className="text-xs text-muted-foreground order-2 sm:order-1">
                  Changes take effect immediately on next connection attempt.
                </span>
                <div className="flex flex-wrap items-center gap-2 order-1 sm:order-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isActionPending}
                    onClick={handleTestConnection}
                  >
                    {testing ? (
                      <>
                        <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                        Testing…
                      </>
                    ) : (
                      "Test 9Router Connection"
                    )}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={(!password && !authenticated) || isActionPending}
                    onClick={() => handleSave("ninerouter")}
                  >
                    {savingSection === "ninerouter" ? (
                      <>
                        <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                        Saving…
                      </>
                    ) : (
                      "Save 9Router Connection"
                    )}
                  </Button>
                </div>
              </CardFooter>
            </Card>
          </TabsContent>

          <TabsContent
            value="antigravity"
            forceMount
            className="data-[state=inactive]:hidden space-y-6"
          >
            <Card className="shadow-sm">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-lg bg-primary/10 text-primary border border-primary/20">
                      <Cpu className="size-4" />
                    </div>
                    <div>
                      <CardTitle className="text-base">
                        Antigravity &amp; Codex Account Rotator
                      </CardTitle>
                      <CardDescription>
                        Independent two-account rotation per provider, based strictly on session
                        quota.
                      </CardDescription>
                    </div>
                  </div>
                  {form?.antigravityRotatorEnabled ? (
                    <Badge
                      variant="secondary"
                      className="text-xs text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
                    >
                      Daemon Running
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs text-muted-foreground">
                      Daemon Paused
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid grid-cols-1 3xl:grid-cols-12 gap-6 items-start">
                  <div className="3xl:col-span-8 space-y-6">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-lg border bg-muted/20 p-4 transition-colors">
                      <div className="space-y-1">
                        <Label
                          htmlFor="ag-rotator-toggle"
                          className="text-sm font-semibold cursor-pointer"
                        >
                          Automatic Account Rotation (Antigravity &amp; Codex)
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          One shared toggle and schedule cover both providers. Each provider rotates
                          its own active account when its session quota reaches the sampled
                          threshold (5–10%) or an account error occurs.
                        </p>
                      </div>
                      <Switch
                        id="ag-rotator-toggle"
                        checked={form?.antigravityRotatorEnabled ?? true}
                        onCheckedChange={(checked) =>
                          patchForm("antigravityRotatorEnabled", checked)
                        }
                      />
                    </div>

                    <div className="space-y-1.5 max-w-xs">
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="ag-rotate-minutes" className="text-xs font-semibold">
                          Check Interval (Minutes)
                        </Label>
                        <FieldInfo content="Frequency in minutes that the background daemon evaluates session quota for both Antigravity and Codex accounts (default: 10m, range: 1 - 60m)." />
                      </div>
                      <Input
                        id="ag-rotate-minutes"
                        type="number"
                        min={1}
                        max={60}
                        disabled={!form?.antigravityRotatorEnabled}
                        value={form?.antigravityRotateMinutes || "10"}
                        onChange={(event) =>
                          patchForm("antigravityRotateMinutes", event.target.value)
                        }
                        className="text-xs font-mono"
                      />
                    </div>
                  </div>

                  <div className="3xl:col-span-4 rounded-xl border border-border/70 bg-muted/20 p-4 space-y-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                      <Cpu className="size-3.5 text-primary" /> Two-Account Policy
                    </span>
                    <p className="text-xs text-muted-foreground">
                      Keeps 2 Antigravity and 2 Codex accounts active independently when eligible
                      accounts are available. Evaluates session quota only; weekly quota is display
                      only and never used for decisions.
                    </p>
                    <div className="text-[11px] font-mono text-slate-300 space-y-1.5 p-3 rounded-lg border border-border/50 bg-background/50">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Active tenure:</span>
                        <span className="text-emerald-400 font-semibold">
                          2 Antigravity + 2 Codex
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Sampled threshold:</span>
                        <span className="text-amber-400 font-semibold">
                          {ROTATION_POLICY.thresholdMin}% – {ROTATION_POLICY.thresholdMax}%
                          (uniform)
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Handoff guarantee:</span>
                        <span className="text-foreground">Activate before deactivate</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Promotion sort:</span>
                        <span className="text-foreground">
                          Candidate session &gt; {ROTATION_POLICY.standbyQuotaExclusive}%, highest
                          session, then earliest session reset
                        </span>
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
                  onClick={() => handleSave("antigravity")}
                >
                  {savingSection === "antigravity" ? (
                    <>
                      <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                      Saving…
                    </>
                  ) : (
                    "Save Rotator Settings"
                  )}
                </Button>
              </CardFooter>
            </Card>
          </TabsContent>

          <TabsContent value="backup" forceMount className="data-[state=inactive]:hidden space-y-6">
            <Card className="shadow-sm">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-lg bg-primary/10 text-primary border border-primary/20">
                      <Database className="size-4" />
                    </div>
                    <div>
                      <CardTitle className="text-base">Git Snapshot &amp; Backup</CardTitle>
                      <CardDescription>
                        Automated and manual offline backup of configuration and rotation history to
                        Git.
                      </CardDescription>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={(!password && !authenticated) || isActionPending}
                    onClick={loadBackupStatus}
                    className="h-8 text-xs shrink-0"
                  >
                    <RefreshCw className={cn("size-3.5 mr-1.5", backupLoading && "animate-spin")} />
                    Refresh Backup Status
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {backupStatusError && (
                  <Alert variant="destructive" className="py-2">
                    <AlertCircle className="size-4" />
                    <AlertDescription className="text-xs">
                      Backup status refresh failed: {backupStatusError}.{" "}
                      {backupStatusUpdatedAt
                        ? `Showing stale data last read ${new Date(backupStatusUpdatedAt).toLocaleString()}.`
                        : "No backup status is available."}{" "}
                      Retry using Refresh Backup Status.
                    </AlertDescription>
                  </Alert>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="rounded-lg border bg-muted/20 p-3 space-y-1">
                    <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                      Last Backup
                    </span>
                    <div className="text-sm font-semibold truncate">
                      {!backupStatus
                        ? "Unavailable"
                        : backupStatus.lastBackupTime
                          ? new Date(backupStatus.lastBackupTime).toLocaleString()
                          : "Never"}
                    </div>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3 space-y-1">
                    <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                      Latest Commit
                    </span>
                    <div className="flex items-center gap-2">
                      {backupStatus?.lastCommitSha ? (
                        <Badge variant="secondary" className="font-mono text-xs">
                          {backupStatus.lastCommitSha}
                        </Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">
                          {backupStatus ? "None" : "Unavailable"}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3 space-y-1">
                    <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                      Git Working Tree
                    </span>
                    <div>
                      {!backupStatus ? (
                        <span className="text-sm text-muted-foreground">Unavailable</span>
                      ) : backupStatus.hasUncommittedChanges ? (
                        <Badge
                          variant="outline"
                          className="text-amber-400 border-amber-500/30 bg-amber-500/10 text-xs"
                        >
                          Uncommitted Changes
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="text-emerald-400 border-emerald-500/30 bg-emerald-500/10 text-xs"
                        >
                          Clean / Synced
                        </Badge>
                      )}
                    </div>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3 space-y-1">
                    <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                      Backed-up Files
                    </span>
                    <div className="text-sm font-semibold">
                      {backupStatus ? `${backupStatus.backupFileCount} files` : "Unavailable"}
                    </div>
                  </div>
                </div>
                {backupStatus?.lastCommitMessage && (
                  <p className="text-xs text-muted-foreground italic truncate">
                    Commit: {backupStatus.lastCommitMessage}
                  </p>
                )}
                {backupStatus?.lastSyncError && (
                  <Alert variant="destructive" className="py-2">
                    <AlertCircle className="size-4" />
                    <AlertDescription className="text-xs">
                      Sync warning: {backupStatus.lastSyncError}
                    </AlertDescription>
                  </Alert>
                )}
              </CardContent>
              <CardFooter className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 border-t bg-muted/10 px-6 py-4">
                <span className="text-xs text-muted-foreground order-2 sm:order-1">
                  Automatic backups run on maintenance intervals and setting updates.
                </span>
                <div className="flex flex-wrap items-center gap-2 order-1 sm:order-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={(!password && !authenticated) || isActionPending}
                    onClick={handleRestoreNow}
                  >
                    {restoreLoading ? (
                      <>
                        <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                        Restoring…
                      </>
                    ) : (
                      "Restore Database from Backup"
                    )}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={(!password && !authenticated) || isActionPending}
                    onClick={handleBackupNow}
                  >
                    {backupLoading ? (
                      <>
                        <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                        Backing up…
                      </>
                    ) : (
                      <>
                        <Download className="size-3.5 mr-1.5" />
                        Create Git Backup Snapshot
                      </>
                    )}
                  </Button>
                </div>
              </CardFooter>
            </Card>
          </TabsContent>

          <TabsContent value="access" forceMount className="data-[state=inactive]:hidden space-y-6">
            <Card className="shadow-sm">
              <CardHeader>
                <div className="flex items-center gap-2.5">
                  <div className="p-2 rounded-lg bg-primary/10 text-primary border border-primary/20">
                    <KeyRound className="size-4" />
                  </div>
                  <div>
                    <CardTitle className="text-base">Dashboard Access Control</CardTitle>
                    <CardDescription>
                      Update the master control password used to authenticate dashboard changes.
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <Label htmlFor="current-password" className="text-xs font-semibold">
                        Current Password
                      </Label>
                      <FieldInfo content="Existing master control password for authenticating configuration changes." />
                    </div>
                    <Input
                      id="current-password"
                      type="password"
                      autoComplete="current-password"
                      placeholder="Current password"
                      value={form?.currentPassword || ""}
                      onChange={(e) => patchForm("currentPassword", e.target.value)}
                      className="text-xs font-mono"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <Label htmlFor="new-password" className="text-xs font-semibold">
                        New Password
                      </Label>
                      <FieldInfo content="Enter the new desired control password." />
                    </div>
                    <Input
                      id="new-password"
                      type="password"
                      autoComplete="new-password"
                      placeholder="New password"
                      value={form?.newPassword || ""}
                      onChange={(e) => patchForm("newPassword", e.target.value)}
                      className="text-xs font-mono"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <Label htmlFor="confirm-password" className="text-xs font-semibold">
                        Confirm Password
                      </Label>
                      <FieldInfo content="Repeat the new password exactly to confirm." />
                    </div>
                    <Input
                      id="confirm-password"
                      type="password"
                      autoComplete="new-password"
                      placeholder="Confirm new password"
                      value={form?.confirmPassword || ""}
                      onChange={(e) => patchForm("confirmPassword", e.target.value)}
                      className="text-xs font-mono"
                    />
                  </div>
                </div>
              </CardContent>
              <CardFooter className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 border-t bg-muted/10 px-6 py-4">
                <span className="text-xs text-muted-foreground order-2 sm:order-1">
                  Updates apply immediately to the current session.
                </span>
                <Button
                  type="button"
                  size="sm"
                  className="order-1 sm:order-2"
                  disabled={(!password && !authenticated) || isActionPending}
                  onClick={() => handleSave("access")}
                >
                  {savingSection === "access" ? (
                    <>
                      <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                      Updating…
                    </>
                  ) : (
                    "Update Control Password"
                  )}
                </Button>
              </CardFooter>
            </Card>

            <SpotifyLinkCard />
          </TabsContent>
        </Tabs>

        <div className="flex flex-col sm:flex-row items-center justify-between gap-2 border-t pt-4 text-xs text-muted-foreground">
          <div>
            Configuration source:{" "}
            <span className="font-semibold text-foreground">
              {meta?.source === "settings" ? "data/settings.json" : ".env bootstrap"}
            </span>
          </div>
          <div>
            {flags.controlPasswordSet ? (
              <span className="text-emerald-400">Control password is active</span>
            ) : (
              <span className="text-amber-400">Set a control password to secure the dashboard</span>
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
