// Procedural pixel art for the four café atmospheres. Everything is generated from code (no third-party assets):
// outdoor scenery for each window, a shade overlay (interior darkness / colour wash), a light layer (sun or moon beams
// on the floor) and a soft lamp glow. Sky frames come in 4 phases so clouds drift and stars twinkle without any
// continuous animation: the scene only swaps a texture every few timer ticks.
import type { Daypart } from "../domain/atmosphere.ts";
import { mixColor } from "../domain/atmosphere.ts";
import { newPen, rng, type Pen } from "./pixel.ts";
import { FLOOR_Y, H, W, WINDOWS } from "./world.ts";

export const GW = 32; // window glass size
export const GH = 26;
export const PHASES = 4;

const css = (n: number): string => `#${n.toString(16).padStart(6, "0")}`;

/** Vertical gradient through colour stops [row 0..1, colour]. */
function gradient(p: Pen, h: number, stops: Array<[number, number]>): void {
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1);
    let i = 0;
    while (i < stops.length - 2 && t > (stops[i + 1] as [number, number])[0]) i++;
    const [t0, c0] = stops[i] as [number, number];
    const [t1, c1] = stops[i + 1] as [number, number];
    p.r(0, y, GW, 1, css(mixColor(c0, c1, t1 === t0 ? 0 : (t - t0) / (t1 - t0))));
  }
}

function disc(p: Pen, cx: number, cy: number, r: number, c: string): void {
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r + r * 0.6) p.p(cx + x, cy + y, c);
}

function cloud(p: Pen, x: number, y: number, c: string, shade: string): void {
  p.r(x + 2, y, 7, 2, c);
  p.r(x, y + 1, 12, 2, c);
  p.r(x + 1, y + 3, 10, 1, shade);
}

function hills(p: Pen, win: number, far: string, near: string, tree: string): void {
  const flip = win === 1;
  p.r(0, 18, GW, 8, far);
  p.r(flip ? 14 : 3, 15, 13, 4, far);
  p.r(flip ? 2 : 18, 14, 14, 5, near);
  p.r(0, 20, GW, 6, near);
  const trees: Array<[number, number]> = flip ? [[5, 17], [24, 18], [28, 16]] : [[8, 18], [14, 17], [27, 17]];
  for (const [tx, ty] of trees) {
    p.r(tx, ty, 3, 3, tree);
    p.r(tx + 1, ty - 1, 1, 1, tree);
  }
}

function bird(p: Pen, x: number, y: number, c: string, flap: boolean): void {
  p.p(x, y + (flap ? 0 : 1), c);
  p.p(x + 1, y + 1, c);
  p.p(x + 2, y + (flap ? 0 : 1), c);
}

/** Wraps a drifting x position into the glass plus a margin so clouds re-enter smoothly. */
const wrap = (v: number, span: number, margin: number): number => (((v % span) + span) % span) - margin;

export function buildSky(daypart: Daypart, win: 0 | 1, phase: number): Pen {
  const p = newPen(GW, GH);
  const drift = phase;
  const flap = phase % 2 === 0;
  const r = rng(101 + win * 7);
  if (daypart === "morning") {
    gradient(p, 19, [[0, 0x9ad0ec], [0.45, 0xf6d9b0], [0.8, 0xffb878], [1, 0xffd890]]);
    const sx = win === 0 ? 22 : 9;
    disc(p, sx, 17, 7, "#ffe9a8");
    p.a(sx - 8, 9, 17, 10, "#fff2b8", 0.22);
    disc(p, sx, 17, 4, "#fff6cc");
    p.a(sx - 6, 17, 13, 1, "#fff6cc", phase % 2 ? 0.5 : 0.3);
    cloud(p, wrap(4 + drift + win * 9, 40, 8), 5, "#ffe3c8", "#f0b898");
    cloud(p, wrap(20 + drift + win * 5, 40, 8), 10, "#ffd4b0", "#e8a888");
    hills(p, win, "#7fb85a", "#5fa04a", "#3d8040");
    p.a(0, 14, GW, 12, "#ffc070", 0.16);
    bird(p, 6 + win * 15, 3 + (phase >> 1), "#5c4030", flap);
  } else if (daypart === "noon") {
    gradient(p, 19, [[0, 0x3c9ae6], [0.6, 0x7fcaf2], [1, 0xbfe8fa]]);
    disc(p, win === 0 ? 6 : 26, 4, 3, "#fffbd8");
    p.a(win === 0 ? 1 : 21, 0, 11, 9, "#ffffff", 0.2);
    cloud(p, wrap(2 + drift * 2 + win * 11, 44, 10), 6, "#ffffff", "#d4ecfb");
    cloud(p, wrap(22 + drift * 2 + win * 3, 44, 10), 11, "#ffffff", "#cfe8f8");
    hills(p, win, "#5cc060", "#3fa84a", "#2c7e3a");
    bird(p, 14 + win * 4, 8 + (phase >> 1), "#2a3a50", flap);
  } else if (daypart === "evening") {
    gradient(p, 19, [[0, 0x4a3478], [0.28, 0xb0507e], [0.55, 0xf08a52], [0.85, 0xffbe5c], [1, 0xffd988]]);
    const sx = win === 0 ? 11 : 21;
    p.a(sx - 11, 8, 23, 12, "#ffd070", 0.2);
    p.a(sx - 8, 10, 17, 9, "#ffb04c", 0.25);
    disc(p, sx, 18, 6, "#ffd04c");
    disc(p, sx, 18, 4, "#fff0a0");
    const streaks: Array<[number, number, number]> = [[wrap(2 + drift + win * 6, 36, 6), 4, 14], [wrap(18 + drift + win * 3, 36, 6), 8, 12], [wrap(9 + drift, 36, 6), 12, 10]];
    for (const [cx, cy, len] of streaks) {
      p.r(cx, cy, len, 1, "#e06a8a");
      p.r(cx + 2, cy + 1, len - 3, 1, "#ff9a70");
    }
    hills(p, win, "#6a4a5e", "#4a3248", "#2e2038");
    bird(p, 20 - win * 12, 9 + (phase >> 1), "#2a1428", flap);
    bird(p, 24 - win * 12, 11, "#2a1428", !flap);
  } else {
    gradient(p, 19, [[0, 0x070e2a], [0.55, 0x15245a], [1, 0x2a3c82]]);
    for (let i = 0; i < 22; i++) {
      const x = Math.floor(r() * GW);
      const y = Math.floor(r() * 15);
      const twinkle = i % 3 === 0;
      const lit = !twinkle || (phase + i) % 4 < 2;
      p.p(x, y, lit ? "#fffbe0" : "#6a78b0");
      if (twinkle && lit && i % 6 === 0) {
        p.p(x - 1, y, "#8a98d0");
        p.p(x + 1, y, "#8a98d0");
      }
    }
    const mx = win === 0 ? 23 : 7;
    p.a(mx - 6, 0, 13, 13, "#aab8f0", 0.14);
    disc(p, mx, 6, 4, "#f4f0d0");
    disc(p, mx + 2, 5, 3, "#0d1840");
    p.p(mx - 2, 5, "#fffbe8");
    p.r(wrap(3 + drift + win * 8, 40, 8), 12, 9, 1, "#34468c");
    p.r(wrap(5 + drift + win * 8, 40, 8), 13, 6, 1, "#2a3a78");
    hills(p, win, "#14301f", "#0e2418", "#08160f");
    const hx = win === 0 ? 20 : 4;
    p.r(hx, 16, 6, 4, "#0a1018");
    p.r(hx + 1, 15, 4, 1, "#0a1018");
    p.p(hx + 1, 17, "#ffd070");
    p.p(hx + 4, 17, phase % 3 === 0 ? "#ffb040" : "#ffd070");
  }
  return p;
}

interface LightSpec {
  color: string;
  alpha: number;
  slope: number;
  len: number;
  width: number;
}
const LIGHT: Record<Daypart, LightSpec> = {
  morning: { color: "#ffd88a", alpha: 0.2, slope: 1.1, len: 30, width: 20 },
  noon: { color: "#fff6c8", alpha: 0.2, slope: 0.5, len: 28, width: 22 },
  evening: { color: "#ff9a4c", alpha: 0.24, slope: 2.2, len: 40, width: 18 },
  night: { color: "#9cb0ff", alpha: 0.12, slope: 0.6, len: 26, width: 16 },
};

/** Sun or moon beams falling from the windows onto the floor. Evening beams are long and low (long shadows). */
export function buildLight(daypart: Daypart): Pen {
  const p = newPen(W, H);
  const s = LIGHT[daypart];
  for (const win of WINDOWS) {
    for (let i = 0; i < s.len; i++) {
      const w = Math.max(4, s.width - (i >> 2));
      p.a(win.x + i * s.slope + 4, FLOOR_Y + 3 + i, w, 1, s.color, s.alpha * (1 - i / (s.len * 1.6)));
    }
  }
  if (daypart === "evening") {
    for (const win of WINDOWS) for (let i = 4; i < s.len; i += 2) p.a(win.x + 15 + i * s.slope, FLOOR_Y + 3 + i, 2, 1, "#3a1030", 0.12);
  }
  return p;
}

interface ShadeSpec {
  color: string;
  base: number;
  edge: number;
}
const SHADE: Record<Daypart, ShadeSpec | null> = {
  morning: null,
  noon: null,
  evening: { color: "#3a1450", base: 0.1, edge: 0.22 },
  night: { color: "#060c2c", base: 0.3, edge: 0.3 },
};

/** A colour wash with darker edges over the interior. The window glass is cut out so the sky keeps its colours. */
export function buildShade(daypart: Daypart): Pen | null {
  const s = SHADE[daypart];
  if (!s) return null;
  const p = newPen(W, H);
  p.a(0, 0, W, H, s.color, s.base);
  for (let i = 0; i < 6; i++) {
    const a = (s.edge * (6 - i)) / 14;
    p.a(0, i * 3, W, 3, s.color, a * 0.7);
    p.a(0, H - (i + 1) * 3, W, 3, s.color, a);
    p.a(i * 3, 0, 3, H, s.color, a * 0.8);
    p.a(W - (i + 1) * 3, 0, 3, H, s.color, a * 0.8);
  }
  for (const win of WINDOWS) p.clear(win.x, win.y, GW, GH);
  return p;
}

/** Warm radial glow (drawn additively around candles and sconces). */
export function buildGlow(): Pen {
  const size = 40;
  const p = newPen(size, size);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c + 0.5, y - c + 0.5) / c;
      if (d >= 1) continue;
      const a = (1 - d) * (1 - d) * 0.7;
      // 2x2 ordered dither keeps the pixel-art look instead of a smooth gradient
      const keep = ((x & 1) + 2 * (y & 1)) / 4 < a * 2.2;
      if (keep) p.p(x, y, d < 0.35 ? "#ffd890" : d < 0.65 ? "#ff9a40" : "#c0561c");
    }
  }
  return p;
}
