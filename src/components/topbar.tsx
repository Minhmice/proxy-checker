"use client";

import * as React from "react";
import { BarChart3, LogOut, PanelRightOpen, Settings } from "lucide-react";
import Link from "next/link";
import { useAuth } from "./auth-provider";
import { Button } from "@/components/ui/button";
import { Status, StatusIndicator, StatusLabel } from "@/components/ui/status";
import { DitherDivider } from "@/components/ui/dither";
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
  onSearchClick?: () => void;
  onOperationsClick?: () => void;
  operationsOpen?: boolean;
}

export function TopBar({ onOperationsClick, operationsOpen }: TopBarProps) {
  const { clearPassword, authenticated, password } = useAuth();

  return (
    <header
      role="banner"
      className="sticky top-0 z-20 flex h-14 3xl:h-[var(--topbar-height,64px)] w-full shrink-0 items-center justify-between gap-2 border-b border-border bg-background/95 px-3 sm:px-4 3xl:px-6 backdrop-blur-sm"
    >
      <nav aria-label="Main navigation" className="flex items-center gap-2">
        <Button asChild variant="plain" size="sm">
          <Link href="/">Dashboard</Link>
        </Button>
        <Button asChild variant="plain" size="sm">
          <Link href="/settings">Settings</Link>
        </Button>
      </nav>

      <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
        {!authenticated && !password ? (
          <Button
            asChild
            variant="outline"
            size="sm"
            className="h-11 text-xs border-warning/40 bg-warning/10 text-warning hover:text-warning sm:h-8"
          >
            <Link href="/auth" aria-label="Session expired. Sign in">
              <span className="sm:hidden">Sign in</span>
              <span className="hidden sm:inline">Session Expired &bull; Sign in</span>
            </Link>
          </Button>
        ) : (
          <Status variant="success" className="hidden sm:inline-flex py-0.5 px-2.5 select-none">
            <StatusIndicator />
            <StatusLabel className="font-semibold text-[11px] uppercase tracking-wider">
              Session Active
            </StatusLabel>
          </Status>
        )}

        {onOperationsClick && (
          <Button
            variant="ghost"
            size="icon"
            className="relative size-11 sm:size-8 text-muted-foreground hover:text-foreground xl:hidden touch-manipulation"
            onClick={onOperationsClick}
            aria-label={operationsOpen ? "Close operations" : "Open operations"}
            aria-expanded={operationsOpen}
          >
            <PanelRightOpen className="size-4" />
            <span
              className={cn(
                "absolute right-1 top-1 size-1.5 rounded-full ring-2 ring-background",
                authenticated || Boolean(password) ? "bg-success" : "bg-warning",
              )}
            />
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="relative h-11 sm:h-8 gap-2 px-1.5 text-left font-normal focus-visible:ring-2 transition-colors touch-manipulation"
            >
              <div className="relative">
                <Avatar className="size-7 border border-border">
                  <AvatarFallback className="bg-surface-raised text-foreground text-xs font-semibold">
                    MM
                  </AvatarFallback>
                </Avatar>
                <span className="absolute bottom-0 right-0 size-2 rounded-full bg-success ring-2 ring-background" />
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
          <DropdownMenuContent align="end" className="w-56 border-border bg-popover" sideOffset={8}>
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
            <DropdownMenuSeparator className="bg-border" />
            <DropdownMenuGroup>
              <DropdownMenuItem asChild>
                <Link href="/" className="flex items-center gap-2 cursor-pointer text-xs">
                  <BarChart3 className="size-3.5 text-muted-foreground" />
                  <span>Dashboard</span>
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/settings" className="flex items-center gap-2 cursor-pointer text-xs">
                  <Settings className="size-3.5 text-muted-foreground" />
                  <span>Settings</span>
                </Link>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator className="bg-border" />
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
      <DitherDivider
        color="--primary"
        edge="left"
        length={12}
        className="pointer-events-none absolute bottom-0 left-0 h-1 w-24 opacity-30"
      />
    </header>
  );
}
