import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function HelpPage() {
  return (
    <main className="max-w-4xl 3xl:max-w-5xl 5xl:max-w-6xl mx-auto space-y-8 p-4 sm:p-6 text-foreground">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Help &amp; Operations Reference</h1>
          <p className="text-sm text-muted-foreground">
            Runbook for router synchronization, single-account quota rotation, and telemetry.
          </p>
        </div>
        <nav aria-label="Quick routes" className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm" className="min-h-[44px]">
            <Link href="/">Dashboard</Link>
          </Button>
          <Button asChild variant="outline" size="sm" className="min-h-[44px]">
            <Link href="/settings">Settings</Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="min-h-[44px]">
            <Link href="/help/components">UI Components</Link>
          </Button>
        </nav>
      </header>

      {/* 1. Antigravity Single-Account Rotation Policy */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">
          Antigravity Single-Account Rotation
        </h2>
        <div className="space-y-2 text-xs text-muted-foreground">
          <p>
            Rotation evaluates{" "}
            <strong className="text-foreground">Gemini session quota only</strong>. Claude, GPT, and
            weekly quotas are informational and do not influence rotation.
          </p>
          <ul className="list-disc list-inside space-y-1">
            <li>
              <strong className="text-foreground">Single active account:</strong> Exactly one
              Antigravity account remains active globally across configured 9Router endpoints at
              steady state.
            </li>
            <li>
              <strong className="text-foreground">Sampled rotation threshold:</strong> Each account
              activation receives a uniformly sampled threshold between 10% and 20% inclusive,
              persisted across restarts and forced refreshes.
            </li>
            <li>
              <strong className="text-foreground">Rotation triggers:</strong> Rotation is triggered
              when the active account&apos;s session quota drops to or below its threshold, or when
              an account error is detected.
            </li>
            <li>
              <strong className="text-foreground">Activation candidate:</strong> Eligible standby
              accounts must have valid available quota strictly greater than 20% and no active
              error, prioritized by earliest reset time.
            </li>
            <li>
              <strong className="text-foreground">Activate-before-deactivate handoff:</strong> A
              replacement account is confirmed enabled before deactivating the prior account. If
              activation fails or no eligible candidate exists, the current account is retained.
            </li>
          </ul>
        </div>
      </section>

      {/* 2. Router Synchronization & Concurrency */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">
          9Router Synchronization &amp; Transport
        </h2>
        <ul className="list-disc list-inside space-y-1.5 text-xs text-muted-foreground">
          <li>
            <strong className="text-foreground">Endpoint reconciliation:</strong> Synchronizes
            connection state and model token telemetry across configured 9Router endpoints.
          </li>
          <li>
            <strong className="text-foreground">Non-blocking concurrency:</strong> 9Router
            synchronization and Antigravity quota rotation run concurrently without shared blocking
            mutexes.
          </li>
          <li>
            <strong className="text-foreground">Direct connection:</strong> Antigravity connections
            operate directly through 9Router upstream nodes without intermediate proxy pools.
          </li>
        </ul>
      </section>

      {/* 3. Session Authentication */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Authentication &amp; Sessions</h2>
        <p className="text-xs text-muted-foreground">
          Dashboard sessions use an <code className="font-mono">HttpOnly</code> session cookie with
          a static 24-hour TTL (86,400s) from login. Sessions expire strictly 24 hours after
          issuance without sliding extensions or midnight resets.
        </p>
      </section>
    </main>
  );
}
