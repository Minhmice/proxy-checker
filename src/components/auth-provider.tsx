"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { checkSession, logout as apiLogout } from "@/lib/api";

export interface AuthContextValue {
  authenticated: boolean;
  setAuthenticated: (value: boolean) => void;
  clearSession: () => void;
  // Compatibility fields
  password: string;
  setPassword: (value: string) => void;
  clearPassword: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    checkSession(controller.signal)
      .then((ok) => {
        if (!controller.signal.aborted) {
          setAuthenticated(ok);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setAuthenticated(false);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setHydrated(true);
        }
      });

    return () => {
      controller.abort();
    };
  }, []);

  const clearSession = useCallback(() => {
    setAuthenticated(false);
    void apiLogout();
  }, []);

  const value = useMemo(
    () => ({
      authenticated,
      setAuthenticated,
      clearSession,
      password: "",
      setPassword: (val: string) => {
        if (val) setAuthenticated(true);
      },
      clearPassword: clearSession,
    }),
    [authenticated, clearSession]
  );

  if (!hydrated) {
    return <div className="auth-loading" aria-busy="true" />;
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
