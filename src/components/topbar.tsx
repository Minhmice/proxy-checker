"use client";

import * as React from "react";
import {
  Bell,
  CheckCircle2,
  LogOut,
  PanelRightOpen,
  Search,
  Settings,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useAuth } from "./auth-provider";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

import { cn } from "@/lib/utils";
interface TopBarProps {
  onSearchClick: () => void;
  onOperationsClick: () => void;
  operationsOpen: boolean;
}

export function TopBar({ onSearchClick, onOperationsClick, operationsOpen }: TopBarProps) {
  const { clearPassword, authenticated, password } = useAuth();
  const [shortcutKey, setShortcutKey] = React.useState("⌘K");

  React.useEffect(() => {
    const isMac = typeof window !== "undefined" && /(Mac|iPhone|iPod|iPad)/i.test(navigator.platform || "");
    setShortcutKey(isMac ? "⌘K" : "Ctrl K");
  }, []);

  return (
    <header
      role="banner"
      className="sticky top-0 z-20 flex h-14 w-full shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-background/80 px-3 sm:px-4 backdrop-blur-md supports-[backdrop-filter]:bg-background/60"
    >
      <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
        <SidebarTrigger className="-ml-1 size-11 sm:size-8 text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors touch-manipulation" />
        <Separator orientation="vertical" className="mr-1 h-4 hidden sm:block" />

        {/* Adaptive search trigger: icon-only on very narrow mobile, full input on sm+ */}
        <Button
          variant="outline"
          size="sm"
          onClick={onSearchClick}
          aria-label="Search proxy pools"
          aria-keyshortcuts="Control+K"
          className="relative h-11 w-11 p-0 sm:h-8 sm:w-60 md:w-80 sm:px-3 sm:justify-start rounded-md border-border/60 bg-muted/30 text-xs text-muted-foreground font-normal shadow-none hover:bg-muted/60 hover:text-foreground hover:border-border transition-all touch-manipulation"
          data-command-trigger
        >
          <Search className="size-3.5 sm:mr-2 shrink-0 text-muted-foreground" />
          <span className="hidden sm:inline-block truncate">Search proxy pools...</span>
          <kbd className="pointer-events-none absolute right-1.5 top-1.5 hidden h-5 select-none items-center gap-0.5 rounded border border-border/60 bg-background/80 px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-90 md:flex">
            {shortcutKey}
          </kbd>
        </Button>
      </div>

      <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
        {/* Session status or sign-in link */}
        {!authenticated && !password ? (
          <Button
            asChild
            variant="outline"
            size="sm"
            className="h-11 text-xs border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 sm:h-8"
          >
            <Link href="/auth">Session Expired &bull; Sign in</Link>
          </Button>
        ) : (
          <Badge
            variant="outline"
            className="hidden sm:inline-flex items-center gap-1.5 border-border/80 bg-muted/40 text-muted-foreground text-xs font-medium py-0.5 px-2.5 select-none"
          >
            <span className="size-1.5 rounded-full bg-emerald-500 shrink-0" />
            <span>Session Active</span>
          </Badge>
        )}

        {/* Notification indicator */}
        <Button
          variant="ghost"
          size="icon"
          className="relative size-11 sm:size-8 text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors touch-manipulation"
          aria-label="Notifications"
        >
          <Bell className="size-4" />
          <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary" />
        </Button>

        <Separator orientation="vertical" className="h-4 hidden sm:block" />

        <Button
          variant="ghost"
          size="icon"
          className="relative size-11 sm:size-8 text-muted-foreground hover:bg-accent/60 hover:text-foreground xl:hidden touch-manipulation"
          onClick={onOperationsClick}
          aria-label={operationsOpen ? "Close operations" : "Open operations"}
          aria-expanded={operationsOpen}
        >
          <PanelRightOpen className="size-4" />
          <span className={cn("absolute right-1 top-1 size-1.5 rounded-full ring-2 ring-background", authenticated || Boolean(password) ? "bg-emerald-500" : "bg-amber-400")} />
        </Button>

        {/* User Account Dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="relative h-11 sm:h-8 gap-2 px-1.5 text-left font-normal hover:bg-accent/60 focus-visible:ring-1 transition-colors touch-manipulation"
            >
              <div className="relative">
                <Avatar className="size-7 border border-border/80 ring-1 ring-primary/20">
                  <AvatarFallback className="bg-primary/20 text-primary text-xs font-semibold">
                    MM
                  </AvatarFallback>
                </Avatar>
                <span className="absolute bottom-0 right-0 size-2 rounded-full bg-emerald-500 ring-2 ring-background" />
              </div>
              <div className="hidden md:flex flex-col text-left max-w-[120px]">
                <span className="text-xs font-semibold leading-none text-foreground truncate">
                  Minhmice
                </span>
                <span className="text-[10px] leading-none text-muted-foreground mt-0.5 truncate">
                  admin
                </span>
              </div>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56" sideOffset={8}>
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col space-y-1">
                <p className="text-xs font-semibold leading-none text-foreground truncate">
                  Minhmice
                </p>
                <p className="text-[11px] leading-none text-muted-foreground truncate">
                  admin@minhmiceproxy.local
                </p>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem asChild>
                <Link href="/" className="flex items-center gap-2 cursor-pointer text-xs">
                  <CheckCircle2 className="size-3.5 text-muted-foreground" />
                  <span>Overview</span>
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/proxies" className="flex items-center gap-2 cursor-pointer text-xs">
                  <ShieldCheck className="size-3.5 text-muted-foreground" />
                  <span>Proxies</span>
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/settings" className="flex items-center gap-2 cursor-pointer text-xs">
                  <Settings className="size-3.5 text-muted-foreground" />
                  <span>Settings</span>
                </Link>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={clearPassword}
              className="flex items-center gap-2 cursor-pointer text-xs text-destructive focus:text-destructive focus:bg-destructive/10"
            >
              <LogOut className="size-3.5" />
              <span>Sign out</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
