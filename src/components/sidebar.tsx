"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Globe,
  ScanSearch,
  HelpCircle,
  Settings,
  LogOut,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useState } from "react";
import { useAuth } from "./auth-provider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import "./dashboard-shell.css";

const NAV_ITEMS = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/proxies", label: "Proxies", icon: Globe },
  { href: "/diagnostics", label: "Diagnostics", icon: ScanSearch },
  { href: "/help", label: "Help Center", icon: HelpCircle },
] as const;

export function Sidebar({ mobileOpen, onMobileClose }: { mobileOpen: boolean; onMobileClose: () => void }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const { clearPassword } = useAuth();

  return (
    <>
    <aside className={`sidebar ${collapsed ? "sidebar--collapsed" : ""} ${mobileOpen ? "sidebar--mobile-open" : ""}`}>
      <div className="sidebar-header">
        <Link href="/" className="sidebar-logo">
          <span className="sidebar-logo-mark">mP</span>
          {!collapsed && <span className="sidebar-logo-text">minhmiceProxy</span>}
        </Link>
        <button
          type="button"
          className="sidebar-collapse"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </div>

      <nav className="sidebar-nav" aria-label="Main navigation">
        <p className="sidebar-nav-label" aria-hidden={collapsed}>Workspace</p>
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          const item = (
            <Link
              href={href}
              className={`sidebar-nav-item ${active ? "sidebar-nav-item--active" : ""}`}
              aria-current={active ? "page" : undefined}
              onClick={onMobileClose}
            >
              <Icon size={18} aria-hidden />
              {!collapsed && <span>{label}</span>}
            </Link>
          );
          return collapsed ? (
            <Tooltip key={href}>
              <TooltipTrigger asChild>{item}</TooltipTrigger>
              <TooltipContent side="right">{label}</TooltipContent>
            </Tooltip>
          ) : <span key={href}>{item}</span>;
        })}
      </nav>

      <div className="sidebar-footer">
        {collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                href="/settings"
                className={`sidebar-nav-item ${pathname.startsWith("/settings") ? "sidebar-nav-item--active" : ""}`}
                aria-current={pathname.startsWith("/settings") ? "page" : undefined}
                onClick={onMobileClose}
              >
                <Settings size={18} aria-hidden />
              </Link>
            </TooltipTrigger>
            <TooltipContent side="right">Settings</TooltipContent>
          </Tooltip>
        ) : (
          <Link
            href="/settings"
            className={`sidebar-nav-item ${pathname.startsWith("/settings") ? "sidebar-nav-item--active" : ""}`}
            aria-current={pathname.startsWith("/settings") ? "page" : undefined}
            onClick={onMobileClose}
          >
            <Settings size={18} aria-hidden />
            <span>Settings</span>
          </Link>
        )}
        <button type="button" className="sidebar-footer-link" onClick={clearPassword}>
          <LogOut size={18} aria-hidden />
          {!collapsed && <span>Logout</span>}
        </button>
      </div>
    </aside>
    {mobileOpen && <div className="sidebar-backdrop" role="presentation" onClick={onMobileClose} />}
    </>
  );
}
