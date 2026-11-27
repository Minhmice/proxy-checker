"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Settings, LogOut, BarChart3, Flame } from "lucide-react";
import { useAuth } from "./auth-provider";
import { AntigravityQuotaWidget, useAccountQuota } from "./antigravity-quota-widget";
import { cn } from "@/lib/utils";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
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
  const { isMobile, setOpenMobile } = useSidebar();
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
            ? "flame-gradient-active text-white font-semibold"
            : "text-sidebar-foreground/80 dither-hover hover:text-sidebar-foreground",
          "focus-visible:ring-1 focus-visible:ring-[#FF5B22] focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar",
        )}
      >
        <Link
          href={href}
          onClick={handleClick}
          onNavigate={() => {
            if (isMobile) {
              setOpenMobile(false);
              window.setTimeout(() => document.getElementById("main-content")?.focus(), 350);
            }
          }}
          aria-current={isActive ? "page" : undefined}
          className="flex items-center gap-2.5 w-full group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0"
        >
          {isActive && (
            <span className="absolute left-0 top-1 bottom-1 w-[3px] rounded-r-full flame-border-beam group-data-[collapsible=icon]:hidden" />
          )}
          <Icon
            className={cn(
              "size-4 shrink-0 transition-transform duration-200 group-hover:scale-110",
              isActive
                ? "text-[#FFAA00]"
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
                <Flame className="size-3.5 text-[#FFAA00] flame-flicker-active" />
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
  const { isMobile, setOpenMobile } = useSidebar();
  const quota = useAccountQuota();

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
                onNavigate={() => {
                  if (isMobile) {
                    setOpenMobile(false);
                    window.setTimeout(() => document.getElementById("main-content")?.focus(), 350);
                  }
                }}
                className="flex items-center gap-3 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0"
              >
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground font-black text-sm flame-logo-core ring-1 ring-white/15">
                  <span className="relative z-10">mP</span>
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight min-w-0 group-data-[collapsible=icon]:hidden">
                  <span className="truncate font-bold text-white tracking-tight text-[13px]">
                    minhmiceProxy
                  </span>
                  <span className="truncate text-[10px] text-muted-foreground/80 flex items-center gap-1 mt-0.5 font-medium">
                    <Flame className="size-3 text-[#FFAA00] shrink-0" />
                    Quota &amp; Token Control
                  </span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="px-2 py-1.5 gap-0.5 scrollbar-thin group-data-[collapsible=icon]:px-0">
        <SidebarGroup className="p-0.5 group-data-[collapsible=icon]:p-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {NAV_ITEMS.map((item) => {
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
      </SidebarContent>
      <SidebarFooter className="border-t border-[#23232C] p-2 space-y-1.5 group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:items-center">
        <AntigravityQuotaWidget {...quota} />
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

export { AppSidebar as Sidebar };
