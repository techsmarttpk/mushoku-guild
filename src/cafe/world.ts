// The café interior, drawn once into two layers: `bg` (behind the characters) and `fg` (desk tops and other
// things characters sit behind). 288x176 logical pixels = an 18x11 grid of 16px tiles.
import { C, drawText, newPen, rng, type Pen } from "./pixel.ts";

export const W = 288;
export const H = 176;
export const FLOOR_Y = 48;

/** Where characters stand (feet, bottom centre) — all derived from the layout below. */
export const SPOTS = {
  reasoner: { lounge: { x: 121, y: 126 }, desk: { x: 44, y: 105 }, board: { x: 134, y: 66 } },
  executor: { lounge: { x: 161, y: 126 }, desk: { x: 252, y: 105 }, board: { x: 154, y: 66 } },
  corridorY: 86,
} as const;

/** Slot on the quest board where the current quest ticket is pinned. */
export const BOARD_SLOT = { x: 134, y: 13 };
export const MONITOR = { x: 221, y: 80, w: 20, h: 14 };
export const FLAMES = [
  { x: 68, y: 86 }, // reasoner's candle
  { x: 100, y: 34 }, // wall lamp
  { x: 186, y: 34 },
];
export const STEAM = [{ x: 142, y: 98 }];
/** Top-left of each window's 32x26 glass. */
export const WINDOWS = [{ x: 12, y: 6 }, { x: 190, y: 6 }] as const;

function wall(p: Pen): void {
  const r = rng(11);
  p.r(0, 0, W, 33, C.plaster);
  for (let y = 0; y < 33; y += 3) for (let x = (y % 6) * 2; x < W; x += 12) p.r(x, y, 5, 1, C.plaster2);
  for (let i = 0; i < 90; i++) p.p(Math.floor(r() * W), Math.floor(r() * 31), C.plaster3);
  p.r(0, 0, W, 4, C.beam);
  p.r(0, 4, W, 1, C.ink2);
  p.r(0, 3, W, 1, C.beamHi);
  // posts
  for (const x of [0, 280]) {
    p.r(x, 0, 8, FLOOR_Y, C.beam);
    p.r(x + (x === 0 ? 6 : 0), 0, 2, FLOOR_Y, C.ink2);
    p.r(x + (x === 0 ? 1 : 3), 4, 1, 40, C.beamHi);
  }
  // mid beam + wainscot
  p.r(0, 30, W, 3, C.beam);
  p.r(0, 30, W, 1, C.beamHi);
  p.r(0, 32, W, 1, C.ink2);
  p.r(0, 33, W, 15, C.wain);
  for (let x = 8; x < 280; x += 24) {
    p.r(x, 35, 21, 9, C.wain2);
    p.r(x, 35, 21, 1, C.wainHi);
    p.r(x, 43, 21, 1, C.wainDk);
    p.r(x, 35, 1, 9, C.wainHi);
    p.r(x + 20, 35, 1, 9, C.wainDk);
  }
  p.r(0, 44, W, 4, C.wainDk);
  p.r(0, 44, W, 1, C.wain2);
}

function floor(p: Pen): void {
  const r = rng(7);
  const tones = [C.fl1, C.fl2, C.fl3, C.fl1];
  for (let row = 0, y = FLOOR_Y; y < H; row++, y += 8) {
    let x = -((row * 19) % 40);
    while (x < W) {
      const len = 28 + Math.floor(r() * 3) * 12;
      const tone = tones[Math.floor(r() * tones.length)] ?? C.fl1;
      p.r(x, y, len, 8, tone);
      p.r(x, y, len, 1, C.flHi);
      p.r(x, y + 7, len, 1, C.flDk);
      p.r(x + len - 1, y, 1, 8, C.flDk);
      for (let g = 0; g < 4; g++) p.r(x + 3 + Math.floor(r() * (len - 8)), y + 2 + Math.floor(r() * 4), 3 + Math.floor(r() * 4), 1, C.flDk);
      if (r() < 0.25) {
        const kx = x + 4 + Math.floor(r() * (len - 10));
        p.r(kx, y + 3, 2, 2, C.flDk);
        p.p(kx, y + 3, C.fl3);
      }
      x += len;
    }
  }
  // soft shadow under the wall and window light shafts
  p.a(0, FLOOR_Y, W, 3, C.ink, 0.35);
  p.a(0, FLOOR_Y + 3, W, 2, C.ink, 0.15);
}

function windowAt(p: Pen, x: number, y: number): void {
  p.r(x - 2, y - 2, 36, 30, C.beam);
  p.r(x - 2, y - 2, 36, 1, C.beamHi);
  // The glass is left transparent: the outdoor scenery of the current daypart is drawn behind it (atmosphere.ts).
  p.clear(x, y, 32, 26);
  // frame bars and sill
  p.r(x + 15, y, 2, 26, C.beam);
  p.r(x, y + 11, 32, 2, C.beam);
  p.r(x - 3, y + 26, 38, 3, C.beam2);
  p.r(x - 3, y + 26, 38, 1, C.beamHi);
  // curtains
  for (const cx of [x - 1, x + 25]) {
    p.r(cx, y - 1, 8, 20, C.red);
    for (let i = 0; i < 8; i += 3) p.r(cx + i, y - 1, 1, 20, C.red2);
    p.r(cx, y + 18, 8, 1, C.red2);
  }
  p.r(x - 3, y - 3, 38, 2, C.gold2);
  // pot on the sill
  p.r(x + 11, y + 22, 7, 4, C.pot);
  p.r(x + 12, y + 18, 5, 5, C.green);
  p.p(x + 13, y + 17, C.green3);
  p.p(x + 15, y + 19, C.green3);
}

function shelves(p: Pen, x: number, y: number, w: number): void {
  const r = rng(5);
  for (const sy of [y, y + 13]) {
    p.r(x, sy + 9, w, 3, C.beam2);
    p.r(x, sy + 9, w, 1, C.beamHi);
    p.r(x, sy + 12, w, 1, C.ink2);
    const cols = [C.red, C.blue, C.green, C.gold, C.purple, C.teal, C.cream];
    for (let bx = x + 2; bx < x + w - 6; ) {
      const kind = r();
      const col = cols[Math.floor(r() * cols.length)] ?? C.red;
      if (kind < 0.45) {
        // bottle
        p.r(bx + 1, sy + 1, 2, 3, col);
        p.r(bx, sy + 4, 4, 5, col);
        p.r(bx + 1, sy + 4, 1, 4, C.white);
        bx += 6;
      } else if (kind < 0.8) {
        // mug
        p.r(bx, sy + 5, 5, 4, C.cream);
        p.r(bx + 5, sy + 6, 1, 2, C.cream2);
        p.r(bx, sy + 5, 5, 1, col);
        bx += 8;
      } else {
        // jar
        p.r(bx, sy + 3, 5, 6, C.glass);
        p.r(bx, sy + 3, 5, 1, C.steel);
        p.r(bx + 1, sy + 6, 3, 3, col);
        bx += 7;
      }
    }
  }
}

function questBoard(p: Pen): void {
  const x = 112,
    y = 6,
    w = 64,
    h = 34;
  p.r(x - 2, y - 2, w + 4, h + 4, C.beam);
  p.r(x - 2, y - 2, w + 4, 1, C.beamHi);
  p.r(x, y, w, h, "#b98a55");
  const r = rng(21);
  for (let i = 0; i < 140; i++) p.p(x + Math.floor(r() * w), y + Math.floor(r() * h), r() < 0.5 ? "#a47642" : "#cc9d66");
  p.r(x, y, w, 1, "#8d6238");
  p.r(x, y + h - 1, w, 1, "#8d6238");
  // sign above the board
  p.r(x + 12, y - 9, 40, 8, C.beam2);
  p.r(x + 12, y - 9, 40, 1, C.beamHi);
  p.r(x + 12, y - 2, 40, 1, C.ink2);
  drawText(p, x + 14 + 1, y - 7, "QUESTS", C.gold);
  p.r(x + 16, y - 11, 1, 3, C.steel2);
  p.r(x + 48, y - 11, 1, 3, C.steel2);
  // old, faded notes (decoration only — the live quest ticket is a separate sprite)
  const notes: Array<[number, number, number, number, string]> = [
    [x + 4, y + 4, 14, 12, C.paper2],
    [x + 6, y + 19, 12, 11, C.paper2],
    [x + 44, y + 3, 15, 14, C.paper2],
    [x + 46, y + 20, 13, 11, C.paper2],
  ];
  for (const [nx, ny, nw, nh, col] of notes) {
    p.r(nx, ny, nw, nh, col);
    p.r(nx, ny + nh - 1, nw, 1, C.plaster3);
    for (let ly = ny + 3; ly < ny + nh - 2; ly += 2) p.r(nx + 2, ly, nw - 5 - (ly % 3), 1, C.plaster3);
    p.p(nx + (nw >> 1), ny, C.red2);
  }
  // slot where the live ticket appears gets a faint outline
  p.a(BOARD_SLOT.x, BOARD_SLOT.y, 20, 22, C.ink, 0.12);
}

function sconce(p: Pen, x: number, y: number): void {
  p.r(x - 1, y + 7, 7, 2, C.gold2);
  p.r(x + 1, y + 4, 3, 4, C.steel);
  p.r(x, y + 9, 5, 2, C.beam);
  p.a(x - 5, y - 4, 15, 18, C.sun, 0.1);
  p.a(x - 3, y - 2, 11, 14, C.sun, 0.12);
}

function bookcase(p: Pen, x: number, y: number): void {
  const r = rng(33);
  p.r(x, y, 40, 44, C.beam);
  p.r(x, y, 40, 1, C.beamHi);
  p.r(x + 2, y + 2, 36, 40, C.ink2);
  const cols = [C.red, C.blue, C.green, C.gold, C.purple, C.teal, C.cream2, C.red2];
  for (let row = 0; row < 3; row++) {
    const ry = y + 3 + row * 13;
    let bx = x + 3;
    while (bx < x + 36) {
      const bw = 2 + Math.floor(r() * 3);
      const bh = 8 + Math.floor(r() * 3);
      const col = cols[Math.floor(r() * cols.length)] ?? C.red;
      p.r(bx, ry + 10 - bh, bw, bh, col);
      p.r(bx, ry + 10 - bh, 1, bh, C.white);
      p.a(bx, ry + 10 - bh, 1, bh, C.white, 0.0);
      bx += bw + (r() < 0.2 ? 1 : 0);
    }
    p.r(x + 2, ry + 10, 36, 2, C.beam2);
    p.r(x + 2, ry + 10, 36, 1, C.beamHi);
  }
}

function counter(p: Pen): void {
  const x = 46,
    y = 40,
    w = 66;
  p.r(x, y + 4, w, 20, C.wain2);
  for (let bx = x + 3; bx < x + w - 3; bx += 11) {
    p.r(bx, y + 9, 9, 12, C.wain);
    p.r(bx, y + 9, 9, 1, C.wainHi);
    p.r(bx, y + 20, 9, 1, C.wainDk);
  }
  p.r(x - 2, y + 2, w + 4, 4, C.beamHi);
  p.r(x - 2, y + 2, w + 4, 1, C.wainHi);
  p.r(x - 2, y + 5, w + 4, 1, C.ink2);
  p.r(x, y + 22, w, 2, C.wainDk);
  // items on the counter: cake dome, kettle, cups
  p.r(x + 6, y - 4, 12, 2, C.glass);
  p.r(x + 7, y - 7, 10, 3, C.glass);
  p.r(x + 8, y - 2, 8, 3, C.pot);
  p.r(x + 6, y + 1, 12, 1, C.cream);
  p.r(x + 30, y - 4, 8, 6, C.steel);
  p.r(x + 29, y - 2, 1, 3, C.steel2);
  p.r(x + 38, y - 3, 3, 1, C.steel);
  p.r(x + 31, y - 6, 6, 2, C.steel2);
  for (const cx of [x + 48, x + 55]) {
    p.r(cx, y - 1, 5, 3, C.cream);
    p.r(cx + 5, y, 1, 2, C.cream2);
    p.r(cx + 1, y - 1, 3, 1, C.pot2);
  }
}

function stool(p: Pen, x: number, y: number): void {
  p.r(x - 1, y + 6, 1, 6, C.beam);
  p.r(x + 6, y + 6, 1, 6, C.beam);
  p.r(x, y + 11, 6, 1, C.beam);
  p.r(x - 2, y, 10, 3, C.red);
  p.r(x - 2, y, 10, 1, C.pot);
  p.r(x - 2, y + 3, 10, 2, C.red2);
}

function plant(p: Pen, x: number, y: number, big: boolean): void {
  const h = big ? 14 : 9;
  p.r(x, y, 12, 9, C.pot);
  p.r(x - 1, y, 14, 2, C.pot2);
  p.r(x, y + 8, 12, 1, C.pot2);
  for (let i = 0; i < (big ? 8 : 5); i++) {
    const lx = x + 1 + ((i * 5) % 10);
    const ly = y - h + ((i * 3) % 6);
    p.r(lx, ly, 4, h - ((i * 3) % 6), i % 2 ? C.green : C.green2);
    p.r(lx + 1, ly, 1, 3, C.green3);
  }
}

function rug(p: Pen): void {
  const x = 90,
    y = 98,
    w = 108,
    h = 56;
  p.r(x, y, w, h, C.rug);
  p.r(x, y, w, 2, C.rugGold);
  p.r(x, y + h - 2, w, 2, C.rugGold);
  p.r(x, y, 2, h, C.rugGold);
  p.r(x + w - 2, y, 2, h, C.rugGold);
  p.r(x + 4, y + 4, w - 8, h - 8, C.rug2);
  p.r(x + 5, y + 5, w - 10, 1, C.rugGold);
  p.r(x + 5, y + h - 6, w - 10, 1, C.rugGold);
  for (let dx = 12; dx < w - 12; dx += 12) {
    for (const dy of [h >> 1]) {
      p.r(x + dx, y + dy - 1, 3, 3, C.rugGold);
      p.r(x + dx - 1, y + dy, 5, 1, C.rugGold);
      p.r(x + dx + 1, y + dy - 2, 1, 5, C.rugGold);
    }
  }
  for (let fx = x + 1; fx < x + w; fx += 3) {
    p.r(fx, y - 2, 1, 2, C.cream2);
    p.r(fx, y + h, 1, 2, C.cream2);
  }
}

function roundTable(p: Pen, cx: number, cy: number): void {
  p.r(cx - 3, cy + 2, 6, 14, C.beam);
  p.r(cx - 8, cy + 14, 16, 3, C.beam2);
  p.r(cx - 16, cy - 8, 32, 12, C.beamHi);
  p.r(cx - 14, cy - 10, 28, 2, C.beamHi);
  p.r(cx - 12, cy - 11, 24, 1, C.wainHi);
  p.r(cx - 14, cy + 4, 28, 2, C.wain);
  p.r(cx - 16, cy - 8, 32, 1, C.wainHi);
  p.r(cx - 12, cy + 6, 24, 1, C.wainDk);
  // tea set and a candle
  p.r(cx - 5, cy - 8, 8, 5, C.cream);
  p.r(cx + 3, cy - 7, 2, 3, C.cream);
  p.r(cx - 6, cy - 5, 2, 1, C.cream2);
  p.r(cx - 5, cy - 9, 8, 1, C.pot);
  p.r(cx + 8, cy - 7, 4, 3, C.cream);
  p.r(cx - 12, cy - 6, 4, 3, C.cream);
}

function desk(p: Pen, x: number, y: number, w: number): void {
  // top (drawn in fg so characters sit behind it)
  p.r(x, y, w, 7, C.beamHi);
  p.r(x, y, w, 1, C.wainHi);
  p.r(x, y + 6, w, 1, C.wain);
  p.r(x - 1, y + 1, 1, 7, C.wainDk);
  p.r(x + w, y + 1, 1, 7, C.wainDk);
  p.r(x, y + 7, w, 14, C.wain2);
  p.r(x + 3, y + 9, w - 6, 10, C.wain);
  p.r(x + 3, y + 9, w - 6, 1, C.wainDk);
  p.r(x + (w >> 1) - 6, y + 11, 12, 6, C.wain2);
  p.r(x + (w >> 1) - 1, y + 13, 3, 2, C.gold);
  p.r(x, y + 21, 4, 3, C.wainDk);
  p.r(x + w - 4, y + 21, 4, 3, C.wainDk);
}

function chair(p: Pen, x: number, y: number): void {
  p.r(x, y, 14, 18, C.beam);
  p.r(x + 1, y + 1, 12, 14, C.red2);
  p.r(x + 1, y + 1, 12, 1, C.red);
  p.r(x + 2, y + 15, 10, 2, C.beam2);
}

function door(p: Pen): void {
  const x = 126,
    y = 158;
  p.r(x - 3, y, 42, 18, C.beam);
  p.r(x, y + 3, 36, 15, C.ink2);
  p.a(x, y + 3, 36, 15, C.sun, 0.18);
  p.r(x + 16, y + 3, 2, 15, C.beam);
  p.r(x + 3, y + 6, 10, 9, C.wain2);
  p.r(x + 22, y + 6, 10, 9, C.wain2);
  p.r(x + 14, y + 11, 2, 2, C.gold);
  // welcome mat
  p.r(x + 2, y - 4, 32, 4, C.rug2);
  p.r(x + 3, y - 3, 30, 1, C.rugGold);
}

function crates(p: Pen, x: number, y: number): void {
  for (const [cx, cy] of [[x, y + 12], [x + 15, y + 12], [x + 7, y]] as const) {
    p.r(cx, cy, 14, 14, C.beam2);
    p.r(cx, cy, 14, 2, C.beamHi);
    p.r(cx, cy + 12, 14, 2, C.wainDk);
    p.r(cx + 2, cy + 2, 1, 10, C.wainDk);
    p.r(cx + 11, cy + 2, 1, 10, C.wainDk);
    p.r(cx + 2, cy + 6, 10, 1, C.wainDk);
  }
}

function banner(p: Pen, x: number, y: number): void {
  p.r(x, y, 26, 2, C.gold2);
  p.r(x + 2, y + 2, 22, 13, C.teal2);
  p.r(x + 2, y + 2, 22, 1, C.teal);
  p.r(x + 11, y + 14, 4, 3, C.teal2);
  drawText(p, x + 5, y + 5, "GUILD", C.cream);
  p.r(x + 4, y + 11, 18, 1, C.gold);
}

export function buildBackground(): Pen {
  const p = newPen(W, H);
  wall(p);
  floor(p);
  for (const win of WINDOWS) windowAt(p, win.x, win.y);
  bookcase(p, 236, 4);
  shelves(p, 50, 6, 56);
  banner(p, 80, 34 - 6);
  questBoard(p);
  sconce(p, 100, 14);
  sconce(p, 184, 14);
  counter(p);
  stool(p, 60, 70);
  stool(p, 90, 70);
  rug(p);
  chair(p, 37, 74);
  chair(p, 245, 74);
  crates(p, 10, 146);
  plant(p, 6, 52, true);
  plant(p, 266, 140, true);
  plant(p, 254, 150, false);
  door(p);
  // stools at the table (characters sit on them in the lounge spot)
  stool(p, 118, 118);
  stool(p, 158, 118);
  roundTable(p, 144, 112);
  return p;
}

/** Foreground: desks (with their props) and the plant in front of the counter. */
export function buildForeground(): Pen {
  const p = newPen(W, H);
  desk(p, 14, 98, 60);
  desk(p, 214, 98, 60);
  // reasoner's desk props: open book, ink pot, scroll, candle
  p.r(20, 94, 13, 5, C.cream);
  p.r(26, 94, 1, 5, C.paper2);
  for (const ly of [95, 97]) {
    p.r(22, ly, 3, 1, C.plaster3);
    p.r(28, ly, 3, 1, C.plaster3);
  }
  p.r(36, 95, 4, 4, C.navy);
  p.r(37, 94, 2, 1, C.navy);
  p.r(52, 92, 12, 6, C.paper);
  p.r(52, 92, 12, 1, C.paper2);
  p.r(52, 97, 12, 1, C.paper2);
  p.r(66, 91, 4, 7, C.cream);
  p.r(66, 91, 4, 1, C.cream2);
  p.r(67, 89, 2, 2, C.ink);
  // executor's desk props: terminal frame, keyboard, mug, small anvil
  p.r(MONITOR.x - 2, MONITOR.y - 2, MONITOR.w + 4, MONITOR.h + 4, C.steel2);
  p.r(MONITOR.x - 2, MONITOR.y - 2, MONITOR.w + 4, 1, C.steel);
  p.r(MONITOR.x + 7, MONITOR.y + MONITOR.h + 2, 6, 2, C.steel2);
  p.r(MONITOR.x + 3, MONITOR.y + MONITOR.h + 4, 14, 1, C.steel2);
  p.r(MONITOR.x - 8, 94, 18, 4, C.steel);
  for (let kx = MONITOR.x - 7; kx < MONITOR.x + 8; kx += 2) p.r(kx, 95, 1, 2, C.steel2);
  p.r(264, 93, 6, 6, C.cream);
  p.r(270, 94, 2, 3, C.cream);
  p.r(265, 93, 4, 1, C.pot2);
  return p;
}

export function buildMonitorFrame(kind: "off" | "a" | "b"): Pen {
  const p = newPen(MONITOR.w, MONITOR.h);
  p.r(0, 0, MONITOR.w, MONITOR.h, kind === "off" ? C.navy : "#0e2a2f");
  if (kind !== "off") {
    const off = kind === "a" ? 0 : 1;
    const cols = [C.green3, C.sky, C.gold, C.green3, C.sky2];
    for (let i = 0; i < 4; i++) {
      p.r(2, 2 + i * 3 + off, 4 + ((i * 5 + off) % 11), 1, cols[(i + off) % cols.length] ?? C.green3);
    }
    p.r(2, 12, 2, 1, C.green3);
  } else {
    p.a(0, 0, MONITOR.w, 3, C.white, 0.08);
  }
  return p;
}

export function buildFlame(frame: 0 | 1): Pen {
  const p = newPen(5, 7);
  p.r(2, 3 + frame, 1, 3 - frame, C.gold);
  p.r(1, 4, 3, 2, C.gold);
  p.r(2, 2 + frame, 1, 2, C.sun);
  p.p(2, 5, C.white);
  p.p(frame ? 1 : 3, 4, C.red);
  return p;
}

export function buildSteam(frame: 0 | 1): Pen {
  const p = newPen(9, 12);
  for (let y = 0; y < 12; y += 2) {
    const x = 3 + (((y >> 1) + frame) % 2) * 2 + (y > 6 ? 1 : 0);
    p.a(x, 11 - y, 2, 2, C.white, 0.55 - y * 0.035);
  }
  return p;
}
