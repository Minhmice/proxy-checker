import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Safely extracts host:port from a proxy URL without exposing credentials,
 * handling missing protocols and malformed inputs.
 */
export function formatProxyAddress(proxyUrl?: string | null): string {
  if (!proxyUrl) return "—";
  try {
    const toParse = proxyUrl.includes("://") ? proxyUrl : `http://${proxyUrl}`;
    const url = new URL(toParse);
    return `${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    const withoutUser = proxyUrl.replace(/^[a-zA-Z0-9+.-]+:\/\//, "").replace(/^[^@/]+@/, "");
    return withoutUser.split("/")[0] || "—";
  }
}
