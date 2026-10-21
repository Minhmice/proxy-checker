import type { Metadata } from "next";
import "./globals.css";
import "@/components/dashboard-shell.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
export const metadata: Metadata = {
  title: "minhmiceProxy",
  description: "9Router proxy pool control dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){if(typeof window==='undefined')return;window.addEventListener('unhandledrejection',function(e){var r=e&&e.reason;if(r&&(r.name==='AbortError'||(typeof r.message==='string'&&r.message.includes('aborted')))){e.preventDefault();e.stopImmediatePropagation();}},true);})();`,
          }}
        />
      </head>
      <body>
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster richColors />
      </body>
    </html>
  );
}
