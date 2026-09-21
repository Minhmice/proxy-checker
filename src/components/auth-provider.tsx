"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { clearStoredPassword, getStoredPassword, storePassword } from "@/lib/api";

interface AuthContextValue {
  password: string;
  setPassword: (value: string) => void;
  clearPassword: () => void;
  authenticated: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [password, setPasswordState] = useState("");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const saved = getStoredPassword();
    if (saved) setPasswordState(saved);
    setHydrated(true);
  }, []);

  const setPassword = useCallback((value: string) => {
    setPasswordState(value);
    if (value) storePassword(value);
  }, []);

  const clearPassword = useCallback(() => {
    setPasswordState("");
    clearStoredPassword();
  }, []);

  const value = useMemo(
    () => ({ password, setPassword, clearPassword, authenticated: Boolean(password) }),
    [password, setPassword, clearPassword]
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
