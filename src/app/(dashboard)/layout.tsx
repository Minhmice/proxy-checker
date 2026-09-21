"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AuthProvider, useAuth } from "@/components/auth-provider";
import { CommandPalette, useCommandPalette } from "@/components/command-palette";
import { RightPanel } from "@/components/right-panel";
import { Sidebar } from "@/components/sidebar";
import { TopBar } from "@/components/topbar";
import KineticGrid from "@/components/ui/kinetic-grid";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { open, setOpen, close } = useCommandPalette();

  return (
    <AuthProvider>
      <DashboardFrame open={open} setOpen={setOpen} close={close}>{children}</DashboardFrame>
    </AuthProvider>
  );
}

function DashboardRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/auth"); }, [router]);
  return <div className="auth-loading" aria-busy="true" />;
}

function DashboardRedirectBoundary({ children }: { children: React.ReactNode }) {
  const { password } = useAuth();
  return password ? children : <DashboardRedirect />;
}

function AuthGate({ onSubmit }: { onSubmit: (password: string) => void }) {
  const [value, setValue] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (value.trim()) onSubmit(value);
  }

  return (
    <section className="auth-gate" aria-labelledby="auth-gate-title">
      <div className="auth-gate-orbit auth-gate-orbit--one" />
      <div className="auth-gate-orbit auth-gate-orbit--two" />
      <div className="auth-gate-card">
        <div className="auth-gate-brand"><span className="auth-gate-mark">mP</span><span>minhmiceProxy</span></div>
        <div className="auth-gate-status"><span className="status-dot status-dot--ok" />Control plane secure</div>
        <h1 id="auth-gate-title">Enter the control room.</h1>
        <p className="auth-gate-lede">One password connects you to live proxy health, routing status, and 9Router operations.</p>
        <form onSubmit={submit} className="auth-gate-form">
          <label htmlFor="onboarding-password">Control password</label>
          <div className="auth-gate-input-wrap">
            <input id="onboarding-password" className="input auth-gate-input" type={showPassword ? "text" : "password"} autoComplete="current-password" autoFocus value={value} onChange={(event) => setValue(event.target.value)} placeholder="Enter your control password" />
            <button type="button" className="auth-gate-toggle" onClick={() => setShowPassword((current) => !current)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? "Hide" : "Show"}</button>
          </div>
          <button type="submit" className="btn btn--primary btn--full auth-gate-submit" disabled={!value.trim()}>Open dashboard <span aria-hidden="true">→</span></button>
        </form>
        <div className="auth-gate-footnote"><span>Session expires at midnight</span><span className="auth-gate-lock">Encrypted in transit</span></div>
      </div>
    </section>
  );
}

function DashboardFrame({ children, open, setOpen, close }: { children: React.ReactNode; open: boolean; setOpen: (value: boolean) => void; close: () => void }) {
  const { password } = useAuth();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <>
      <KineticGrid className="dashboard-background" globalColor="default">
      <div className="app-shell">
        <Sidebar mobileOpen={mobileNavOpen} onMobileClose={() => setMobileNavOpen(false)} />
        <div className="app-main">
          <TopBar onSearchClick={() => setOpen(true)} onMenuClick={() => setMobileNavOpen(true)} menuOpen={mobileNavOpen} />
          <div className="app-content-wrap">
            <main className="app-content">
              <DashboardRedirectBoundary>{children}</DashboardRedirectBoundary>
            </main>
            <RightPanel />
          </div>
        </div>
      </div>
      </KineticGrid>
      <CommandPalette open={open} onClose={close} />
    </>
  );
}
