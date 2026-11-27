import test from "node:test";
import assert from "node:assert/strict";
import { controlMessage, formatClock, statusMessage } from "../src/lib/spotify-ui.js";
import type { SpotifyNow } from "../src/lib/types.js";

const base: SpotifyNow = {
  album: "",
  art: null,
  artist: "",
  canControl: false,
  device: null,
  durationMs: 0,
  playing: false,
  progressMs: 0,
  status: "idle",
  title: "",
  trackId: null,
  url: null,
};

test("formatClock pads seconds, rolls into hours, and never prints garbage", () => {
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(59_999), "0:59");
  assert.equal(formatClock(61_000), "1:01");
  assert.equal(formatClock(3_725_000), "1:02:05");
  assert.equal(formatClock(-5), "0:00");
  assert.equal(formatClock(Number.NaN), "0:00");
});

test("each control failure tells the owner something different to do", () => {
  const codes = [
    "premium_required",
    "no_device",
    "restricted",
    "rate_limited",
    "disconnected",
    "unconfigured",
  ];
  const messages = codes.map(controlMessage);
  assert.equal(new Set(messages).size, codes.length);
  assert.equal(controlMessage("anything-else"), controlMessage("upstream"));
});

test("status line is empty only when a track is on screen and the link is healthy", () => {
  assert.equal(statusMessage({ ...base, status: "ready", title: "x" }, false), null);
  assert.match(statusMessage({ ...base, status: "ready", title: "x" }, true) ?? "", /last known/);
  assert.match(statusMessage({ ...base, status: "disconnected" }, false) ?? "", /link/);
  assert.match(
    statusMessage({ ...base, status: "error", error: "rate_limited" }, false) ?? "",
    /limiting/,
  );
  assert.equal(statusMessage(null, false), null);
  assert.match(statusMessage(null, true) ?? "", /server/);
});
