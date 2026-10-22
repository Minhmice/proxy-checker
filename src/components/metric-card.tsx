'use client';

import * as React from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Sparkline } from './sparkline';
import { cn } from '@/lib/utils';

interface MetricCardProps {
  label: string;
  value: string | number;
  sub: string;
  delta?: string;
  sparkData?: number[];
  sparkColor?: string;
  icon?: React.ReactNode;
  badgeVariant?: 'default' | 'secondary' | 'outline' | 'destructive';
  className?: string;
}

export function MetricCard({
  label,
  value,
  sub,
  delta,
  sparkData = [],
  sparkColor = 'var(--primary)',
  icon,
  badgeVariant = 'outline',
  className,
}: MetricCardProps) {
  return (
    <Card
      className={cn(
        'cyber-card relative overflow-hidden border-border/80 bg-card/90 shadow-sm backdrop-blur-md transition-all duration-200 hover:border-primary/50 hover:shadow-[0_8px_30px_-8px_oklch(0.78_0.17_205/0.25)]',
        className,
      )}
    >
      <div
        className="absolute top-0 inset-x-0 h-[2px] opacity-80"
        style={{ background: sparkColor }}
      />
      <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        {icon && (
          <div className="flex size-7 items-center justify-center rounded-md border border-border/80 bg-surface-raised/80 text-foreground shadow-2xs">
            {icon}
          </div>
        )}
      </CardHeader>
      <CardContent className="pt-0">
        <div className="flex items-baseline justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span
              className="relative flex size-2 shrink-0 items-center justify-center"
              aria-hidden="true"
            >
              <span
                className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 motion-reduce:hidden"
                style={{ backgroundColor: sparkColor }}
              />
              <span
                className="relative inline-flex size-1.5 rounded-full"
                style={{ backgroundColor: sparkColor }}
              />
            </span>
            <span className="text-3xl font-bold tracking-tight text-ink font-mono tabular-nums">
              {value == null || value === '' ? '—' : value}
            </span>
          </div>
          {sparkData && sparkData.length >= 2 && (
            <div className="shrink-0 opacity-90 transition-opacity hover:opacity-100">
              <Sparkline
                data={sparkData}
                color={sparkColor}
                width={92}
                height={38}
                label={`${label} trend`}
              />
            </div>
          )}
        </div>
        <div className="mt-3 flex items-center justify-between gap-2 pt-1 border-t border-border-subtle/60 text-xs text-muted-foreground">
          <span className="truncate">{sub}</span>
          {delta && (
            <Badge
              variant={badgeVariant}
              className="font-mono text-[10px] px-1.5 py-0 h-4 shrink-0 font-medium"
            >
              <span className="sr-only">Trend: </span>
              {delta}
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
