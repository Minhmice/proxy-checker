"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

export default function ProxyIntelligencePage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/proxies");
  }, [router]);

  return (
    <div className="flex h-[50vh] flex-col items-center justify-center gap-3 text-muted-foreground">
      <Loader2 className="h-6 w-6 animate-spin text-primary" />
      <p className="text-xs">Redirecting to unified Proxies workspace...</p>
    </div>
  );
}
