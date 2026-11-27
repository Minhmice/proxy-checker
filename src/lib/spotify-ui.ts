import type { SpotifyNow } from "./types";

/** `m:ss`, or `h:mm:ss` past an hour. Negative and non-finite input reads as 0:00. */
export function formatClock(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** What went wrong with a play, pause or skip, and what to do about it. */
export function controlMessage(code: string): string {
  switch (code) {
    case "premium_required":
      return "Controlling playback needs Spotify Premium.";
    case "no_device":
      return "No active Spotify device. Open Spotify on one and try again.";
    case "restricted":
      return "This device does not accept remote control.";
    case "rate_limited":
      return "Spotify is limiting requests. Try again in a moment.";
    case "disconnected":
      return "Spotify is no longer linked. Link it again in Settings.";
    case "unconfigured":
      return "Spotify is not set up on this server.";
    default:
      return "Spotify did not respond. Try again.";
  }
}

/** The line under the player when there is no track to show, else `null`. */
export function statusMessage(now: SpotifyNow | null, unreachable: boolean): string | null {
  if (!now) return unreachable ? "Could not reach the server." : null;
  switch (now.status) {
    case "unconfigured":
      return "Spotify is not set up. Add SPOTIFY_CLIENT_ID to .env.";
    case "disconnected":
      return "Spotify is not linked. Sign in, then link it in Settings.";
    case "idle":
      return "Nothing is playing. Start Spotify on any device.";
    case "error":
      return now.error === "rate_limited"
        ? "Spotify is limiting requests. Retrying."
        : "Spotify is unreachable. Retrying.";
    default:
      return unreachable ? "Connection lost. Showing the last known track." : null;
  }
}
