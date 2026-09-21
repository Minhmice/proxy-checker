import type { Metadata } from "next";
import "../globals.css";
import "@/components/dashboard-shell.css";
import { AuthProvider } from "@/components/auth-provider";

export const metadata: Metadata = {
  title: "Sign in · minhmiceProxy",
  description: "Secure access to minhmiceProxy control room",
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
