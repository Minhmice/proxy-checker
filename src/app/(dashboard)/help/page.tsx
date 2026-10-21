import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function HelpPage() {
  return (
    <main className="max-w-4xl mx-auto space-y-8 p-4 sm:p-6 text-foreground">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Help & Operations Reference</h1>
          <p className="text-sm text-muted-foreground">
            Runbook for proxy checks, sync behavior, quota rotation, and fleet nodes.
          </p>
        </div>
        <nav aria-label="Quick routes" className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm" className="min-h-[44px]">
            <Link href="/proxies">Proxies</Link>
          </Button>
          <Button asChild variant="outline" size="sm" className="min-h-[44px]">
            <Link href="/nodes">Nodes</Link>
          </Button>
          <Button asChild variant="outline" size="sm" className="min-h-[44px]">
            <Link href="/settings">Settings</Link>
          </Button>
        </nav>
      </header>

      {/* 1. Proxy Status & UDP Semantics */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Proxy Status & Verdicts</h2>
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
          <div className="rounded-lg border border-border bg-card p-3 space-y-1">
            <dt className="font-mono text-xs font-semibold text-emerald-400 uppercase">working</dt>
            <dd className="text-xs text-muted-foreground">
              Passed latest check or safety audit. Does not guarantee a verified exit node or active routable state.
            </dd>
          </div>
          <div className="rounded-lg border border-border bg-card p-3 space-y-1">
            <dt className="font-mono text-xs font-semibold text-amber-400 uppercase">regressed</dt>
            <dd className="text-xs text-muted-foreground">
              Formerly working proxy that failed its latest connectivity check.
            </dd>
          </div>
          <div className="rounded-lg border border-border bg-card p-3 space-y-1">
            <dt className="font-mono text-xs font-semibold text-rose-400 uppercase">dead</dt>
            <dd className="text-xs text-muted-foreground">
              Unreachable or never verified. Persists in inventory; not guaranteed to be automatically culled.
            </dd>
          </div>
        </dl>
        <div className="rounded-md border border-border bg-card p-3 text-xs text-muted-foreground space-y-1">
          <strong className="text-foreground">UDP Measurements:</strong>
          <p>
            HTTP proxies do not support raw UDP probing, returning <code className="font-mono">UNSUPPORTED</code>.
            Recorded as <code className="font-mono">Unknown</code> (displayed as &quot;UDP not measured&quot;).
            Unsupported UDP probes do not penalize reliability or mark proxies as failed.
          </p>
        </div>
      </section>

      {/* 2. Manual Checks (409 & 502) */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Manual Checks: HTTP 409 & 502 Recovery</h2>
        <div className="space-y-2 text-xs">
          <div className="rounded-md border border-border bg-card p-3 space-y-1">
            <div className="font-medium text-foreground">
              <span className="font-mono text-amber-400">409 Conflict:</span> Proxy not linked
            </div>
            <p className="text-muted-foreground">
              Returned ONLY when the proxy has no linked 9Router pool (<code className="font-mono">remote_id</code> is missing).
              To resolve, push the proxy to 9Router via sync before testing.
            </p>
          </div>
          <div className="rounded-md border border-border bg-card p-3 space-y-1">
            <div className="font-medium text-foreground">
              <span className="font-mono text-rose-400">502 Bad Gateway:</span> Upstream transport failure
            </div>
            <p className="text-muted-foreground">
              Returned when 9Router upstream throws an error or reports transport failure.
              Check upstream daemon status and network reachability.
            </p>
          </div>
          <p className="text-muted-foreground">
            Neither 409 nor 502 changes proxy health status or writes a failed test history entry.
          </p>
        </div>
      </section>

      {/* 3. Pool Synchronization */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Pool Synchronization</h2>
        <ul className="list-disc list-inside space-y-1.5 text-xs text-muted-foreground">
          <li>
            <strong className="text-foreground">Automatic sync:</strong> Runs on a background interval (toggleable in Settings).
            Replaces dead proxies with live reserves without reassigning healthy proxies based solely on latency.
          </li>
          <li>
            <strong className="text-foreground">Manual sync:</strong> Triggers immediate pool reconciliation independently of the auto toggle.
          </li>
          <li>
            <strong className="text-foreground">Concurrency:</strong> 9Router sync and Antigravity account rotation run concurrently without a shared blocking mutex.
          </li>
        </ul>
      </section>

      {/* 4. Antigravity Rotation Policy */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Antigravity Account Rotation</h2>
        <div className="space-y-2 text-xs text-muted-foreground">
          <p>
            Rotation evaluates <strong className="text-foreground">Gemini session quota only</strong>.
            Claude, GPT, and weekly quotas are informational.
          </p>
          <ul className="list-disc list-inside space-y-1">
            <li>
              <strong className="text-foreground">Deactivation:</strong> Quota &le; configured threshold (default 20%) or active error.
            </li>
            <li>
              <strong className="text-foreground">Activation:</strong> Reserves qualify when quota &gt; configured threshold.
            </li>
            <li>
              <strong className="text-foreground">Priority:</strong> Earliest valid reset duration (<code className="font-mono">resetAt</code>). Missing timestamps sort last; account ID is tie-breaker.
            </li>
            <li>
              <strong className="text-foreground">Concurrency limit:</strong> Configured in Settings (default 3 active accounts).
            </li>
          </ul>
        </div>
      </section>

      {/* 5. Session Authentication */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Authentication & Sessions</h2>
        <p className="text-xs text-muted-foreground">
          Dashboard sessions use an <code className="font-mono">HttpOnly</code> session cookie with a static 24-hour TTL (86,400s) from login.
          Sessions expire strictly 24 hours after issuance without sliding extensions or midnight resets.
        </p>
      </section>

      {/* 6. Fleet Nodes & Diagnostics */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Worker Nodes & Host Diagnostics</h2>
        <div className="space-y-2 text-xs text-muted-foreground">
          <p>
            Nodes report heartbeats; status becomes <code className="font-mono text-rose-400">Offline</code> after 60 seconds without a heartbeat.
            The controller host is registered as an inventory node in <Link href="/nodes" className="text-primary underline">/nodes</Link>.
            Configuration changes advance <code className="font-mono">desired_revision</code>; if deployment fails, agent rolls back to <code className="font-mono">/etc/3proxy/3proxy.cfg.bak</code>.
          </p>
          <div className="rounded-md border border-border bg-black/60 p-3 font-mono text-xs space-y-1 text-emerald-400 overflow-x-auto">
            <div className="text-muted-foreground"># Status and logs</div>
            <div>systemctl status proxyfleet-agent</div>
            <div>journalctl -u proxyfleet-agent -f</div>
            <div className="text-muted-foreground pt-1"># Service restarts</div>
            <div>sudo systemctl restart proxyfleet-agent</div>
            <div>sudo systemctl restart 3proxy</div>
          </div>
        </div>
      </section>
    </main>
  );
}
