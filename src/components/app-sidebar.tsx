"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Globe,
  HelpCircle,
  Settings,
  LogOut,
  Server,
  Network,
  Activity,
  Bell,
} from "lucide-react";
import { useAuth } from "./auth-provider";
import { AntigravityQuotaWidget } from "./antigravity-quota-widget";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
} from "@/components/ui/sidebar";

const NAV_MAIN = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/proxies", label: "Proxies", icon: Globe },
  { href: "/help", label: "Help Center", icon: HelpCircle },
] as const;

const NAV_INFRASTRUCTURE = [
  { href: "/nodes", label: "Nodes", icon: Server },
  { href: "/proxy-endpoints", label: "Proxy Endpoints", icon: Network },
  { href: "/monitoring", label: "Monitoring", icon: Activity },
  { href: "/events", label: "Events", icon: Bell },
] as const;

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const pathname = usePathname();
  const { clearPassword } = useAuth();

  return (
    <Sidebar collapsible="icon" className="border-r border-sidebar-border bg-sidebar" {...props}>
      <SidebarHeader className="border-b border-sidebar-border/60 p-2.5">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild className="hover:bg-sidebar-accent/70 transition-colors">
              <Link href="/" className="flex items-center gap-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary via-primary to-primary/80 text-primary-foreground font-bold text-xs shadow-xs ring-1 ring-primary/30">
                  mP
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight min-w-0">
                  <span className="truncate font-semibold text-sidebar-foreground tracking-tight">minhmiceProxy</span>
                  <span className="truncate text-[11px] text-muted-foreground flex items-center gap-1.5 mt-0.5">
                    <span className="size-1.5 rounded-full bg-primary/60 shrink-0" />
                    Fleet Controller
                  </span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="px-2 py-3">
        <SidebarGroup>
          <SidebarGroupLabel className="text-xs uppercase tracking-wider text-muted-foreground font-semibold px-2 mb-1">
            Workspace
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              {NAV_MAIN.map((item) => {
                const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                const Icon = item.icon;
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      tooltip={item.label}
                      className="transition-all font-medium h-9 text-xs rounded-md data-[active=true]:font-semibold data-[active=true]:bg-primary/10 data-[active=true]:text-primary"
                    >
                      <Link href={item.href} className="flex items-center gap-2.5 w-full">
                        <Icon className="size-4 shrink-0" />
                        <span className="truncate flex-1">{item.label}</span>
                        {isActive && (
                          <span className="size-1.5 rounded-full bg-primary shrink-0 group-data-[collapsible=icon]:hidden shadow-[0_0_6px_var(--primary)]" />
                        )}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator className="my-2" />

        <SidebarGroup>
          <SidebarGroupLabel className="text-xs uppercase tracking-wider text-muted-foreground font-semibold px-2 mb-1">
            Infrastructure
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              {NAV_INFRASTRUCTURE.map((item) => {
                const isActive = pathname.startsWith(item.href);
                const Icon = item.icon;
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      tooltip={item.label}
                      className="transition-all font-medium h-9 text-xs rounded-md data-[active=true]:font-semibold data-[active=true]:bg-primary/10 data-[active=true]:text-primary"
                    >
                      <Link href={item.href} className="flex items-center gap-2.5 w-full">
                        <Icon className="size-4 shrink-0" />
                        <span className="truncate flex-1">{item.label}</span>
                        {isActive && (
                          <span className="size-1.5 rounded-full bg-primary shrink-0 group-data-[collapsible=icon]:hidden shadow-[0_0_6px_var(--primary)]" />
                        )}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator className="my-2" />

        <SidebarGroup>
          <SidebarGroupLabel className="text-xs uppercase tracking-wider text-muted-foreground font-semibold px-2 mb-1">
            System
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname.startsWith("/settings")}
                  tooltip="Settings"
                  className="transition-all font-medium h-9 text-xs rounded-md data-[active=true]:font-semibold data-[active=true]:bg-primary/10 data-[active=true]:text-primary"
                >
                  <Link href="/settings" className="flex items-center gap-2.5 w-full">
                    <Settings className="size-4 shrink-0" />
                    <span className="truncate flex-1">Settings</span>
                    {pathname.startsWith("/settings") && (
                      <span className="size-1.5 rounded-full bg-primary shrink-0 group-data-[collapsible=icon]:hidden shadow-[0_0_6px_var(--primary)]" />
                    )}
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-2 pb-16 md:pb-4 space-y-2">
        <AntigravityQuotaWidget />
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Sign out"
              onClick={clearPassword}
              className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors h-9"
            >
              <LogOut className="size-4 shrink-0" />
              <span>Sign out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

// Backward-compatibility export
export { AppSidebar as Sidebar };
