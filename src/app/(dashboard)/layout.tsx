"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { AuthProvider, useAuth } from "@/components/auth-provider";
import { AccountQuotaProvider } from "@/components/antigravity-quota-widget";
import { TopBar } from "@/components/topbar";
import { SidebarProvider } from "@/components/ui/sidebar";
import DitherFrame from "@/components/ui/dither-frame";
import { LoadingAnimation } from "@/components/ui/loading-animation";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardRedirectBoundary>
        <AccountQuotaProvider>
          <DashboardFrame>{children}</DashboardFrame>
        </AccountQuotaProvider>
      </DashboardRedirectBoundary>
    </AuthProvider>
  );
}

function DashboardRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/auth");
  }, [router]);
  return <LoadingAnimation session loadingLabel="Redirecting to sign in" />;
}

function DashboardRedirectBoundary({ children }: { children: React.ReactNode }) {
  const { authenticated, password } = useAuth();
  return authenticated || Boolean(password) ? children : <DashboardRedirect />;
}

function DashboardFrame({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:px-4 focus:py-2 focus:bg-primary focus:text-primary-foreground focus:rounded-md focus:shadow-lg focus:outline-none"
      >
        Skip to main content
      </a>
      <DitherFrame className="dashboard-background dashboard-session-enter">
        <SidebarProvider defaultOpen={true}>
          <div className="flex min-h-dvh w-full min-w-0 flex-col bg-transparent">
            <TopBar />
            <main
              id="main-content"
              tabIndex={-1}
              className="min-w-0 flex-1 p-4 md:p-6 lg:pb-3 cyber-grid-bg"
            >
              {children}
            </main>
          </div>
        </SidebarProvider>
      </DitherFrame>
    </>
  );
}
