"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { checkSession, clearStoredPassword, getStoredPassword, storePassword } from "@/lib/api";
import { isAbortError } from "@/lib/request-lifecycle";

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
  const [password, setPasswordState] = useState("");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const saved = getStoredPassword();
    if (saved) {
      setPasswordState(saved);
      setAuthenticated(true);
    }

    const controller = new AbortController();
    checkSession(controller.signal)
      .then((ok) => {
        if (!controller.signal.aborted) {
          setAuthenticated(ok || Boolean(saved));
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setAuthenticated(Boolean(saved));
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
  useEffect(() => {
    const handleRejection = (event: PromiseRejectionEvent) => {
      if (isAbortError(event.reason)) {
        event.preventDefault();
      }
    };
    window.addEventListener("unhandledrejection", handleRejection);
    return () => window.removeEventListener("unhandledrejection", handleRejection);
  }, []);


  const setPassword = useCallback((val: string) => {
    setPasswordState(val);
    if (val) {
      storePassword(val);
      setAuthenticated(true);
    }
  }, []);

  const clearSession = useCallback(() => {
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
    [authenticated, password, setPassword, clearSession]
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
