"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useAuth } from "./auth-provider";
import { fetchPools } from "@/lib/api";
import type { PoolRecord } from "@/lib/types";
import "./command-palette.css";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const { password } = useAuth();
  const [query, setQuery] = useState("");
  const [pools, setPools] = useState<PoolRecord[]>([]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (wasOpen.current && !open) document.querySelector<HTMLElement>("[data-command-trigger]")?.focus();
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    if (!open || !password) return;
    fetchPools(password).then(setPools).catch(() => setPools([]));
    setQuery("");
  }, [open, password]);

  const filtered = pools.filter(
    (p) =>
      p.name.toLowerCase().includes(query.toLowerCase()) ||
      p.exit_ip?.includes(query) ||
      p.proxyUrl.toLowerCase().includes(query.toLowerCase())
  );

  const handleKey = useCallback(
    (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        if (open) onClose();
      }
      if (event.key === "Escape" && open) onClose();
      if (event.key === "Tab" && open) {
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>("input, a[href], button:not([disabled])");
        if (!focusable?.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    },
    [open, onClose]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleKey]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>("input")?.focus());
  }, [open]);

  if (!open) return null;

  return (
    <div className="command-backdrop" onClick={onClose} role="presentation">
      <dialog ref={dialogRef} className="command-dialog" open aria-modal="true" aria-labelledby="command-dialog-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="command-dialog-title" className="sr-only">Search proxy pools</h2>
        <div className="command-input-wrap">
          <Search size={18} aria-hidden />
          <label className="sr-only" htmlFor="command-search">Search proxy pools</label>
          <input
            id="command-search"
            autoFocus
            className="command-input"
            placeholder="Search pools by name, IP, or URL…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd className="command-kbd">Esc</kbd>
        </div>
        <ul className="command-results">
          {filtered.length === 0 && <li className="command-empty">No pools match</li>}
          {filtered.slice(0, 12).map((pool) => (
            <li key={pool.localId}>
              <a href="/proxies" className="command-item" onClick={onClose}>
                <span className="command-item-name">{pool.name}</span>
                <span className="command-item-meta mono">{pool.exit_ip ?? pool.tier}</span>
              </a>
            </li>
          ))}
        </ul>
      </dialog>
    </div>
  );
}

export function useCommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return { open, setOpen, close: () => setOpen(false) };
}
