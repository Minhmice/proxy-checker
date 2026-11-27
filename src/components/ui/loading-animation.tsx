"use client";

/**
 * LoadingAnimation
 * A scroll-driven loading animation. An orange pixel figure turns, centred on a pale-orange field.
 * Scrolling blows its pixels apart and sets the headline in selection frames. The call-to-action pulls the pixels
 * back together, the figure turns once as the loader, then `onComplete` fires.
 * Move the cursor and a faint design-tool layer (rulers, grid, selection frame, panels) shows under it.
 * The further you scroll, the more of that layer there is to find.
 *
 * Styles are scoped under `.la` in dashboard-shell.css.
 *
 * NOTE: the built-in figure frames are sampled from a third-party video of real people.
 * Pass your own `frames` (66x53, 1-bit, base64-packed) before publishing this publicly.
 */
import * as React from "react";
import { cn } from "@/lib/utils";

// <engine>
export type ChipRow = Array<[text: string, kind?: string]>;

export interface LoadingAnimationOptions {
  /** Name shown on the selection frame in the cursor layer. */
  name?: string;
  /** Role shown in the properties panel. */
  role?: string;
  /** Headline, one array per row. Each piece is [text, kind?]; kind "frame" wraps the text in a selection frame with handles. Spaces inside pieces are kept. */
  rows?: ChipRow[];
  /** Label on the call-to-action button. */
  cta?: string;
  /** Label above the progress bar while the figure turns. */
  loadingLabel?: string;
  /** Label shown when loading finishes (before `onComplete` takes the page elsewhere). */
  readyLabel?: string;
  replayLabel?: string;
  /** How much scrolling it takes to disperse the figure. Any CSS length. */
  scrollHeight?: string;
  /** Figure height as a fraction of the stage (0.2 to 1). Smaller means smaller pixels. */
  size?: number;
  /** How far the pixels travel when they disperse (0.2 to 2). */
  spread?: number;
  /** Show the design-tool layer under the cursor. */
  showReveal?: boolean;
  /** Play the whole sequence by itself, in a loop, with no scrolling. Use it for previews and embeds. */
  autoplay?: boolean;
  /** Render an indeterminate session loader, with loadingLabel supplied by the caller. */
  session?: boolean;
  colors?: Partial<{ accent: string; blue: string; ink: string; tint: string }>;
  /** Base64-packed 66x53 1-bit frames of a full turn. Defaults to the built-in turn. */
  frames?: string[];
  onGetStarted?: () => void;
  onComplete?: () => void;
}

const GW = 66;
const GH = 53;
const CELL_ASPECT = 14.65 / 10.8; // the source cells are slightly taller than wide
const FADE_ROWS = 9; // the bust is cut off at the bottom, so its last rows dissolve in a dither instead of a hard edge
/** Drops keys whose value is undefined, so a missing prop never overrides a default. */
const defined = <T extends object>(x: T): T =>
  Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined)) as T;
const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const smooth = (t: number) => {
  t = clamp(t);
  return t * t * (3 - 2 * t);
};
const hsh = (x: number, y: number) => ((((x * 73856093) ^ (y * 19349663)) >>> 0) % 1000) / 1000;
const esc = (t: string) =>
  t.replace(
    /[&<>"]/g,
    (c) =>
      (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }) as Record<string, string>)[c],
  );
const rgba = (hex: string, a: number) => {
  const h = hex.replace("#", ""),
    v = parseInt(
      h.length === 3
        ? h
            .split("")
            .map((c) => c + c)
            .join("")
        : h,
      16,
    );
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
};

const DEFAULT_ROWS: ChipRow[] = [
  [["You have "], ["consumed", "frame"], [" enough."]],
  [["It's time to "], ["create", "frame"], ["."]],
];

const HANDLES: Array<[number, number]> = [
  [0, 0],
  [50, 0],
  [100, 0],
  [0, 50],
  [100, 50],
  [0, 100],
  [50, 100],
  [100, 100],
];
const headRow = (items: ChipRow) =>
  `<span class="la-row" aria-hidden="true">${items
    .map(([t, k]) =>
      k === "frame"
        ? `<span class="la-t la-fr">${esc(t)}${HANDLES.map(([x, y]) => `<i style="left:${x}%;top:${y}%"></i>`).join("")}</span>`
        : `<span class="la-t">${esc(t)}</span>`,
    )
    .join("")}</span>`;

type Phase = "scroll" | "assemble" | "load" | "done";

export function mountLoadingAnimation(
  root: HTMLElement,
  opts: LoadingAnimationOptions = {},
): { destroy: () => void; replay: () => void } {
  opts = defined(opts);
  const col = {
    accent: "#FF5000",
    blue: "#1F3BFF",
    ink: "#23262F",
    ...defined(opts.colors || {}),
  };
  const rows = opts.rows && opts.rows.length ? opts.rows : DEFAULT_ROWS;
  const o = {
    name: "Asha Iyer",
    role: "Freelance designer",
    cta: "Create Now",
    loadingLabel: "Setting up your desk",
    readyLabel: "Desk ready",
    replayLabel: "Replay",
    scrollHeight: "320vh",
    size: 0.5,
    spread: 1,
    showReveal: true,
    autoplay: false,
    ...opts,
  };
  const pointerReveal = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const size = clamp(o.size, 0.2, 1),
    spread = clamp(o.spread, 0.2, 2);
  const reduced =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  root.classList.add("la");
  if (o.autoplay) root.classList.add("la-auto");
  if (o.session) root.classList.add("la-session");
  root.style.setProperty("--la-accent", col.accent);
  root.style.setProperty("--la-blue", col.blue);
  root.style.setProperty("--la-ink", col.ink);
  if (col.tint) root.style.setProperty("--la-tint", col.tint);
  else root.style.removeProperty("--la-tint");
  root.style.setProperty("--la-bluet", rgba(col.blue, 0.08));
  root.style.setProperty("--la-g1", rgba(col.accent, 0.09));
  root.style.setProperty("--la-g2", rgba(col.accent, 0.2));
  root.style.setProperty("--la-track", o.scrollHeight);
  root.innerHTML = `<div class="la-track"><div class="la-stage">
      <div class="la-grid" aria-hidden="true"></div>
      <canvas class="la-fig" aria-hidden="true"></canvas><canvas class="la-ui" aria-hidden="true"></canvas>
      <div class="la-top"><button class="la-skip" type="button">Skip</button></div>
      <div class="la-cue">Scroll<span></span></div>
      <div class="la-msg"><h1 class="la-h" aria-label="${esc(
        rows
          .map((r) => r.map((c) => c[0]).join(""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
      )}">${rows.map(headRow).join("")}</h1>
        <button class="la-cta" type="button" tabindex="-1" disabled>${esc(o.cta)}</button></div>
      <div class="la-load"><b role="status">${esc(o.loadingLabel)}</b><div class="la-bar" aria-hidden="true">${"<i></i>".repeat(16)}</div><button class="la-replay" type="button">${esc(o.replayLabel)}</button></div>
    </div></div>`;

  const q = <T extends Element>(s: string) => root.querySelector(s) as T;
  const stage = q<HTMLElement>(".la-stage");
  const fig = q<HTMLCanvasElement>(".la-fig"),
    ui = q<HTMLCanvasElement>(".la-ui");
  const grid = q<HTMLElement>(".la-grid");
  const chips = [...root.querySelectorAll<HTMLElement>(".la-t")];
  const skip = q<HTMLButtonElement>(".la-skip"),
    replayButton = q<HTMLButtonElement>(".la-replay");
  const figureContext = fig.getContext("2d"),
    revealContext = ui.getContext("2d");
  const cta = q<HTMLButtonElement>(".la-cta"),
    cue = q<HTMLElement>(".la-cue"),
    load = q<HTMLElement>(".la-load");
  const loadLabel = q<HTMLElement>(".la-load b"),
    barBlocks = [...root.querySelectorAll<HTMLElement>(".la-bar i")];

  /* decode the packed frames (1 bit per cell), and find the box the figure ever occupies */
  const packed = getFrames(opts.frames);
  const box = { x0: GW, y0: GH, x1: 0, y1: 0 };
  const frames: Uint8Array[] = packed.map((bin) => {
    const bits = new Uint8Array(GW * GH);
    for (let i = 0; i < bits.length; i++) {
      const on = (bin.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1;
      bits[i] = on;
      if (on) {
        const x = i % GW,
          y = (i / GW) | 0;
        if (x < box.x0) box.x0 = x;
        if (x > box.x1) box.x1 = x;
        if (y < box.y0) box.y0 = y;
        if (y > box.y1) box.y1 = y;
      }
    }
    return bits;
  });
  const n = frames.length;
  const colsC = box.x1 - box.x0 + 1,
    rowsC = box.y1 - box.y0 + 1;
  if (reduced) root.classList.add("la-reduced");

  const st = {
    phase: "scroll" as Phase,
    p: 0,
    target: 0,
    loadStart: 0,
    f0: 0,
    raf: 0,
    alive: true,
    d: 1,
    autoStart: 0,
    doneAt: 0,
  };
  const ptr = { mx: -999, my: -999, x: -999, y: -999, r: 0, tr: 0 };
  let uiCache: HTMLCanvasElement | null = null,
    uiScratch: HTMLCanvasElement | null = null;
  let lay = { W: 0, H: 0, cw: 0, ch: 0, ox: 0, oy: 0, fx0: 0, fx1: 0, fy0: 0, fy1: 0 };

  /* the figure sits at the centre of the stage; `size` is its height as a share of the stage */
  const geo = (W: number, H: number) => {
    let ch = (size * H) / rowsC,
      cw = ch / CELL_ASPECT;
    if (colsC * cw > W * 0.7) {
      cw = (W * 0.7) / colsC;
      ch = cw * CELL_ASPECT;
    }
    return {
      cw,
      ch,
      ox: W / 2 - ((box.x0 + box.x1 + 1) / 2) * cw,
      oy: H / 2 - ((box.y0 + box.y1 + 1) / 2) * ch,
    };
  };

  /* Figma-style rulers along the top and left edge */
  function rulers(x: CanvasRenderingContext2D, W: number, H: number) {
    const G = (a: number) => rgba(col.ink, a);
    const line = (x1: number, y1: number, x2: number, y2: number, stroke: string) => {
      x.strokeStyle = stroke;
      x.lineWidth = 1;
      x.beginPath();
      x.moveTo(x1 + 0.5, y1 + 0.5);
      x.lineTo(x2 + 0.5, y2 + 0.5);
      x.stroke();
    };
    const R = 18;
    x.fillStyle = "rgba(255,255,255,.82)";
    x.fillRect(0, 0, W, R);
    x.fillRect(0, 0, R, H);
    line(0, R, W, R, G(0.35));
    line(R, 0, R, H, G(0.35));
    x.fillStyle = G(0.7);
    x.font = '700 8px "Space Mono", monospace';
    x.textBaseline = "top";
    for (let t = 0; t <= W; t += 10) {
      const len = t % 100 === 0 ? 12 : t % 50 === 0 ? 8 : 4;
      line(t, R - len, t, R, G(0.5));
      if (t % 100 === 0 && t) x.fillText(String(t), t + 3, 2);
    }
    for (let t = 0; t <= H; t += 10) {
      const len = t % 100 === 0 ? 12 : t % 50 === 0 ? 8 : 4;
      line(R - len, t, R, t, G(0.5));
      if (t % 100 === 0 && t) {
        x.save();
        x.translate(2, t + 3);
        x.rotate(-Math.PI / 2);
        x.fillText(String(t), -x.measureText(String(t)).width, 0);
        x.restore();
      }
    }
  }

  function buildUiCache() {
    const W = stage.clientWidth,
      H = stage.clientHeight,
      d = st.d,
      c = document.createElement("canvas");
    c.width = Math.round(W * d);
    c.height = Math.round(H * d);
    const x = c.getContext("2d");
    if (!x) return;
    x.scale(d, d);
    x.lineWidth = 1;
    const O = (a: number) => rgba(col.accent, a),
      B = (a: number) => rgba(col.blue, a);
    const line = (x1: number, y1: number, x2: number, y2: number, stroke: string) => {
      x.strokeStyle = stroke;
      x.beginPath();
      x.moveTo(x1 + 0.5, y1 + 0.5);
      x.lineTo(x2 + 0.5, y2 + 0.5);
      x.stroke();
    };
    for (let gx = 0; gx <= W; gx += 24) line(gx, 0, gx, H, gx % 120 === 0 ? O(0.2) : O(0.09));
    for (let gy = 0; gy <= H; gy += 24) line(0, gy, W, gy, gy % 120 === 0 ? O(0.2) : O(0.09));
    rulers(x, W, H);
    const g = geo(W, H),
      pad = 10;
    const fx0 = g.ox + box.x0 * g.cw - pad,
      fx1 = g.ox + (box.x1 + 1) * g.cw + pad,
      fy0 = g.oy + box.y0 * g.ch - pad,
      fy1 = g.oy + (box.y1 + 1) * g.ch + pad;
    lay = { W, H, ...g, fx0, fx1, fy0, fy1 };
    line(fx0, 0, fx0, H, B(0.3));
    line(fx1, 0, fx1, H, B(0.3));
    line(0, fy0, W, fy0, B(0.3));
    line(0, fy1, W, fy1, B(0.3));
    line(W / 2, 0, W / 2, H, O(0.35));
    x.strokeStyle = B(0.9);
    x.strokeRect(fx0 + 0.5, fy0 + 0.5, fx1 - fx0, fy1 - fy0);
    const hs = 6;
    (
      [
        [fx0, fy0],
        [(fx0 + fx1) / 2, fy0],
        [fx1, fy0],
        [fx0, (fy0 + fy1) / 2],
        [fx1, (fy0 + fy1) / 2],
        [fx0, fy1],
        [(fx0 + fx1) / 2, fy1],
        [fx1, fy1],
      ] as Array<[number, number]>
    ).forEach(([hx, hy]) => {
      x.fillStyle = "#fff";
      x.strokeStyle = B(1);
      x.fillRect(hx - hs / 2 + 0.5, hy - hs / 2 + 0.5, hs, hs);
      x.strokeRect(hx - hs / 2 + 0.5, hy - hs / 2 + 0.5, hs, hs);
    });
    const pill = (txt: string, px: number, py: number, bg: string, fg: string) => {
      x.font = '700 9px "Space Mono", monospace';
      const w = x.measureText(txt).width + 12;
      x.fillStyle = bg;
      x.fillRect(px, py, w, 15);
      x.fillStyle = fg;
      x.textBaseline = "middle";
      x.fillText(txt, px + 6, py + 8);
      x.textBaseline = "top";
      return w;
    };
    pill(o.name, fx0, fy0 - 20, B(1), "#fff"); // the frame is named after the person
    pill(
      `${Math.round(fx1 - fx0)} × ${Math.round(fy1 - fy0)}`,
      (fx0 + fx1) / 2 - 30,
      fy1 + 7,
      B(1),
      "#fff",
    );
    uiCache = c;
    uiScratch = document.createElement("canvas");
    uiScratch.width = c.width;
    uiScratch.height = c.height;
  }

  function fit() {
    const d = o.session ? 1 : Math.min(window.devicePixelRatio || 1, 1.5);
    st.d = d;
    fig.width = Math.round(stage.clientWidth * d);
    fig.height = Math.round(stage.clientHeight * d);
    if (o.showReveal && !o.session) {
      ui.width = fig.width;
      ui.height = fig.height;
    }
    if (o.showReveal && pointerReveal && !reduced && !o.session) buildUiCache();
    lastFrame = -1;
    syncScroll();
    schedule();
  }

  function drawFigure(frame: number) {
    const ctx = figureContext,
      W = fig.width,
      H = fig.height;
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    const { cw, ch, ox, oy } = geo(W, H);
    const k = frame % n,
      a = frames[k],
      b = frames[(k + 1) % n],
      mix = n > 4 && k >= n - 4 ? (k - (n - 4) + 1) / 4 : 0; // dissolve the last frames into the first so the turn loops cleanly
    const p = st.p,
      mn = Math.min(W, H);
    ctx.fillStyle = col.accent;
    for (let y = 0; y < GH; y++)
      for (let x = 0; x < GW; x++) {
        const i = y * GW + x;
        if (!(mix && hsh(x, y) < mix ? b[i] : a[i])) continue;
        if (
          y > box.y1 - FADE_ROWS &&
          hsh(x * 7 + 3, y * 11 + 5) > (box.y1 - y + 1) / (FADE_ROWS + 1)
        )
          continue; // dithered fade at the cut-off edge
        let lp = 0;
        if (p > 0) {
          lp = clamp(p * 1.5 - hsh(x * 3 + 1, y * 5 + 2) * 0.5);
          lp = lp * lp * (3 - 2 * lp);
        }
        if (lp >= 0.995) continue;
        if (lp === 0) {
          const x0 = Math.round(ox + x * cw),
            y0 = Math.round(oy + y * ch);
          ctx.globalAlpha = 1;
          ctx.fillRect(
            x0,
            y0,
            Math.round(ox + (x + 1) * cw) - x0,
            Math.round(oy + (y + 1) * ch) - y0,
          );
          continue;
        }
        const ang = hsh(x, y) * 6.2832,
          dist = lp * (0.04 + hsh(y + 7, x + 3) * 0.46) * mn * spread,
          sz = 1 - lp * 0.6;
        ctx.globalAlpha = 1 - lp * 0.92;
        ctx.fillRect(
          ox + x * cw + Math.cos(ang) * dist + lp * W * 0.02,
          oy + y * ch + Math.sin(ang) * dist - lp * lp * H * 0.1,
          cw * sz,
          ch * sz,
        );
      }
    ctx.globalAlpha = 1;
  }

  /* everything below the cursor layer's base: panels and marks that fade in as you scroll further */
  function annotations(sx: CanvasRenderingContext2D, frame: number) {
    const { W, H, cw, ch, ox, oy, fx0, fx1, fy0, fy1 } = lay,
      R = 18;
    const O = (a: number) => rgba(col.accent, a),
      B = (a: number) => rgba(col.blue, a),
      G = (a: number) => rgba(col.ink, a);
    const at = (t: number) => (reduced ? 0 : smooth((st.p - t) / 0.12));
    const ln = (x1: number, y1: number, x2: number, y2: number, stroke: string) => {
      sx.strokeStyle = stroke;
      sx.lineWidth = 1;
      sx.beginPath();
      sx.moveTo(x1 + 0.5, y1 + 0.5);
      sx.lineTo(x2 + 0.5, y2 + 0.5);
      sx.stroke();
    };
    const pill = (txt: string, px: number, py: number, bg: string, fg: string) => {
      sx.font = '700 9px "Space Mono", monospace';
      const w = sx.measureText(txt).width + 12;
      sx.fillStyle = bg;
      sx.fillRect(px, py, w, 15);
      sx.fillStyle = fg;
      sx.textBaseline = "middle";
      sx.fillText(txt, px + 6, py + 8);
      return w;
    };
    const panel = (
      px: number,
      py: number,
      w: number,
      title: string,
      items: Array<[string, string]>,
    ) => {
      px = Math.max(R + 6, Math.min(W - w - 6, px));
      const h = 20 + items.length * 15 + 6;
      sx.fillStyle = "rgba(255,255,255,.93)";
      sx.fillRect(px, py, w, h);
      sx.strokeStyle = G(0.7);
      sx.lineWidth = 1;
      sx.strokeRect(px + 0.5, py + 0.5, w, h);
      sx.textBaseline = "middle";
      sx.fillStyle = G(1);
      sx.font = '700 8px "Space Mono", monospace';
      sx.fillText(title.toUpperCase(), px + 8, py + 10);
      ln(px, py + 19, px + w, py + 19, G(0.25));
      items.forEach(([k, v], i) => {
        const yy = py + 20 + i * 15 + 8;
        sx.font = '400 9px "Space Mono", monospace';
        sx.fillStyle = G(0.55);
        sx.fillText(k, px + 8, yy);
        sx.font = '700 9px "Space Mono", monospace';
        sx.fillStyle = G(1);
        sx.textAlign = "right";
        sx.fillText(v, px + w - 8, yy);
        sx.textAlign = "left";
      });
    };
    const when = (t: number, fn: () => void) => {
      const k = at(t);
      if (k <= 0.01) return;
      sx.save();
      sx.globalAlpha = k;
      fn();
      sx.restore();
    };
    const k = frame % n,
      rot = Math.round((k / n) * 360);
    /* 0.10  layers */
    when(0.1, () =>
      panel(fx1 + 14, fy0, 138, "Layers", [
        ["◉ Figure", ""],
        ["◉ Pixels", String(GW * GH)],
        ["◉ Background", ""],
      ]),
    );
    /* 0.25  properties, with a live rotation readout */
    when(0.25, () =>
      panel(fx0 - 14 - 142, fy0, 142, "Properties", [
        ["Role", o.role.length > 14 ? o.role.slice(0, 13) + "…" : o.role],
        ["X", `${Math.round(fx0)}`],
        ["Y", `${Math.round(fy0)}`],
        ["W × H", `${Math.round(fx1 - fx0)}×${Math.round(fy1 - fy0)}`],
        ["Rotate", `${rot}°`],
        ["Pixel", `${cw.toFixed(1)}×${ch.toFixed(1)}`],
        ["Frame", `${k + 1}/${n}`],
        ["Colour", "1-bit"],
      ]),
    );
    /* 0.40  measurements */
    when(0.4, () => {
      const my = (fy0 + fy1) / 2,
        mx = (fx0 + fx1) / 2;
      ln(R, my, fx0, my, O(0.9));
      ln(R, my - 4, R, my + 4, O(0.9));
      ln(fx0, my - 4, fx0, my + 4, O(0.9));
      pill(String(Math.round(fx0 - R)), (R + fx0) / 2 - 12, my - 20, O(1), col.ink);
      ln(mx, R, mx, fy0, O(0.9));
      ln(mx - 4, R, mx + 4, R, O(0.9));
      ln(mx - 4, fy0, mx + 4, fy0, O(0.9));
      pill(String(Math.round(fy0 - R)), mx + 8, (R + fy0) / 2 - 8, O(1), col.ink);
    });
    /* 0.55  pen path with anchors and handles, around the head */
    when(0.55, () => {
      const Wc = colsC * cw,
        Hc = rowsC * ch,
        hx = ox + ((box.x0 + box.x1 + 1) / 2) * cw,
        hy = oy + box.y0 * ch;
      const pts: Array<[number, number]> = [
        [hx - 0.22 * Wc, hy + 0.3 * Hc],
        [hx - 0.13 * Wc, hy + 0.04 * Hc],
        [hx + 0.13 * Wc, hy + 0.04 * Hc],
        [hx + 0.22 * Wc, hy + 0.3 * Hc],
      ];
      const hd = 0.07 * Wc,
        hv = 0.1 * Hc;
      sx.strokeStyle = B(0.9);
      sx.lineWidth = 1;
      sx.beginPath();
      sx.moveTo(pts[0][0] + 0.5, pts[0][1] + 0.5);
      sx.bezierCurveTo(
        pts[1][0] - hd,
        pts[1][1] - hv,
        pts[2][0] + hd,
        pts[2][1] - hv,
        pts[3][0] + 0.5,
        pts[3][1] + 0.5,
      );
      sx.stroke();
      pts.forEach(([px, py], i) => {
        const dx = i % 2 ? hd : -hd;
        ln(px, py, px + dx, py - hv, B(0.5));
        sx.fillStyle = "#fff";
        sx.strokeStyle = B(0.7);
        sx.beginPath();
        sx.arc(px + dx + 0.5, py - hv + 0.5, 2.5, 0, 6.283);
        sx.fill();
        sx.stroke();
        sx.strokeStyle = B(1);
        sx.fillRect(px - 2.5, py - 2.5, 6, 6);
        sx.strokeRect(px - 2.5, py - 2.5, 6, 6);
      });
    });
    /* 0.70  tags */
    when(0.7, () => {
      pill("Layer 1 · 66 × 53", fx1 + 14, fy1 - 80, "#fff", G(1));
      pill("Pixel mask", fx1 + 14, fy1 - 58, "#fff", G(1));
      pill("Opacity 100%", fx0 - 96, fy1 - 80, "#fff", G(1));
      pill(`Fill  ${col.accent.replace("#", "").toUpperCase()}`, fx0 - 108, fy1 - 58, "#fff", G(1));
      sx.fillStyle = col.accent;
      sx.fillRect(fx0 - 106, fy1 - 55, 9, 9);
    });
    /* 0.85  swatches + export */
    when(0.85, () => {
      const sy = fy1 + 28 < H - 24 ? fy1 + 28 : fy0 - 44;
      sx.fillStyle = col.accent;
      sx.fillRect(fx0, sy, 14, 14);
      sx.strokeStyle = G(0.8);
      sx.strokeRect(fx0 + 0.5, sy + 0.5, 14, 14);
      sx.fillStyle = "#fff";
      sx.fillRect(fx0 + 20, sy, 14, 14);
      sx.strokeRect(fx0 + 20.5, sy + 0.5, 14, 14);
      ln(fx0 + 20, sy + 14, fx0 + 34, sy, G(0.8));
      pill(
        "on #" + col.accent.replace("#", "").toUpperCase() + "  off none",
        fx0 + 42,
        sy - 1,
        "#fff",
        G(1),
      );
      pill("Export 1x", fx1 - 56, sy - 1, B(1), "#fff");
    });
  }

  /* the headline page: rulers, guides, name / size / position tags and spacing marks around the framed words */
  function drawHeadlineGuides(ctx: CanvasRenderingContext2D, hv: number) {
    const d = st.d,
      W = stage.clientWidth,
      H = stage.clientHeight,
      R = 18;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.globalAlpha = hv;
    ctx.lineWidth = 1;
    const O = (a: number) => rgba(col.accent, a),
      B = (a: number) => rgba(col.blue, a);
    const ln = (x1: number, y1: number, x2: number, y2: number, stroke: string) => {
      ctx.strokeStyle = stroke;
      ctx.beginPath();
      ctx.moveTo(x1 + 0.5, y1 + 0.5);
      ctx.lineTo(x2 + 0.5, y2 + 0.5);
      ctx.stroke();
    };
    const pill = (txt: string, px: number, py: number, bg: string, fg: string) => {
      ctx.font = '700 9px "Space Mono", monospace';
      const w = ctx.measureText(txt).width + 12;
      ctx.fillStyle = bg;
      ctx.fillRect(px, py, w, 15);
      ctx.fillStyle = fg;
      ctx.textBaseline = "middle";
      ctx.fillText(txt, px + 6, py + 8);
      return w;
    };
    const small = W < 640;
    const fr = [...root.querySelectorAll<HTMLElement>(".la-fr")].map((e) => ({
      x: e.offsetLeft,
      y: e.offsetTop,
      w: e.offsetWidth,
      h: e.offsetHeight,
    }));
    rulers(ctx, W, H); // the same ruler bars as the cursor layer
    ctx.textBaseline = "top";
    fr.forEach((f, i) => {
      const x0 = f.x,
        x1 = f.x + f.w,
        y0 = f.y,
        y1 = f.y + f.h;
      ln(x0, R, x0, H, B(0.28));
      ln(x1, R, x1, H, B(0.28));
      ln(R, y0, W, y0, B(0.28));
      ln(R, y1, W, y1, B(0.28));
      ctx.fillStyle = B(0.3);
      ctx.fillRect(x0 + 1, 0, f.w, R - 1);
      ctx.fillRect(0, y0 + 1, R - 1, f.h); // selection range lit up on both rulers
      ctx.fillStyle = B(1);
      ctx.font = '700 8px "Space Mono", monospace';
      ctx.textBaseline = "top";
      ctx.fillText(String(Math.round(x0)), x0 + 3, 2);
      if (small) return;
      pill(`Text ${i + 1}`, x0, y0 - 21, B(1), "#fff");
      const pos = `x ${Math.round(x0)}  y ${Math.round(y0)}`;
      ctx.font = '700 9px "Space Mono", monospace';
      pill(pos, x1 - ctx.measureText(pos).width - 12, y0 - 21, col.ink, "#fff");
      pill(`${Math.round(f.w)} × ${Math.round(f.h)}`, (x0 + x1) / 2 - 30, y1 + 7, B(1), "#fff");
    });
    /* spacing marks in the accent colour, like measurements in a design tool */
    const h1 = q<HTMLElement>(".la-h");
    const gap = Math.round(cta.offsetTop - (h1.offsetTop + h1.offsetHeight)),
      cx = cta.offsetLeft + 16;
    if (gap > 6) {
      const ya = h1.offsetTop + h1.offsetHeight,
        yb = cta.offsetTop;
      ln(cx, ya, cx, yb, O(0.95));
      ln(cx - 4, ya, cx + 4, ya, O(0.95));
      ln(cx - 4, yb, cx + 4, yb, O(0.95));
      if (!small) pill(String(gap), cx + 8, (ya + yb) / 2 - 8, O(1), col.ink);
    }
    const lx = h1.offsetLeft,
      ym = h1.offsetTop - 18;
    if (!small && lx - R > 26) {
      ln(R, ym, lx, ym, O(0.95));
      ln(R, ym - 4, R, ym + 4, O(0.95));
      ln(lx, ym - 4, lx, ym + 4, O(0.95));
      pill(String(Math.round(lx - R)), (R + lx) / 2 - 10, ym - 20, O(1), col.ink);
    }
    if (!small) {
      ctx.fillStyle = rgba(col.ink, 0.55);
      ctx.font = '700 9px "Space Mono", monospace';
      ctx.textBaseline = "top";
      ctx.fillText(`Landing  ${Math.round(W)} × ${Math.round(H)}`, R + 8, R + 8);
    }
    ctx.globalAlpha = 1;
  }

  function drawReveal(frame: number) {
    const ctx = revealContext,
      d = st.d;
    if (!ctx) return;
    ptr.x += (ptr.mx - ptr.x) * 0.35;
    ptr.y += (ptr.my - ptr.y) * 0.35;
    ptr.r += (ptr.tr - ptr.r) * 0.16;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ui.width, ui.height);
    const hv = reduced ? 1 : smooth((st.p - 0.4) / 0.15),
      vis = 1 - hv; // the cursor layer steps aside while the headline is up, and returns with the pixels
    if (o.showReveal && hv > 0.01 && st.phase === "scroll") drawHeadlineGuides(ctx, hv);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!o.showReveal || !uiCache || !uiScratch || ptr.r < 2 || vis < 0.01) return;
    const sx = uiScratch.getContext("2d"),
      W = ui.width,
      H = ui.height;
    if (!sx) return;
    sx.setTransform(1, 0, 0, 1, 0, 0);
    sx.globalCompositeOperation = "source-over";
    sx.clearRect(0, 0, W, H);
    sx.drawImage(uiCache, 0, 0);
    sx.setTransform(d, 0, 0, d, 0, 0); // from here on, CSS pixels
    annotations(sx, frame);
    const rect = stage.getBoundingClientRect();
    const x = ptr.x - rect.left,
      y = ptr.y - rect.top,
      r = ptr.r * (1 + st.p * 0.9); // the circle widens as you scroll, so more of the layer shows
    sx.strokeStyle = rgba(col.blue, 0.7);
    sx.lineWidth = 1;
    sx.beginPath();
    sx.moveTo(x, 0);
    sx.lineTo(x, H / d);
    sx.moveTo(0, y);
    sx.lineTo(W / d, y);
    sx.stroke();
    const label = `x ${Math.round(ptr.x)}   y ${Math.round(ptr.y)}`;
    sx.font = '700 9px "Space Mono", monospace';
    sx.textBaseline = "middle";
    const lw = sx.measureText(label).width + 12;
    sx.fillStyle = col.ink;
    sx.fillRect(x + 12, y + 12, lw, 15);
    sx.fillStyle = "#fff";
    sx.fillText(label, x + 18, y + 20);
    sx.fillStyle = col.blue;
    sx.fillRect(x - 3, 0, 6, 18);
    sx.fillRect(0, y - 3, 18, 6);
    sx.globalCompositeOperation = "destination-in"; // reveal only under the cursor
    const gr = sx.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, "rgba(0,0,0,1)");
    gr.addColorStop(0.7, "rgba(0,0,0,.85)");
    gr.addColorStop(1, "rgba(0,0,0,0)");
    sx.fillStyle = gr;
    sx.fillRect(0, 0, W / d, H / d);
    ctx.globalAlpha = vis;
    ctx.drawImage(uiScratch, 0, 0);
    ctx.globalAlpha = 1;
  }

  function updateDom() {
    if (o.session) return;
    const p = st.p,
      b = reduced ? 1 : smooth((p - 0.9) / 0.08);
    root.dataset.phase = st.phase;
    chips.forEach((el, i) => {
      const t = reduced ? 1 : smooth((p - 0.4 - i * 0.022) / 0.2);
      el.style.opacity = String(t);
      el.style.transform = `translateY(${(1 - t) * 22}px) scale(${0.82 + 0.18 * t})`;
    });
    grid.style.opacity = o.showReveal ? String(reduced ? 1 : smooth((p - 0.4) / 0.15)) : "0"; // the grid lives on the headline page; on the figure it only shows under the cursor
    const live = st.phase === "scroll" && b > 0.5;
    skip.hidden = st.phase !== "scroll";
    cta.style.opacity = String(st.phase === "scroll" ? b : 0);
    cta.style.pointerEvents = live ? "auto" : "none";
    cta.tabIndex = live ? 0 : -1;
    cta.disabled = !live;
    if (live && focusCta) {
      focusCta = false;
      cta.focus({ preventScroll: true });
    }
    cue.style.opacity = st.phase === "scroll" ? String(1 - smooth(p / 0.12)) : "0";
  }

  function complete() {
    st.phase = "done";
    st.p = 0;
    st.target = 0;
    loadLabel.textContent = o.readyLabel;
    for (const block of barBlocks) block.classList.add("on");
    load.classList.add("on", "done");
    updateDom();
    if (!o.autoplay) replayButton.focus({ preventScroll: true });
    opts.onComplete?.();
    root.dispatchEvent(new CustomEvent("loadinganimation:complete", { bubbles: true }));
  }
  function begin() {
    if (st.phase !== "scroll") return;
    opts.onGetStarted?.();
    if (reduced) {
      complete();
      return;
    }
    st.phase = "assemble";
    st.target = 0;
    schedule();
  }
  function resetUi() {
    load.classList.remove("on", "done");
    loadLabel.textContent = o.loadingLabel;
    for (const block of barBlocks) block.classList.remove("on");
  }
  function replay() {
    st.phase = "scroll";
    st.p = 0;
    st.target = 0;
    st.autoStart = 0;
    st.doneAt = 0;
    resetUi();
    updateDom();
    if (reduced && !o.autoplay) cta.focus({ preventScroll: true });
    if (!o.autoplay) root.scrollTo({ top: 0, behavior: "instant" });
    if (!o.autoplay && !reduced) skip.focus({ preventScroll: true });
    schedule();
  }

  let focusCta = false;
  let visible = true,
    lastFrame = -1,
    lastFigureProgress = -1,
    lastDomProgress = -1,
    lastPhase: Phase | undefined;
  let lastTick = 0,
    elapsed = 0;
  function syncScroll() {
    if (!o.session && !o.autoplay && !reduced && st.phase === "scroll") {
      st.target = clamp(root.scrollTop / Math.max(1, root.scrollHeight - root.clientHeight));
    }
  }
  if (!o.session && !o.autoplay && !reduced)
    root.addEventListener("scroll", syncScroll, { passive: true });
  function schedule() {
    if (st.alive && !st.raf && !document.hidden && visible) st.raf = requestAnimationFrame(loop);
  }

  function loop(now: number) {
    elapsed += lastTick ? Math.min(50, now - lastTick) : 16;
    lastTick = now;
    const ts = elapsed;
    st.raf = 0;
    if (!st.alive) return;
    const onScreen = visible && !document.hidden;
    if (onScreen) {
      if (!o.session && o.autoplay && !reduced && st.phase === "scroll") {
        // a timeline stands in for the scroll: hold, disperse, show the headline, press the button
        if (!st.autoStart) st.autoStart = ts;
        const e = (ts - st.autoStart) / 1000;
        st.target = reduced ? 0 : e < 1.2 ? 0 : e < 4.4 ? smooth((e - 1.2) / 3.2) : 1;
        if (e > 6.6) begin();
      }
      if (o.autoplay && st.phase === "done") {
        // hold on "ready" for a moment, then go round again
        if (!st.doneAt) st.doneAt = ts;
        if (ts - st.doneAt > 1600) {
          st.phase = "scroll";
          st.p = 0;
          st.target = 0;
          st.autoStart = ts;
          st.doneAt = 0;
          resetUi();
        }
      }
      st.p += (st.target - st.p) * (st.phase === "assemble" ? 0.085 : 0.16);
      if (Math.abs(st.target - st.p) < 0.002) st.p = st.target;
      let frame = reduced ? Math.floor(n * 0.38) : Math.floor((ts / 1000) * 12) % n;
      if (st.phase === "assemble" && st.p < 0.02) {
        // reassembled: now turn once, as the loading animation
        st.phase = "load";
        st.loadStart = ts;
        st.f0 = frame;
        st.p = 0;
        load.classList.add("on");
      }
      if (st.phase === "load") {
        const f = Math.floor(((ts - st.loadStart) / 1000) * 24);
        if (f >= n) complete();
        else {
          frame = (st.f0 + f) % n;
          const lit = Math.round((f / n) * barBlocks.length);
          for (let i = 0; i < barBlocks.length; i++) barBlocks[i].classList.toggle("on", i < lit);
        }
      }
      if (lastFrame !== frame || lastFigureProgress !== st.p) {
        drawFigure(frame);
        lastFrame = frame;
        lastFigureProgress = st.p;
      }
      if (!o.session && !reduced && o.showReveal) drawReveal(frame);
      if (lastDomProgress !== st.p || lastPhase !== st.phase) {
        updateDom();
        lastDomProgress = st.p;
        lastPhase = st.phase;
      }
    }
    if (!reduced && (st.phase !== "done" || o.autoplay)) schedule();
  }

  const onMove = (e: PointerEvent) => {
    ptr.mx = e.clientX;
    ptr.my = e.clientY;
    if (ptr.r < 2) {
      ptr.x = ptr.mx;
      ptr.y = ptr.my;
    }
    ptr.tr = 240;
  };
  const onLeave = () => {
    ptr.tr = 0;
  };
  if (!o.session && o.showReveal && pointerReveal && !reduced) {
    stage.addEventListener("pointermove", onMove);
    stage.addEventListener("pointerleave", onLeave);
  }
  cta.addEventListener("click", begin);
  skip.addEventListener("click", () => {
    focusCta = true;
    root.scrollTo({ top: root.scrollHeight, behavior: "smooth" });
  });
  const onVisibility = () => {
    if (document.hidden || !visible) {
      cancelAnimationFrame(st.raf);
      st.raf = 0;
      lastTick = 0;
    } else schedule();
  };
  const io = new IntersectionObserver(([entry]) => {
    if (entry) {
      visible = entry.isIntersecting;
      onVisibility();
    }
  });
  io.observe(root);
  document.addEventListener("visibilitychange", onVisibility);
  q<HTMLElement>(".la-replay").addEventListener("click", replay);
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => fit()) : null;
  ro?.observe(stage);
  fit();
  drawFigure(reduced ? Math.floor(n * 0.38) : 0);
  updateDom();

  return {
    replay,
    destroy() {
      st.alive = false;
      cancelAnimationFrame(st.raf);
      ro?.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      root.removeEventListener("scroll", syncScroll);
      stage.removeEventListener("pointermove", onMove);
      stage.removeEventListener("pointerleave", onLeave);
      root.replaceChildren();
      delete root.dataset.phase;
      root.classList.remove("la", "la-auto", "la-reduced", "la-session");
    },
  };
}
// </engine>

export interface LoadingAnimationProps extends LoadingAnimationOptions {
  className?: string;
  style?: React.CSSProperties;
}

/** React wrapper. Renders a full-width block; give it a scrolling page to live in. */
export function LoadingAnimation({
  className,
  style,
  onComplete,
  onGetStarted,
  ...rest
}: LoadingAnimationProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const cb = React.useRef({ onComplete, onGetStarted });
  React.useEffect(() => {
    cb.current = { onComplete, onGetStarted };
  }, [onComplete, onGetStarted]);
  const {
    name,
    role,
    cta,
    loadingLabel,
    readyLabel,
    replayLabel,
    scrollHeight,
    size,
    spread,
    showReveal,
    autoplay,
    session,
    frames,
    rows,
    colors,
  } = rest;
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const options: LoadingAnimationOptions = {
      name,
      role,
      cta,
      loadingLabel,
      readyLabel,
      replayLabel,
      scrollHeight,
      size,
      spread,
      showReveal,
      autoplay,
      session,
      frames,
      rows,
      colors,
      onComplete: () => cb.current.onComplete?.(),
      onGetStarted: () => cb.current.onGetStarted?.(),
    };
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let animation = mountLoadingAnimation(el, options);
    const restart = () => {
      animation.destroy();
      animation = mountLoadingAnimation(el, options);
    };
    motion.addEventListener("change", restart);
    return () => {
      motion.removeEventListener("change", restart);
      animation.destroy();
    };
  }, [
    name,
    role,
    cta,
    loadingLabel,
    readyLabel,
    replayLabel,
    scrollHeight,
    size,
    spread,
    showReveal,
    autoplay,
    session,
    frames,
    rows,
    colors,
  ]);
  if (!session) return <div ref={ref} className={cn("la", className)} style={style} />;
  return (
    <div className={cn("la la-session-shell", className)} style={style}>
      <div ref={ref} className="la la-session" aria-hidden="true" />
      <div className="la-session-status" role="status">
        <b>{loadingLabel ?? "Checking session"}</b>
        <div aria-hidden="true" className="la-session-bar" />
      </div>
      <p className="la-session-slow" role="status">
        Taking longer than usual. Still waiting for the control plane.
      </p>
    </div>
  );
}

export default LoadingAnimation;

function getFrames(frames?: string[]) {
  if (frames?.length) {
    const decoded: string[] = [];
    for (const frame of frames) {
      try {
        const bytes = atob(frame);
        if (
          bytes.length === Math.ceil((GW * GH) / 8) &&
          [...bytes].some((byte) => byte.charCodeAt(0) !== 0)
        )
          decoded.push(bytes);
      } catch {
        // Skip malformed input so a bad frame cannot break the loading surface.
      }
    }
    if (decoded.length) return decoded;
  }
  return BUILTIN_FRAMES.map((frame) => atob(frame));
}

// <data>
/** One full turn of the figure: 66x53, 1 bit per cell, row-major, packed MSB first, base64. */
const BUILTIN_FRAMES: string[] = [
  "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",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH8AAAAAAAAAH8AAAAAAAAAf/gAAAAAAAA//wAAAAAAAB//4AAAAAAAB//8AAAAAAAD//8AAAAAAAH//8AAAAAAAD//8AAAAAAAD//8AAAAAAAD//8AAAAAAADf/8AAAAAAADf/4AAAAAAADf/4AAAAAAAAP/gAAAAAAACB/gAAAAAAABB/gAAAAAAAAA/gAAAAAAAAH/+AAAAAAAAP/+AAAAAAAA+L/AAAAAAABv/fYAAAAAAB+///gAAAAAD//8IIAAAAAb/H//2AAAAB/v///mAAAAHz//7//AAAAc/9////gAADv9///j/wAAN/f/9D//4AADP/x//f/4AAW/7/ff/v8AAd4//ff//8AAb/u/f/v/8AAXb+/f/v/4AA+z//f///4AAt793f///4AB7v93f///4ADfr93f/3/wAD3f93f/33wAC/f9//f/3wAC+/9//3/3gA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf/gAAAAAAAAf/gAAAAAAAA//wAAAAAAAB//4AAAAAAAB//8AAAAAAAD//8AAAAAAAD//8AAAAAAAD//8AAAAAAAD//8AAAAAAAH//8AAAAAAAD//8AAAAAAADf/8AAAAAAADf/4AAAAAAAAP/gAAAAAAACH/gAAAAAAABD/gAAAAAAAAA/gAAAAAAAAF/8AAAAAAAAP/+AAAAAAAAfDOAAAAAAAAv//wAAAAAAB+//+AAAAAADf///IAAAAAf/hf/8AAAAD/H////AAAAPn//+f/gAAA5/9////gAAHf9///9DgAAL+///g//4AAW//i///f4AAd/h/////8AA7z///7//8AA3f/+//f98ABv37v///v8AB//7u////8ABff7+////4AD3///////4AC+/7/+/t/4ADv///3/t/4AH////2/9/wAF9//93v9/wA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAAAAAAf/AAAAAAAAA//wAAAAAAAB//4AAAAAAAB//4AAAAAAAB//4AAAAAAAD//8AAAAAAAD//8AAAAAAAD//4AAAAAAAH//4AAAAAAAH//8AAAAAAAH//8AAAAAAAGf/4AAAAAAAG//4AAAAAAAAf/wAAAAAAAAP/gAAAAAAAAH/gAAAAAAAAB/gAAAAAAAADfwAAAAAAAAf/8AAAAAAAA//+AAAAAAABr//AAAAAAAB/3/YAAAAAAHv///gAAAAAX//gYcAAAAF/h///+AAAAPn/////gAABz///P//gAAK/+/////wAAf/////pfIAA///8Av//4AA//x//9+/4AA9n+//t/+8AB9/v//v/+8AB6/v//v//8AD87v//+/f8AD+////+/f8AHf//3///+8AD7/f3f///8AC//f3f///8AP//d3//f/8AP33d37/f/4A",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABwAAAAAAAAAR/AAAAAAAAA//gAAAAAAAB//wAAAAAAAB//wAAAAAAAD//4AAAAAAAD//4AAAAAAAD//8AAAAAAAH//4AAAAAAAH//4AAAAAAAH//8AAAAAAAG//8AAAAAAAG/78AAAAAAAG//4AAAAAAAA//wAAAAAAAAP/gAAAAAAAAH/gAAAAAAAAB/gAAAAAAAAHfAAAAAAAAA//8AAAAAAAA//8AAAAAAABD/+AAAAAAAB/3+wAAAAAAPf///AAAAAAf//2B8AAAAP/l///8AAAAfn/////AAADz///v//gAAd///////wAAv7////6AQAAd//8wP//4AA//p//7//4AD/H/v/bv/8AD//vv/f//8AH1//u/f+/8AB7//u/9+/8AH//7u39/+8AK/+7u39//8AH3+7v3///8AN/+/v3//78AH/+/v3+/78AHv////+/78A",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/8AAAAAAAAB//AAAAAAAAD//gAAAAAAAH//gAAAAAAAH//wAAAAAAAH//wAAAAAAAH//wAAAAAAAP//wAAAAAAAP//wAAAAAAAP//4AAAAAAAP//4AAAAAAAP//wAAAAAAAN//wAAAAAAAAf/gAAAAAAAAf/AAAAAAAAAf/AAAAAAAAAH/AAAAAAAAAN/AAAAAAAAA//4AAAAAAAB//4AAAAAAACP/8AAAAAAAH/PHgAAAAAA9////AAAAAA/////4AAAAP+P///6AAAB+//////AAAOf///P/9gAA3/v/////gAA/f////+/wADv//x4v//4AC/0f////b4AF3///fu//YAH/7//d/7/cAGu///d/7/cAF//9/f37/8APv/9/f3/v+AP//d3/3//+AO/3d37///+AH/3d37/9/+Ae/39///f/+Af/39//7d/8A",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAA/8AAAAAAAAD//AAAAAAAAD//gAAAAAAAH//gAAAAAAAH//wAAAAAAAH//wAAAAAAAP//wAAAAAAAf//wAAAAAAAf//wAAAAAAAX//4AAAAAAAT//wAAAAAAAL//wAAAAAAAA//wAAAAAAAB//gAAAAAAAA//AAAAAAAAAf/AAAAAAAAAH/AAAAAAAAAP/AAAAAAAAB//wAAAAAAAD//4AAAAAAAEb/gAAAAAAAP///AAAAAAB////4AAAAAB/////gAAAAf8UP/88AAAD5//////AAAZ///////gABf/v/////gAB////////wAC////+APh4AF/o//////4ADf///3/v38AH/v7/3///wAO/v/93f//8AM7/393f//+Af//39/d3/+AP/939/937+AL/d3d//3/+Af/f3f//3f8Af/f3//v3f+A//f3/vv3/+A",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/8AAAAAAAAD//AAAAAAAAH//gAAAAAAAH//gAAAAAAAP//gAAAAAAAP//wAAAAAAAP//wAAAAAAAP//wAAAAAAAf//4AAAAAAAf//4AAAAAAAf//wAAAAAAAL//wAAAAAAAD//gAAAAAAAB//gAAAAAAAA//gAAAAAAAAf+AAAAAAAAAf+AAAAAAAAAf+AAAAAAAAB//gAAAAAAAH//wAAAAAAAIPA4AAAAAAAf//8AAAAAAB////gAAAAAL/////AAAAD/4AAA/4AAAfn/////mAAAn//////+AAB/+/////fgAH3///////gAH////////wAP6H/////+4AP//v/f///4AJ+///f//9sAb///3d/fv8Avv/f3d//v8Af/3d393fv2AX/3d/93d/+A/9/f///d/+A39/f///fv6A/9///+/f/+Avt//++///+A",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB/4AAAAAAAAD/+AAAAAAAAH//AAAAAAAAP//gAAAAAAAP//gAAAAAAAf//gAAAAAAAf//wAAAAAAAf//wAAAAAAA///gAAAAAAA///wAAAAAAA///gAAAAAAAX//gAAAAAAAD7/gAAAAAAAD7/gAAAAAAAB/+AAAAAAAAB//AAAAAAAAA/+AAAAAAAAA/+AAAAAAAAD//AAAAAAAAP//gAAAAAAAUA7gAAAAAAA///wAAAAAAHv//+AAAAAAf////wAAAAH/zvH//gAAA+f////84AABf//////+AAD/7////n/AAGf///////AAH////////gAPgf/w//5PwAf/////7//wA/7//9/7+/4Av/9/d//+/4A//93f3/+/UA//d3f39+/8B//d//39//sB/3///3d3/8Bv3//7/d3/2Bf37+7/92/+B/37+7/9//+A",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH/AAAAAAAAAP/4AAAAAAAAf/8AAAAAAAA//+AAAAAAAB//+AAAAAAAB///AAAAAAAB///AAAAAAAB///AAAAAAAB//+AAAAAAAB//+AAAAAAAB//+AAAAAAAAf/+AAAAAAAAf/+AAAAAAAAD/+AAAAAAAAH/8AAAAAAAAH/8AAAAAAAAD/4AAAAAAAAD/4AAAAAAAAP/8AAAAAAAAv/+AAAAAAAAAA/AAAAAAAD///AAAAAAAN//+4AAAAAA/////AAAAAP4AABf+AAAAT/////nwAAB///////oAAHz////8/8AAH///////+AAf////////AAi/////+w/AA/t//t3f/7gAb///v3d3/wB7fv7v3f37wB/fu7//f3/4D/fv/+//3/4D/fv/+//3/4D/7//+////8B77//f//3/8B///3f7u3/cB/f93f7u//8A",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH+AAAAAAAAAf/gAAAAAAAA//4AAAAAAAB//8AAAAAAAD//8AAAAAAAD//+AAAAAAAD//+AAAAAAAD//+AAAAAAAD//8AAAAAAAD//8AAAAAAAD//8AAAAAAAB//8AAAAAAAB//8AAAAAAAAP/8AAAAAAAAP/8AAAAAAAAP/8AAAAAAAAH/4AAAAAAAAH/wAAAAAAAAf/wAAAAAAAA//8AAAAAAAAAHeAAAAAAAH//+AAAAAAAb///wAAAAAB////9gAAAAL4AA3/4AAAAH////+fgAAC//////+wAAHP////P/0AAf///////8AAX///////+AAP/////sH+AB//d2/f//PAB2/f+/d/f/gD//f+/9/d/gD/3/u///d/wD//7v7//d/wD/+7v7//974D/+//7+/994D/+///u/9/4D/+///u7//4B7+///+7d/4A",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf4AAAAAAAAB//AAAAAAAAD//gAAAAAAAH//wAAAAAAAP//8AAAAAAAP//+AAAAAAAP///AAAAAAAP//4AAAAAAAP//4AAAAAAAP//4AAAAAAAH//4AAAAAAAD//4AAAAAAAB//4AAAAAAAA//4AAAAAAAAf/wAAAAAAAAf/wAAAAAAAAf/gAAAAAAAAf/gAAAAAAAB/9AAAAAAAAD//gAAAAAAAADf4AAAAAAAX//oAAAAAAAf/7+AAAAAAF////gAAAAAAAAv/9AAAAB////4/wAAAD/////+eAAAH3//x///gABf/////7/wABCQv////3wAD////kF//wAD//dt//6/4AH3//t///78AH23/9+7v/8AG/379//v76AH3+7///v7vAH3+////v7/ADX//+3//++gD3//+3///fgD///+/f///gBf//e/fv/vgA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/4AAAAAAAAD/+AAAAAAAAH//AAAAAAAAP//wAAAAAAAf//+AAAAAAAf//+AAAAAAAf///AAAAAAAf//6AAAAAAAf//wAAAAAAAf//wAAAAAAAP//wAAAAAAAH//wAAAAAAAD//wAAAAAAAB//wAAAAAAAA//wAAAAAAAA//wAAAAAAAA//AAAAAAAAA//AAAAAAAAD/+AAAAAAAAH//gAAAAAAAAi/wAAAAAAAH//QAAAAAAAf/34AAAAAAD////AAAAAAD5Bf/0AAAAA////n/gAAAHz////zwAAAPf//n//uAAAe/////f/AAA/6X/////gAD9///QP//gAHvv22//H/gAP/9227//PwAHv//27///QAFvf/27///oAH/fv27///8AG7bv/7///8ADrb//7//f6ADrb//7+/7vAB/f//bv/9/AB3f9/bv//+AA",
  "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",
];
// </data>
