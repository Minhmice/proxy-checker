'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthProvider, useAuth } from '@/components/auth-provider';
import {
  CommandPalette,
  useCommandPalette,
} from '@/components/command-palette';
import { RightPanel } from '@/components/right-panel';
import { AppSidebar } from '@/components/app-sidebar';
import { TopBar } from '@/components/topbar';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import KineticGrid from '@/components/ui/kinetic-grid';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { open, setOpen, close } = useCommandPalette();

  return (
    <AuthProvider>
      <DashboardFrame open={open} setOpen={setOpen} close={close}>
        {children}
      </DashboardFrame>
    </AuthProvider>
  );
}

function DashboardRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/auth');
  }, [router]);
  return <div className="auth-loading" aria-busy="true" />;
}

function DashboardRedirectBoundary({
  children,
}: {
  children: React.ReactNode;
}) {
  const { authenticated, password } = useAuth();
  return authenticated || Boolean(password) ? children : <DashboardRedirect />;
}

function DashboardFrame({
  children,
  open,
  setOpen,
  close,
}: {
  children: React.ReactNode;
  open: boolean;
  setOpen: (value: boolean) => void;
  close: () => void;
}) {
  const [operationsOpen, setOperationsOpen] = useState(false);
  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:px-4 focus:py-2 focus:bg-primary focus:text-primary-foreground focus:rounded-md focus:shadow-lg focus:outline-none"
      >
        Skip to main content
      </a>
      <KineticGrid className="dashboard-background" globalColor="default">
        <SidebarProvider defaultOpen={true}>
          <AppSidebar />
          <SidebarInset className="flex flex-col min-w-0 bg-background">
            <TopBar
              onSearchClick={() => setOpen(true)}
              onOperationsClick={() => setOperationsOpen((current) => !current)}
              operationsOpen={operationsOpen}
            />
            <div className="flex flex-1 min-h-0 overflow-hidden">
              <main
                id="main-content"
                className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8 3xl:p-10 5xl:p-12 min-w-0 cyber-grid-bg"
              >
                <DashboardRedirectBoundary>
                  {children}
                </DashboardRedirectBoundary>
              </main>
              <RightPanel
                open={operationsOpen}
                onOpenChange={setOperationsOpen}
              />
            </div>
          </SidebarInset>
        </SidebarProvider>
      </KineticGrid>
      <CommandPalette open={open} onClose={close} />
    </>
  );
}
