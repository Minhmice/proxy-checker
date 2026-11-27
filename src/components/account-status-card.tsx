"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { useAccountQuota } from "@/components/antigravity-quota-widget";
import { useAuth } from "@/components/auth-provider";
import { CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { DitherCard } from "@/components/dithercn/dither-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { DitherBar } from "@/components/ui/dither";
import { Skeleton } from "@/components/ui/skeleton";
import { updateAntigravityAccountState } from "@/lib/api";
import { formatCountdown } from "@/lib/countdown";
import { PROVIDER_LABEL, type AntigravityAccountState } from "@/lib/types";
import { CountUp } from "@/components/ui/count-up";

/** "metavocab@gmail.com" -> "me***@gmail.com". A name without "@" ("Account 2") is not secret and stays whole. */
function maskLabel(value: string) {
  const at = value.indexOf("@");
  return at === -1 ? value : `${value.slice(0, 2)}***${value.slice(at)}`;
}

/** Red at 20% or less, amber to 50%, green above. The label also says "Low", so color is never the only cue. */
export function quotaTier(percent: number) {
  if (percent <= 20) return { color: "--error", text: "text-error", low: true };
  if (percent <= 50) return { color: "--warning", text: "text-warning", low: false };
  return { color: "--success", text: "text-success", low: false };
}

function resetText(resetAt: string | null) {
  if (!resetAt) return null;
  const countdown = formatCountdown(resetAt);
  return countdown === "Resetting soon" || countdown === "No reset info"
    ? countdown
    : `Resets in ${countdown}`;
}

export function AccountStatusCard() {
  const {
    snapshot,
    loading,
    unavailable,
    error,
    refreshing,
    canRefresh,
    refresh,
    acceptAccountSnapshot,
  } = useAccountQuota();
  const { password } = useAuth();
  const [pending, setPending] = useState<AntigravityAccountState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const accounts = snapshot?.accounts ?? [];

  async function toggle(account: AntigravityAccountState) {
    setPending(account);
    setActionError(null);
    try {
      acceptAccountSnapshot(
        await updateAntigravityAccountState(
          account.id,
          account.routerUrl,
          !account.isActive,
          password || undefined,
        ),
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Account update failed.");
    } finally {
      setPending(null);
    }
  }

  return (
    <DitherCard glow="top-left" color="--primary" reach={260} interactive radius={16}>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="account-quota" className="text-xl font-semibold tracking-tight">
            Account quota
          </h2>
          {snapshot && (
            <Badge
              variant="outline"
              className="border-success/40 bg-success/10 text-success tabular-nums"
            >
              {snapshot.activeCount} of {accounts.length} enabled
            </Badge>
          )}
        </div>
        <CardDescription>
          Session quota left on each account. Rotation can switch accounts on or off automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {actionError && (
          <p role="alert" className="text-sm text-error">
            {actionError}
          </p>
        )}
        {(unavailable || snapshot?.degraded) && (
          <p role="status" className="text-sm text-warning">
            {unavailable
              ? snapshot
                ? "Showing last known quota. "
                : "Quota unavailable. "
              : "Some quota readings are unavailable. "}
            {error ?? ""}
          </p>
        )}
        {loading && !snapshot ? (
          <Skeleton className="h-24" />
        ) : accounts.length ? (
          <ul className="divide-y divide-border border-y border-border">
            {accounts.map((account, index) => {
              const label = maskLabel(account.email || account.name || account.id);
              const percent =
                account.quotaAvailable && Number.isFinite(account.sessionPercentage)
                  ? Math.min(100, Math.max(0, account.sessionPercentage))
                  : null;
              const delay = index * 90 + 150;
              const updating =
                pending?.id === account.id && pending?.routerUrl === account.routerUrl;
              return (
                <li
                  key={JSON.stringify([account.routerUrl, account.id])}
                  style={{ "--row-order": index } as React.CSSProperties}
                  className="row-enter grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(8rem,1fr)_auto]"
                >
                  <div className="min-w-0">
                    <p className="wrap-anywhere text-sm font-medium">{label}</p>
                    <p className="flex flex-wrap items-center gap-x-2.5 text-xs text-foreground/75">
                      <span>{PROVIDER_LABEL[account.provider ?? "antigravity"]}</span>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 font-medium",
                          account.isActive ? "text-success" : "text-muted-foreground",
                        )}
                      >
                        <span aria-hidden="true" className="relative flex size-2">
                          {account.isActive && (
                            <span className="absolute inset-0 animate-ping rounded-full bg-success/60 motion-reduce:hidden" />
                          )}
                          <span
                            className={cn(
                              "relative size-2 rounded-full",
                              account.isActive ? "bg-success" : "bg-muted-foreground/60",
                            )}
                          />
                        </span>
                        {account.isActive ? "Enabled" : "Disabled"}
                      </span>
                    </p>
                    {account.lastError && (
                      <p className="wrap-anywhere text-xs text-error">{account.lastError}</p>
                    )}
                  </div>
                  <div className="col-span-2 row-start-2 min-w-0 sm:col-span-1 sm:row-auto">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs tabular-nums">
                      <strong
                        className={cn(
                          "font-semibold",
                          percent === null ? "text-warning" : quotaTier(percent).text,
                        )}
                      >
                        {percent === null ? (
                          "Quota unavailable"
                        ) : (
                          <>
                            {quotaTier(percent).low && "Low · "}
                            <CountUp value={percent} delay={delay} />% left
                          </>
                        )}
                      </strong>
                      {resetText(account.resetAt) && (
                        <span className="text-muted-foreground">{resetText(account.resetAt)}</span>
                      )}
                    </div>
                    {percent !== null && (
                      <div
                        role="progressbar"
                        aria-valuenow={percent}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={`${label} session quota remaining`}
                        className="relative mt-2 h-1.5 overflow-hidden rounded-sm"
                      >
                        <DitherBar
                          percent={percent}
                          delay={delay}
                          color={quotaTier(percent).color}
                        />
                      </div>
                    )}
                  </div>
                  <Switch
                    checked={account.isActive}
                    className="col-start-2 row-start-1 sm:col-start-3"
                    disabled={
                      !canRefresh ||
                      Boolean(pending) ||
                      refreshing ||
                      unavailable ||
                      snapshot?.running
                    }
                    onCheckedChange={() => void toggle(account)}
                    aria-label={`Enable ${label}`}
                    aria-busy={updating || undefined}
                  />
                </li>
              );
            })}
          </ul>
        ) : (
          !unavailable && (
            <p className="text-sm text-muted-foreground">
              No Antigravity or Codex accounts reported by 9Router.
            </p>
          )
        )}
        <Button
          variant="outline"
          className="min-h-11 self-start"
          disabled={!canRefresh || refreshing || Boolean(pending)}
          onClick={() => void refresh()}
        >
          {refreshing ? "Refreshing quota…" : "Refresh quota & run rotation"}
        </Button>
      </CardContent>
    </DitherCard>
  );
}
