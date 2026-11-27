"use client";

import { quotaTier } from "@/components/account-status-card";
import { useAccountQuota } from "@/components/antigravity-quota-widget";
import { Gauge } from "@/components/dithercn/gauge";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { CountUp } from "@/components/ui/count-up";
import { DitherBar } from "@/components/ui/dither";
import { Skeleton } from "@/components/ui/skeleton";
import { PROVIDER_LABEL, type RotationProvider } from "@/lib/types";
import { cn } from "@/lib/utils";

const PROVIDER_ORDER = Object.keys(PROVIDER_LABEL) as RotationProvider[];

const clampPercent = (value: number) =>
  Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
const whole = (value: number) => String(Math.round(value));

export function AggregateQuotaCard() {
  const { snapshot, loading, unavailable } = useAccountQuota();
  const accounts = snapshot?.accounts ?? [];
  const points = snapshot?.totalSessionQuotaPercentage;
  const capacity = snapshot?.maxPossiblePercentage ?? 0;
  const percent = points != null && capacity > 0 ? clampPercent((points / capacity) * 100) : null;

  const providers = PROVIDER_ORDER.flatMap((id) => {
    const list = accounts.filter((account) => (account.provider ?? "antigravity") === id);
    if (!list.length) return [];
    const left =
      list.reduce((sum, account) => sum + clampPercent(account.sessionPercentage), 0) / list.length;
    return [
      {
        id,
        name: PROVIDER_LABEL[id],
        total: list.length,
        enabled: list.filter((account) => account.isActive).length,
        percent: left,
      },
    ];
  });
  const missing = accounts.filter((account) => !account.quotaAvailable).length;

  return (
    <Card>
      <CardHeader className="gap-1">
        <h2 className="text-lg font-semibold">Aggregate quota</h2>
        <CardDescription>Session quota left, averaged over every account.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {percent === null ? (
          loading ? (
            <Skeleton className="h-48" />
          ) : (
            <p className="min-h-48 text-sm text-muted-foreground">Quota unavailable</p>
          )
        ) : (
          <>
            {(unavailable || missing > 0) && (
              <p role="status" className="text-sm text-warning">
                {unavailable
                  ? "Showing last known quota."
                  : `${missing} of ${accounts.length} readings unavailable, counted as 0%.`}
              </p>
            )}
            <div className="flex flex-col items-center gap-1">
              <Gauge
                value={percent}
                label="quota left"
                unit="%"
                variant="half"
                size={260}
                showRange={false}
                color="--primary"
                fill="dotted"
              />
              <p className="text-center text-sm text-muted-foreground tabular-nums">
                <span className="font-medium text-foreground">
                  <CountUp value={points ?? 0} format={whole} delay={200} />
                </span>{" "}
                of {capacity} points left
                <span className="block text-xs">
                  {snapshot?.totalAccounts} accounts × 100 points each
                </span>
              </p>
            </div>
            {providers.length > 0 && (
              <ul className="divide-y divide-border border-y border-border">
                {providers.map((provider, index) => {
                  const tier = quotaTier(provider.percent);
                  const delay = 300 + index * 120;
                  return (
                    <li
                      key={provider.id}
                      style={{ "--row-order": index } as React.CSSProperties}
                      className="row-enter grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 py-3"
                    >
                      <div className="flex min-w-0 items-baseline gap-2">
                        <span className="text-sm font-medium">{provider.name}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {provider.enabled} of {provider.total} enabled
                        </span>
                      </div>
                      <strong className={cn("text-sm font-semibold tabular-nums", tier.text)}>
                        {tier.low && "Low · "}
                        <CountUp value={provider.percent} format={whole} delay={delay} />% left
                      </strong>
                      <div
                        role="progressbar"
                        aria-valuenow={Math.round(provider.percent)}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={`${provider.name} quota left`}
                        className="relative col-span-2 h-1.5 overflow-hidden rounded-sm"
                      >
                        <DitherBar percent={provider.percent} color={tier.color} delay={delay} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
