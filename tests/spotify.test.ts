import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SpotifyError, createSpotify } from "../src/server/spotify.js";

interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: string;
}

function setup(respond: (call: Call) => Response) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spotify-"));
  const file = path.join(dir, "spotify.json");
  const calls: Call[] = [];
  let time = 1_000_000;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      auth: new Headers(init?.headers).get("authorization"),
      body: String(init?.body ?? ""),
      method: init?.method ?? "GET",
      url: String(input),
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  const service = createSpotify({
    clientId: () => "client-1",
    file,
    now: () => time,
    redirectUri: () => "http://127.0.0.1:1300/api/spotify/callback",
  });
  return {
    advance: (ms: number) => {
      time += ms;
    },
    calls,
    file,
    restore: () => {
      globalThis.fetch = originalFetch;
      fs.rmSync(dir, { force: true, recursive: true });
    },
    service,
  };
}

const token = (extra: Record<string, unknown> = {}) =>
  Response.json({
    access_token: "access-1",
    expires_in: 3600,
    refresh_token: "refresh-1",
    ...extra,
  });

async function connect(ctx: ReturnType<typeof setup>) {
  const url = new URL(ctx.service.begin("http://127.0.0.1:1300"));
  await ctx.service.complete("code-1", url.searchParams.get("state") ?? "");
  return url;
}

test("login sends an S256 challenge that matches the verifier used at exchange", async () => {
  const ctx = setup(() => token());
  try {
    const url = await connect(ctx);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.match(url.searchParams.get("scope") ?? "", /user-modify-playback-state/);
    const exchange = new URLSearchParams(ctx.calls[0].body);
    const verifier = exchange.get("code_verifier") ?? "";
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    assert.equal(url.searchParams.get("code_challenge"), challenge);
    assert.equal(JSON.parse(fs.readFileSync(ctx.file, "utf8")).refreshToken, "refresh-1");
  } finally {
    ctx.restore();
  }
});

test("a callback state works once and unknown states are rejected", async () => {
  const ctx = setup(() => token());
  try {
    const state =
      new URL(ctx.service.begin("http://127.0.0.1:1300")).searchParams.get("state") ?? "";
    await ctx.service.complete("code-1", state);
    await assert.rejects(ctx.service.complete("code-1", state), (e: unknown) => {
      return e instanceof SpotifyError && e.code === "invalid_state";
    });
    await assert.rejects(ctx.service.complete("code-1", "forged"), SpotifyError);
  } finally {
    ctx.restore();
  }
});

test("an expired token refreshes once for concurrent reads and keeps the old refresh token", async () => {
  const ctx = setup((call) => {
    if (call.url.includes("/api/token")) {
      return new URLSearchParams(call.body).get("grant_type") === "refresh_token"
        ? Response.json({ access_token: "access-2", expires_in: 3600 })
        : token({ expires_in: 60 });
    }
    return new Response(null, { status: 204 });
  });
  try {
    await connect(ctx);
    ctx.advance(120_000);
    const results = await Promise.all([ctx.service.now(), ctx.service.now()]);
    assert.deepEqual(
      results.map((r) => r.status),
      ["idle", "idle"],
    );
    const refreshes = ctx.calls.filter((c) => c.body.includes("grant_type=refresh_token"));
    assert.equal(refreshes.length, 1);
    assert.equal(
      ctx.calls.filter((c) => c.url.endsWith("/me/player?additional_types=episode")).length,
      1,
    );
    assert.equal(JSON.parse(fs.readFileSync(ctx.file, "utf8")).refreshToken, "refresh-1");
    assert.equal(ctx.calls.at(-1)?.auth, "Bearer access-2");
  } finally {
    ctx.restore();
  }
});

test("a revoked refresh token disconnects instead of looping", async () => {
  const ctx = setup((call) =>
    call.url.includes("/api/token") && call.body.includes("refresh_token")
      ? Response.json({ error: "invalid_grant" }, { status: 400 })
      : token({ expires_in: 60 }),
  );
  try {
    await connect(ctx);
    ctx.advance(120_000);
    assert.equal((await ctx.service.now()).status, "disconnected");
    assert.equal(fs.existsSync(ctx.file), false);
  } finally {
    ctx.restore();
  }
});

test("now maps the player and control reports why Spotify refused", async () => {
  const ctx = setup((call) => {
    if (call.url.includes("/api/token")) return token();
    if (call.url.includes("/me/player/next")) {
      return Response.json({ error: { reason: "PREMIUM_REQUIRED" } }, { status: 403 });
    }
    if (call.url.includes("/me/player/pause")) return new Response(null, { status: 404 });
    return Response.json({
      device: { is_restricted: false, name: "Desk" },
      is_playing: true,
      item: {
        album: {
          images: [
            { url: "big", width: 640 },
            { url: "mid", width: 300 },
            { url: "tiny", width: 64 },
          ],
          name: "LP",
        },
        artists: [{ name: "A" }, { name: "B" }],
        duration_ms: 200_000,
        external_urls: { spotify: "https://open.spotify.com/track/1" },
        id: "1",
        name: "Song",
      },
      progress_ms: 5_000,
    });
  });
  try {
    await connect(ctx);
    const now = await ctx.service.now();
    assert.equal(now.title, "Song");
    assert.equal(now.artist, "A, B");
    assert.equal(now.art, "mid");
    assert.equal(now.playing, true);
    assert.equal(now.url, "https://open.spotify.com/track/1");
    await assert.rejects(ctx.service.control("next"), (e: unknown) => {
      return e instanceof SpotifyError && e.code === "premium_required" && e.status === 403;
    });
    await assert.rejects(ctx.service.control("pause"), (e: unknown) => {
      return e instanceof SpotifyError && e.code === "no_device";
    });
  } finally {
    ctx.restore();
  }
});
