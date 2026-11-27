"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Status, StatusIndicator } from "@/components/ui/status";
import { fetchSpotifyNow } from "@/lib/api";
import type { SpotifyStatus } from "@/lib/types";

const COPY: Record<SpotifyStatus, { label: string; variant: "success" | "warning" | "default" }> = {
  disconnected: { label: "Not linked", variant: "warning" },
  error: { label: "Linked, unreachable", variant: "warning" },
  idle: { label: "Linked", variant: "success" },
  ready: { label: "Linked", variant: "success" },
  unconfigured: { label: "Not set up", variant: "default" },
};

/** Owner-only: starts the Spotify login. The player on the sign-in page works once this is done. */
export function SpotifyLinkCard() {
  const [status, setStatus] = useState<SpotifyStatus | null>(null);

  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get("spotify");
    if (result === "connected") toast.success("Spotify linked");
    if (result === "error") toast.error("Spotify link failed. Try again.");
    if (result) window.history.replaceState(null, "", window.location.pathname);
    const controller = new AbortController();
    fetchSpotifyNow(controller.signal)
      .then((now) => setStatus(now.status))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const copy = status ? COPY[status] : null;
  const linked = status === "idle" || status === "ready" || status === "error";

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">Spotify</CardTitle>
            <CardDescription>
              Shows now playing and play, pause and next on the sign-in page. Controls need Spotify
              Premium.
            </CardDescription>
          </div>
          {copy ? (
            <Status variant={copy.variant}>
              <StatusIndicator />
              {copy.label}
            </Status>
          ) : null}
        </div>
      </CardHeader>
      {status === "unconfigured" ? (
        <CardContent className="text-xs text-muted-foreground">
          Set <code className="font-mono">SPOTIFY_CLIENT_ID</code> in{" "}
          <code className="font-mono">.env</code> and restart. Register{" "}
          <code className="font-mono">http://127.0.0.1:&lt;PORT&gt;/api/spotify/callback</code> as
          the app's redirect URI; Spotify rejects <code className="font-mono">localhost</code>.
        </CardContent>
      ) : null}
      <CardFooter className="justify-end border-t bg-muted/10 px-6 py-4">
        {status === "unconfigured" ? (
          <Button type="button" size="sm" disabled>
            Link Spotify
          </Button>
        ) : (
          <Button asChild size="sm">
            <a href="/api/spotify/login">{linked ? "Link again" : "Link Spotify"}</a>
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
