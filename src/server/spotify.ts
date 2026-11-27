import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SpotifyAction, SpotifyNow, SpotifyStatus } from "../lib/types.js";
import { writeJsonAtomicSync } from "./fs-atomic.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API_URL = "https://api.spotify.com/v1";
const SCOPES = "user-read-playback-state user-modify-playback-state";
const PENDING_TTL_MS = 10 * 60_000;
const CACHE_MS = 1_500;
const REFRESH_SKEW_MS = 30_000;
const TIMEOUT_MS = 8_000;

const ACTIONS = {
  next: ["POST", "/me/player/next"],
  pause: ["PUT", "/me/player/pause"],
  play: ["PUT", "/me/player/play"],
  previous: ["POST", "/me/player/previous"],
} as const satisfies Record<SpotifyAction, readonly [string, string]>;

export class SpotifyError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface Flow {
  verifier: string;
  returnTo: string;
  expiresAt: number;
}

interface Image {
  url?: string;
  width?: number | null;
}

interface PlayerPayload {
  is_playing?: boolean;
  progress_ms?: number | null;
  currently_playing_type?: string;
  device?: { name?: string; is_restricted?: boolean } | null;
  item?: {
    id?: string;
    name?: string;
    duration_ms?: number;
    artists?: { name?: string }[];
    album?: { name?: string; images?: Image[] };
    show?: { name?: string; publisher?: string };
    images?: Image[];
    external_urls?: { spotify?: string };
  } | null;
}

export interface SpotifyOptions {
  clientId?: () => string;
  redirectUri?: () => string;
  file?: string;
  now?: () => number;
}

const emptyNow = (status: SpotifyStatus, error?: string): SpotifyNow => ({
  album: "",
  art: null,
  artist: "",
  canControl: false,
  device: null,
  durationMs: 0,
  playing: false,
  progressMs: 0,
  status,
  title: "",
  trackId: null,
  url: null,
  ...(error ? { error } : {}),
});

/** Smallest cover that is at least 160px wide, else the smallest offered. */
const pickArt = (images: Image[] = []): string | null => {
  const sized = images.filter((image): image is Image & { url: string } => !!image.url);
  const fit = sized
    .filter((image) => (image.width ?? 0) >= 160)
    .sort((a, b) => (a.width ?? 0) - (b.width ?? 0))[0];
  return (fit ?? sized.at(-1))?.url ?? null;
};

const mapPlayer = (data: PlayerPayload): SpotifyNow => {
  const item = data.item ?? null;
  const artists = item?.artists?.flatMap((artist) => (artist.name ? [artist.name] : [])) ?? [];
  return {
    album: item?.album?.name ?? "",
    art: pickArt(item?.album?.images ?? item?.images),
    artist: artists.length ? artists.join(", ") : (item?.show?.publisher ?? item?.show?.name ?? ""),
    canControl: data.device?.is_restricted !== true,
    device: data.device?.name ?? null,
    durationMs: item?.duration_ms ?? 0,
    playing: data.is_playing === true,
    progressMs: data.progress_ms ?? 0,
    status: "ready",
    title: item?.name ?? (data.currently_playing_type === "ad" ? "Advertisement" : "Unknown title"),
    trackId: item?.id ?? null,
    url: item?.external_urls?.spotify ?? null,
  };
};

/** What the routes and the card rely on; the factory below is the only implementation. */
export interface SpotifyService {
  configured(): boolean;
  /** Starts a login. `returnTo` is the origin the owner started from. Returns the Spotify URL. */
  begin(returnTo: string): string;
  /** Finishes a login and returns the `returnTo` it was started with. */
  complete(code: string, state: string): Promise<string>;
  now(): Promise<SpotifyNow>;
  control(action: SpotifyAction): Promise<void>;
}

/**
 * Spotify link: PKCE login, token refresh, now-playing and transport controls.
 * Tokens live in one JSON file in the data dir; the client id is public, so there is no secret.
 * ponytail: one linked account, in-memory login state; add a store if this ever runs multi-process.
 */
export function createSpotify(options: SpotifyOptions = {}): SpotifyService {
  const clientId = options.clientId ?? (() => process.env.SPOTIFY_CLIENT_ID?.trim() ?? "");
  const redirectUri =
    options.redirectUri ??
    (() =>
      process.env.SPOTIFY_REDIRECT_URI?.trim() ||
      `http://127.0.0.1:${process.env.PORT || 1300}/api/spotify/callback`);
  const file =
    options.file ??
    path.join(path.resolve(process.env.APP_DATA_DIR || path.join(root, "data")), "spotify.json");
  const clock = options.now ?? Date.now;
  const http = (url: string, init: RequestInit) =>
    globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

  let tokens: Tokens | null | undefined;
  const load = (): Tokens | null => {
    if (tokens !== undefined) return tokens;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Tokens>;
      tokens =
        typeof raw.accessToken === "string" &&
        typeof raw.refreshToken === "string" &&
        typeof raw.expiresAt === "number"
          ? {
              accessToken: raw.accessToken,
              refreshToken: raw.refreshToken,
              expiresAt: raw.expiresAt,
            }
          : null;
    } catch {
      tokens = null;
    }
    return tokens;
  };
  const save = (next: Tokens | null) => {
    tokens = next;
    if (next) writeJsonAtomicSync(file, next);
    else fs.rmSync(file, { force: true });
  };

  const pending = new Map<string, Flow>();
  let cache: { at: number; value: SpotifyNow } | null = null;
  let inflight: Promise<SpotifyNow> | null = null;
  let refreshing: Promise<Tokens> | null = null;
  let blockedUntil = 0;

  async function exchange(body: Record<string, string>): Promise<Tokens> {
    const res = await http(TOKEN_URL, {
      body: new URLSearchParams({ client_id: clientId(), ...body }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    const data = (await res.json().catch(() => null)) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
    } | null;
    if (!res.ok || !data?.access_token) {
      throw data?.error === "invalid_grant"
        ? new SpotifyError("disconnected", 409)
        : new SpotifyError("upstream", 502);
    }
    return {
      accessToken: data.access_token,
      // A refresh response may omit the refresh token; keep the one we have.
      expiresAt: clock() + (data.expires_in ?? 3600) * 1000,
      refreshToken: data.refresh_token ?? load()?.refreshToken ?? "",
    };
  }

  function refresh(): Promise<Tokens> {
    if (refreshing) return refreshing;
    const run = (async () => {
      const current = load();
      if (!current) throw new SpotifyError("disconnected", 409);
      try {
        const next = await exchange({
          grant_type: "refresh_token",
          refresh_token: current.refreshToken,
        });
        save(next);
        return next;
      } catch (error) {
        if (error instanceof SpotifyError && error.code === "disconnected") save(null);
        throw error;
      }
    })();
    refreshing = run;
    const done = () => {
      if (refreshing === run) refreshing = null;
    };
    run.then(done, done);
    return run;
  }

  async function accessToken(): Promise<string> {
    const current = load();
    if (!current) throw new SpotifyError("disconnected", 409);
    if (current.expiresAt - REFRESH_SKEW_MS > clock()) return current.accessToken;
    return (await refresh()).accessToken;
  }

  async function call(method: string, pathname: string, retry = true): Promise<Response> {
    const res = await http(`${API_URL}${pathname}`, {
      headers: { Authorization: `Bearer ${await accessToken()}` },
      method,
    });
    if (res.status === 401 && retry) {
      const current = load();
      if (current) tokens = { ...current, expiresAt: 0 };
      return call(method, pathname, false);
    }
    return res;
  }

  async function fetchNow(): Promise<SpotifyNow> {
    if (clock() < blockedUntil) return emptyNow("error", "rate_limited");
    try {
      const res = await call("GET", "/me/player?additional_types=episode");
      if (res.status === 204) return emptyNow("idle");
      if (res.status === 429) {
        blockedUntil = clock() + (Number(res.headers.get("retry-after")) || 5) * 1000;
        return emptyNow("error", "rate_limited");
      }
      if (!res.ok) return emptyNow("error", res.status === 403 ? "forbidden" : "upstream");
      return mapPlayer((await res.json()) as PlayerPayload);
    } catch (error) {
      if (error instanceof SpotifyError && error.code === "disconnected") {
        return emptyNow("disconnected");
      }
      return emptyNow("error", "upstream");
    }
  }

  return {
    configured: () => clientId() !== "",

    /** Starts a login. `returnTo` is the origin the owner started from. */
    begin(returnTo: string): string {
      const id = clientId();
      if (!id) throw new SpotifyError("unconfigured", 503);
      const at = clock();
      for (const [key, flow] of pending) if (flow.expiresAt <= at) pending.delete(key);
      const state = crypto.randomBytes(24).toString("base64url");
      const verifier = crypto.randomBytes(48).toString("base64url");
      pending.set(state, { expiresAt: at + PENDING_TTL_MS, returnTo, verifier });
      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({
        client_id: id,
        code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        redirect_uri: redirectUri(),
        response_type: "code",
        scope: SCOPES,
        state,
      }).toString();
      return url.toString();
    },

    /** Finishes a login. `state` is the proof the owner started it, so no session is needed. */
    async complete(code: string, state: string): Promise<string> {
      const flow = pending.get(state);
      pending.delete(state);
      if (!flow || flow.expiresAt <= clock()) throw new SpotifyError("invalid_state", 400);
      const next = await exchange({
        code,
        code_verifier: flow.verifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri(),
      });
      if (!next.refreshToken) throw new SpotifyError("upstream", 502);
      save(next);
      cache = null;
      blockedUntil = 0;
      return flow.returnTo;
    },

    now(): Promise<SpotifyNow> {
      if (!clientId()) return Promise.resolve(emptyNow("unconfigured"));
      if (!load()) return Promise.resolve(emptyNow("disconnected"));
      if (cache && clock() - cache.at < CACHE_MS) return Promise.resolve(cache.value);
      // Every open tab shares one upstream request.
      inflight ??= fetchNow()
        .then((value) => {
          cache = { at: clock(), value };
          return value;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },

    async control(action: SpotifyAction): Promise<void> {
      if (!clientId()) throw new SpotifyError("unconfigured", 503);
      const [method, pathname] = ACTIONS[action];
      let res: Response;
      try {
        res = await call(method, pathname);
      } catch (error) {
        throw error instanceof SpotifyError ? error : new SpotifyError("upstream", 502);
      }
      cache = null;
      if (res.ok) return;
      const body = (await res.json().catch(() => null)) as { error?: { reason?: string } } | null;
      if (res.status === 429) throw new SpotifyError("rate_limited", 429);
      if (res.status === 404) throw new SpotifyError("no_device", 404);
      if (res.status === 403) {
        throw new SpotifyError(
          body?.error?.reason === "PREMIUM_REQUIRED" ? "premium_required" : "restricted",
          403,
        );
      }
      throw new SpotifyError("upstream", 502);
    },
  };
}

let shared: SpotifyService | undefined;
export const getSpotify = (): SpotifyService => {
  shared ??= createSpotify();
  return shared;
};
