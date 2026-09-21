"use client";

import { Bell, Menu, Search } from "lucide-react";
import { useAuth } from "./auth-provider";

interface TopBarProps {
  onSearchClick: () => void;
  onMenuClick: () => void;
  menuOpen: boolean;
}

export function TopBar({ onSearchClick, onMenuClick, menuOpen }: TopBarProps) {
  const { password, setPassword } = useAuth();

  return (
    <header className="topbar">
      <button type="button" className="topbar-menu" onClick={onMenuClick} aria-label={menuOpen ? "Close navigation" : "Open navigation"} aria-expanded={menuOpen}>
        <Menu size={20} aria-hidden />
      </button>
      <button type="button" className="topbar-search" onClick={onSearchClick} data-command-trigger>
        <Search size={18} aria-hidden />
        <span>Search anything…</span>
        <kbd>⌘K</kbd>
      </button>

      <div className="topbar-actions">
        {!password && (
          <label className="topbar-password-label" htmlFor="topbar-password">Control password
            <input id="topbar-password" type="password" className="topbar-password" placeholder="Enter password" autoComplete="current-password" aria-describedby="topbar-password-help" onChange={(e) => setPassword(e.target.value)} />
            <span id="topbar-password-help" className="sr-only">Used to authenticate with the proxy control API.</span>
          </label>
        )}
        <button type="button" className="topbar-icon-btn" aria-label="Notifications">
          <Bell size={20} />
          <span className="topbar-badge" />
        </button>
        <div className="topbar-user">
          <div className="topbar-avatar">TM</div>
          <div className="topbar-user-info">
            <strong>Totok Michael</strong>
            <span>admin@minhmiceproxy.local</span>
          </div>
        </div>
      </div>
    </header>
  );
}
