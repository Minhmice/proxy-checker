"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { LoadingAnimation } from "@/components/ui/loading-animation";
import { checkSession, clearStoredPassword, getStoredPassword, storePassword } from "@/lib/api";
import { isAbortError } from "@/lib/request-lifecycle";

export interface AuthContextValue {
  authenticated: boolean;
  setAuthenticated: (value: boolean) => void;
  clearSession: () => void;
  password: string;
  setPassword: (value: string) => void;
  clearPassword: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPasswordState] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const minLoadingMs = 520;

  useEffect(() => {
    const startedAt = performance.now();
    let mounted = true;
    let revealTimer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    const reveal = () => {
      const remaining = minLoadingMs - (performance.now() - startedAt);
      if (remaining <= 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        setHydrated(true);
        return;
      }
      revealTimer = setTimeout(() => {
        if (mounted && !controller.signal.aborted) setHydrated(true);
      }, remaining);
    };

    const saved = getStoredPassword();
    if (saved) {
      setPasswordState(saved);
      setAuthenticated(true);
    }

    async function verifySession() {
      try {
        const ok = await checkSession(controller.signal);
        if (!mounted || controller.signal.aborted) return;
        setAuthenticated(ok || Boolean(saved));
      } catch (err: unknown) {
        if (!mounted || controller.signal.aborted || isAbortError(err)) return;
        setAuthenticated(Boolean(saved));
      } finally {
        if (mounted && !controller.signal.aborted) reveal();
      }
    }

    void verifySession();

    return () => {
      mounted = false;
      controller.abort();
      clearTimeout(revealTimer);
    };
  }, []);

  const setPassword = useCallback((val: string) => {
    setPasswordState(val);
    if (val) {
      storePassword(val);
      setAuthenticated(true);
    }
  }, []);

  const clearSession = useCallback(() => {
    if (!window.dispatchEvent(new Event("dashboard:before-session-clear", { cancelable: true }))) {
      return;
    }
    window.dispatchEvent(new Event("dashboard:session-cleared"));
    setPasswordState("");
    setAuthenticated(false);
    void clearStoredPassword();
  }, []);

  const value = useMemo(
    () => ({
      authenticated,
      setAuthenticated,
      clearSession,
      password,
      setPassword,
      clearPassword: clearSession,
    }),
    [authenticated, password, setPassword, clearSession],
  );

  if (!hydrated) {
    return <LoadingAnimation session />;
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
