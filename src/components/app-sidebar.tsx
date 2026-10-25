"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
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
  BarChart3,
  Shuffle,
  Flame,
} from "lucide-react";
import { useAuth } from "./auth-provider";
import { AntigravityQuotaWidget } from "./antigravity-quota-widget";
import { FleetUpdateBanner } from "@/components/fleet/update-notifier";
import { cn } from "@/lib/utils";
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

const NAV_NINEROUTER = [
  { href: "/ninerouter/dashboard", label: "Dashboard", icon: BarChart3 },
  { href: "/ninerouter/proxies", label: "Proxies & Bindings", icon: Shuffle },
] as const;

function NavMenuItem({
  href,
  label,
  icon: Icon,
  isActive,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  isActive: boolean;
}) {
  const [isIgnited, setIsIgnited] = React.useState(false);
  const timerRef = React.useRef<number | undefined>(undefined);

  React.useEffect(() => {
    if (isActive) {
      setIsIgnited(true);
      clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        setIsIgnited(false);
      }, 1800);
    } else {
      setIsIgnited(false);
      clearTimeout(timerRef.current);
    }
    return () => {
      clearTimeout(timerRef.current);
    };
  }, [isActive]);

  const handleClick = () => {
    setIsIgnited(false);
    clearTimeout(timerRef.current);
    requestAnimationFrame(() => {
      setIsIgnited(true);
      timerRef.current = window.setTimeout(() => {
        setIsIgnited(false);
      }, 1800);
    });
  };

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip={label}
        className={cn(
          "relative transition-all font-medium h-9 text-xs rounded-lg overflow-hidden group border-0",
          isActive
            ? "flame-gradient-active text-white font-semibold shadow-[0_0_18px_-3px_rgba(255,91,34,0.35)]"
            : "text-sidebar-foreground/80 hover:bg-white/[0.04] hover:text-sidebar-foreground",
          "focus-visible:ring-1 focus-visible:ring-[#FF5B22] focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar",
        )}
      >
        <Link
          href={href}
          onClick={handleClick}
          className="flex items-center gap-2.5 w-full group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0"
        >
          {isActive && (
            <span className="absolute left-0 top-1 bottom-1 w-[3px] rounded-r-full flame-border-beam group-data-[collapsible=icon]:hidden" />
          )}
          <Icon
            className={cn(
              "size-4 shrink-0 transition-transform duration-200 group-hover:scale-110",
              isActive
                ? "text-[#FFAA00] drop-shadow-[0_0_8px_rgba(255,91,34,0.8)]"
                : "text-muted-foreground group-hover:text-sidebar-foreground",
            )}
          />
          <span className="truncate flex-1 tracking-tight group-data-[collapsible=icon]:hidden">
            {label}
          </span>
          <AnimatePresence>
            {isIgnited && (
              <motion.span
                initial={{ opacity: 0, scale: 0.5, y: 2 }}
                animate={{ opacity: 1, scale: [0.5, 1.3, 1], y: 0 }}
                exit={{
                  opacity: 0,
                  scale: 0.75,
                  y: -6,
                  transition: { duration: 0.45, ease: "easeOut" },
                }}
                transition={{ duration: 0.28, ease: "easeOut" }}
                className="shrink-0 flex items-center group-data-[collapsible=icon]:hidden pointer-events-none"
              >
                <Flame className="size-3.5 text-[#FFAA00] flame-flicker-active drop-shadow-[0_0_8px_rgba(255,170,0,0.85)]" />
              </motion.span>
            )}
          </AnimatePresence>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const pathname = usePathname();
  const { clearPassword } = useAuth();

  return (
    <Sidebar collapsible="icon" className="border-r border-[#23232C] bg-[#09090C]" {...props}>
      <SidebarHeader className="border-b border-[#23232C] p-2.5 group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:items-center">
        <SidebarMenu>
          <SidebarMenuItem className="group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center">
            <SidebarMenuButton
              size="lg"
              asChild
              className="hover:bg-white/[0.04] transition-all group-data-[collapsible=icon]:size-9! group-data-[collapsible=icon]:p-0! group-data-[collapsible=icon]:justify-center"
            >
              <Link
                href="/"
                className="flex items-center gap-3 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0"
              >
                <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#FF5B22] via-[#FF3D00] to-[#FFAA00] text-white font-black text-sm flame-logo-core shadow-[0_0_20px_rgba(255,91,34,0.45)] ring-1 ring-white/20">
                  mP
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight min-w-0 group-data-[collapsible=icon]:hidden">
                  <span className="truncate font-bold text-white tracking-tight text-[13px]">
                    minhmiceProxy
                  </span>
                  <span className="truncate text-[10px] text-muted-foreground/80 flex items-center gap-1 mt-0.5 font-medium">
                    <Flame className="size-3 text-[#FFAA00] animate-pulse shrink-0" />
                    Fleet Controller
                  </span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="px-2 py-1.5 gap-0.5 scrollbar-thin group-data-[collapsible=icon]:px-0">
        <SidebarGroup className="p-0.5 group-data-[collapsible=icon]:p-0">
          <SidebarGroupLabel className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold px-2 mb-1 group-data-[collapsible=icon]:hidden">
            Workspace
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {NAV_MAIN.map((item) => {
                const isActive =
                  item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                return (
                  <NavMenuItem
                    key={item.href}
                    href={item.href}
                    label={item.label}
                    icon={item.icon}
                    isActive={isActive}
                  />
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator className="my-1.5" />

        <SidebarGroup className="p-0.5 group-data-[collapsible=icon]:p-0">
          <SidebarGroupLabel className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold px-2 mb-1 group-data-[collapsible=icon]:hidden">
            Infrastructure
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {NAV_INFRASTRUCTURE.map((item) => {
                const isActive = pathname.startsWith(item.href);
                return (
                  <NavMenuItem
                    key={item.href}
                    href={item.href}
                    label={item.label}
                    icon={item.icon}
                    isActive={isActive}
                  />
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator className="my-1.5" />

        <SidebarGroup className="p-0.5 group-data-[collapsible=icon]:p-0">
          <SidebarGroupLabel className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold px-2 mb-1 group-data-[collapsible=icon]:hidden">
            9Router Modifier
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {NAV_NINEROUTER.map((item) => {
                const isActive = pathname.startsWith(item.href);
                return (
                  <NavMenuItem
                    key={item.href}
                    href={item.href}
                    label={item.label}
                    icon={item.icon}
                    isActive={isActive}
                  />
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator className="my-1.5" />

        <SidebarGroup className="p-0.5 group-data-[collapsible=icon]:p-0">
          <SidebarGroupLabel className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold px-2 mb-1 group-data-[collapsible=icon]:hidden">
            System
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              <NavMenuItem
                href="/settings"
                label="Settings"
                icon={Settings}
                isActive={pathname.startsWith("/settings")}
              />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-[#23232C] p-2 space-y-1.5 group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:items-center">
        <FleetUpdateBanner />
        <AntigravityQuotaWidget />
        <SidebarMenu>
          <SidebarMenuItem className="group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center">
            <SidebarMenuButton
              tooltip="Sign out"
              onClick={clearPassword}
              className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors h-9 text-xs border-0 focus-visible:ring-1 focus-visible:ring-destructive focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar group-data-[collapsible=icon]:size-9! group-data-[collapsible=icon]:justify-center"
            >
              <LogOut className="size-4 shrink-0" />
              <span className="group-data-[collapsible=icon]:hidden">Sign out</span>
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
