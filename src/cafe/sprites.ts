// Original character, speech-bubble and quest-ticket sprites, generated from code (no external art).
// Characters are 16x26 px. The Reasoner is a scholar-mage (purple robe, round glasses); the Executor is an
// engineer-knight (teal tunic, steel pauldrons, goggles). Frames are chosen by poses from domain/scene.ts.
import { C, newPen, type Pen } from "./pixel.ts";
import type { BoardState, BubbleKind, ExecutorPose, ReasonerPose } from "../domain/scene.ts";

export type Who = "reasoner" | "executor";
export const CHAR_W = 16;
export const CHAR_H = 26;
const HEAD_Y = 6;

interface Style {
  who: Who;
  skin: string;
  skin2: string;
  hair: string;
  hair2: string;
  cloth: string;
  cloth2: string;
  trim: string;
  boot: string;
  pants: string;
}

const STYLES: Record<Who, Style> = {
  reasoner: {
    who: "reasoner", skin: "#f4d6b4", skin2: "#dcab82", hair: "#d5caf2", hair2: "#a99ad6",
    cloth: C.purple, cloth2: C.purple2, trim: C.gold, boot: "#4a2f2a", pants: C.purple2,
  },
  executor: {
    who: "executor", skin: "#e6b183", skin2: "#c58a5e", hair: "#db7a2c", hair2: "#a85518",
    cloth: C.teal, cloth2: C.teal2, trim: C.steel, boot: "#4a2d1c", pants: "#46465f",
  },
};

type Eyes = "open" | "closed" | "wide" | "up";
type Mouth = "smile" | "open" | "flat" | "sad";
type Prop = { kind: "scroll" | "book" | "cup" | "quill"; x: number; y: number } | null;

interface Rig {
  dy: number;
  headDx: number;
  headDy: number;
  armL: [number, number];
  armR: [number, number];
  /** 0..3 walk phase, -1 stand, 9 sit */
  leg: number;
  eyes: Eyes;
  mouth: Mouth;
  prop: Prop;
  sweat?: boolean;
}

const HANG_L: [number, number] = [2, 21];
const HANG_R: [number, number] = [13, 21];
const rig = (o: Partial<Rig>): Rig => ({
  dy: 0, headDx: 0, headDy: 0, armL: HANG_L, armR: HANG_R, leg: -1, eyes: "open", mouth: "smile", prop: null, ...o,
});

function arm(p: Pen, s: Style, sx: number, sy: number, hx: number, hy: number): void {
  const steps = Math.max(Math.abs(hx - sx), Math.abs(hy - sy), 1);
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(sx + ((hx - sx) * i) / steps);
    const y = Math.round(sy + ((hy - sy) * i) / steps);
    p.r(x, y, 2, 2, i === steps ? s.skin : s.cloth);
    if (i < steps) p.p(x, y + 1, s.cloth2);
  }
}

function prop(p: Pen, pr: Prop): void {
  if (!pr) return;
  const { x, y } = pr;
  switch (pr.kind) {
    case "scroll":
      p.r(x, y, 4, 9, C.cream);
      p.r(x, y, 4, 1, C.cream2);
      p.r(x, y + 8, 4, 1, C.cream2);
      p.r(x + 1, y + 3, 2, 1, C.plaster3);
      p.r(x + 1, y + 5, 2, 1, C.plaster3);
      p.r(x + 1, y + 4, 2, 2, C.red);
      break;
    case "book":
      p.r(x, y, 9, 6, C.blue);
      p.r(x + 1, y + 1, 7, 4, C.cream);
      p.r(x + 4, y + 1, 1, 4, C.paper2);
      p.r(x, y + 5, 9, 1, C.navy);
      break;
    case "cup":
      p.r(x, y, 3, 3, C.white);
      p.r(x + 3, y + 1, 1, 1, C.cream2);
      p.p(x + 1, y, C.pot2);
      break;
    case "quill":
      p.r(x, y, 1, 6, C.cream);
      p.r(x - 1, y, 1, 3, C.cream2);
      p.p(x, y + 6, C.ink);
      break;
  }
}

function face(p: Pen, s: Style, hx: number, hy: number, eyes: Eyes, mouth: Mouth, side: boolean): void {
  const ey = hy + 3;
  const xs = side ? [hx + 6] : [hx + 2, hx + 5];
  for (const ex of xs) {
    if (eyes === "closed") p.r(ex, ey + 1, 2, 1, C.ink);
    else if (eyes === "wide") {
      p.r(ex, ey, 2, 2, C.white);
      p.r(ex + (side ? 1 : 0), ey + 1, 1, 1, C.ink);
    } else if (eyes === "up") {
      p.r(ex, ey, 1, 2, C.ink);
      p.p(ex + 1, ey, C.white);
    } else p.r(ex, ey, 1, 2, C.ink);
  }
  const mx = side ? hx + 6 : hx + 3;
  const my = hy + 6;
  if (mouth === "smile") {
    p.r(mx, my, 2, 1, C.red2);
    if (!side) {
      p.p(mx - 1, my - 1, s.skin2);
      p.p(mx + 2, my - 1, s.skin2);
    }
  } else if (mouth === "open") p.r(mx, my, 2, 2, C.red2);
  else if (mouth === "flat") p.r(mx, my, 2, 1, s.skin2);
  else {
    p.r(mx, my, 2, 1, C.red2);
    p.p(mx - 1, my + 1, s.skin2);
    p.p(mx + 2, my + 1, s.skin2);
  }
  if (!side) {
    p.p(hx + 1, hy + 5, s.skin2);
    p.p(hx + 6, hy + 5, s.skin2);
  }
}

function hairAndHat(p: Pen, s: Style, hx: number, hy: number, side: boolean): void {
  if (s.who === "reasoner") {
    // long lavender hair falling behind the shoulders, round glasses added by caller
    p.r(hx - 1 + (side ? 0 : 0), hy + 1, 2, 8, s.hair2);
    if (!side) p.r(hx + 7, hy + 1, 2, 8, s.hair2);
    p.r(hx, hy, side ? 7 : 8, 2, s.hair);
    p.r(hx, hy + 2, 1, 4, s.hair);
    if (!side) p.r(hx + 7, hy + 2, 1, 4, s.hair);
    p.r(hx + 1, hy + 2, side ? 3 : 6, 1, s.hair);
    // wizard hat
    const bx = hx - 2 + (side ? -1 : 0);
    p.r(bx, hy - 1, side ? 12 : 12, 2, C.purple2);
    p.r(bx, hy - 1, 12, 1, C.purple3);
    p.r(bx + 2, hy - 1, 8, 1, C.gold);
    p.r(bx + 2, hy - 3, 8, 2, C.purple);
    p.r(bx + 4, hy - 5, 4, 2, C.purple);
    p.r(bx + 5 + (side ? -1 : 0), hy - 6, 2, 1, C.purple2);
    p.p(bx + 6, hy - 4, C.gold);
  } else {
    p.r(hx, hy, side ? 7 : 8, 2, s.hair);
    p.r(hx, hy + 2, 1, 3, s.hair);
    if (!side) p.r(hx + 7, hy + 2, 1, 3, s.hair);
    for (let i = 0; i < 4; i++) p.r(hx + 1 + i * 2, hy - 1 - (i % 2), 1 + (i % 2), 2 + (i % 2), s.hair2);
    p.r(hx + 1, hy - 1, 6, 1, s.hair);
    // goggles pushed up on the forehead
    p.r(hx, hy + 1, side ? 7 : 8, 1, C.gold2);
    p.r(hx + 1, hy, 2, 2, C.sky);
    if (!side) p.r(hx + 5, hy, 2, 2, C.sky);
    p.p(hx + 1, hy, C.white);
  }
}

function legsFront(p: Pen, s: Style, by: number, leg: number): void {
  if (s.who === "reasoner") {
    const sit = leg === 9;
    p.r(3, 17 + by, 10, sit ? 4 : 7, s.cloth);
    p.r(3, 17 + by, 10, 1, s.cloth2);
    p.r(8, 17 + by, 1, sit ? 4 : 7, s.cloth2);
    p.r(3, (sit ? 20 : 23) + by, 10, 1, s.trim);
    const l = leg === 0 ? 1 : 0;
    const r = leg === 2 ? 1 : 0;
    p.r(4, (sit ? 21 : 24) - l, 3, 2, s.boot);
    p.r(9, (sit ? 21 : 24) - r, 3, 2, s.boot);
  } else {
    const sit = leg === 9;
    const l = leg === 0 ? 1 : 0;
    const r = leg === 2 ? 1 : 0;
    p.r(5, 19 + by, 3, sit ? 3 : 5 - l, s.pants);
    p.r(9, 19 + by, 3, sit ? 3 : 5 - r, s.pants);
    p.r(4, (sit ? 22 : 24) - l, 4, 2, s.boot);
    p.r(9, (sit ? 22 : 24) - r, 4, 2, s.boot);
    p.r(4, (sit ? 22 : 24) - l, 4, 1, C.ink2);
    p.r(9, (sit ? 22 : 24) - r, 4, 1, C.ink2);
  }
}

function torsoFront(p: Pen, s: Style, by: number): void {
  if (s.who === "reasoner") {
    p.r(4, 14 + by, 8, 6, s.cloth);
    p.r(4, 14 + by, 8, 1, s.cloth2);
    p.r(7, 14 + by, 2, 6, s.trim);
    p.r(4, 19 + by, 8, 1, s.cloth2);
  } else {
    p.r(4, 14 + by, 8, 6, s.cloth);
    p.r(4, 14 + by, 8, 1, C.red); // scarf
    p.r(5, 15 + by, 3, 1, C.red2);
    p.r(4, 19 + by, 8, 1, "#6b4226");
    p.r(7, 19 + by, 2, 1, C.gold);
    p.r(3, 14 + by, 3, 3, s.trim);
    p.r(10, 14 + by, 3, 3, s.trim);
    p.r(3, 14 + by, 3, 1, C.white);
    p.r(10, 14 + by, 3, 1, C.white);
  }
}

function drawFront(p: Pen, s: Style, r: Rig): void {
  const by = r.dy;
  const hx = 4 + r.headDx;
  const hy = HEAD_Y + by + r.headDy;
  legsFront(p, s, by, r.leg);
  torsoFront(p, s, by);
  arm(p, s, 3, 15 + by, r.armL[0], r.armL[1] + by);
  arm(p, s, 11, 15 + by, r.armR[0], r.armR[1] + by);
  p.r(hx, hy, 8, 8, s.skin);
  p.r(hx, hy + 7, 8, 1, s.skin2);
  hairAndHat(p, s, hx, hy, false);
  face(p, s, hx, hy, r.eyes, r.mouth, false);
  if (s.who === "reasoner") {
    // round glasses
    for (const gx of [hx + 1, hx + 4]) {
      p.r(gx, hy + 3, 3, 1, C.gold2);
      p.r(gx, hy + 5, 3, 1, C.gold2);
      p.r(gx, hy + 3, 1, 3, C.gold2);
      p.r(gx + 2, hy + 3, 1, 3, C.gold2);
    }
    p.p(hx + 3, hy + 4, C.gold2);
  }
  if (r.sweat) {
    p.r(hx + 9, hy + 1, 1, 2, C.sky);
    p.p(hx + 9, hy + 3, C.white);
  }
  prop(p, r.prop);
}

function drawSide(p: Pen, s: Style, phase: number): void {
  const by = phase % 2 === 1 ? 1 : 0;
  const swing = [2, 0, -2, 0][phase] ?? 0;
  const hx = 5;
  const hy = HEAD_Y + by;
  // legs
  const frontX = 7 + swing;
  const backX = 5 - swing;
  if (s.who === "reasoner") {
    p.r(4, 17 + by, 9, 7, s.cloth);
    p.r(4, 17 + by, 9, 1, s.cloth2);
    p.r(4, 23 + by, 9, 1, s.trim);
    p.r(backX, 24, 3, 2, s.boot);
    p.r(frontX + 1, 24, 3, 2, s.boot);
  } else {
    p.r(backX, 19 + by, 3, 5, s.pants);
    p.r(frontX, 19 + by, 3, 5, s.pants);
    p.r(backX - 1, 24, 4, 2, s.boot);
    p.r(frontX, 24, 4, 2, s.boot);
  }
  // torso
  p.r(5, 14 + by, 7, 6, s.cloth);
  if (s.who === "reasoner") p.r(7, 14 + by, 2, 6, s.trim);
  else {
    p.r(5, 14 + by, 7, 1, C.red);
    p.r(5, 19 + by, 7, 1, "#6b4226");
    p.r(5, 14 + by, 3, 3, s.trim);
  }
  // swinging arm (front)
  arm(p, s, 7, 15 + by, 7 - swing, 21 + by);
  // head
  p.r(hx, hy, 7, 8, s.skin);
  p.r(hx + 7, hy + 4, 1, 2, s.skin);
  p.r(hx, hy + 7, 7, 1, s.skin2);
  hairAndHat(p, s, hx, hy, true);
  face(p, s, hx, hy, "open", "flat", true);
  if (s.who === "reasoner") {
    p.r(hx + 4, hy + 3, 3, 1, C.gold2);
    p.r(hx + 4, hy + 5, 3, 1, C.gold2);
    p.r(hx + 4, hy + 3, 1, 3, C.gold2);
    p.r(hx + 6, hy + 3, 1, 3, C.gold2);
  }
}

// ---------------------------------------------------------------- pose catalogue (frames of real states)

export type FrameSet = Pen[];

function render(who: Who, rigs: Rig[]): FrameSet {
  return rigs.map((r) => {
    const p = newPen(CHAR_W, CHAR_H);
    drawFront(p, STYLES[who], r);
    return p;
  });
}

const reasonerRigs: Record<ReasonerPose, Rig[]> = {
  idle: [
    rig({ leg: 9, armR: [11, 18], prop: { kind: "cup", x: 12, y: 17 } }),
    rig({ leg: 9, dy: 1, armR: [10, 14], prop: { kind: "cup", x: 9, y: 13 }, eyes: "closed" }),
  ],
  thinking: [
    rig({ armR: [9, 14], armL: [3, 19], eyes: "up", mouth: "flat" }),
    rig({ armR: [9, 14], armL: [3, 19], eyes: "up", mouth: "flat", headDx: 1, dy: 1 }),
  ],
  writing: [
    rig({ headDy: 1, armL: [4, 17], armR: [10, 17], prop: { kind: "quill", x: 11, y: 12 }, mouth: "flat" }),
    rig({ headDy: 1, armL: [4, 17], armR: [11, 18], prop: { kind: "quill", x: 12, y: 13 }, mouth: "flat", dy: 1 }),
  ],
  present: [
    rig({ armR: [13, 8], armL: [2, 19], prop: { kind: "scroll", x: 13, y: 1 } }),
    rig({ armR: [13, 9], armL: [2, 19], prop: { kind: "scroll", x: 13, y: 2 }, mouth: "open", dy: 1 }),
  ],
  cheer: [
    rig({ armL: [1, 8], armR: [14, 8], mouth: "open" }),
    rig({ armL: [1, 10], armR: [14, 10], mouth: "open", dy: 1 }),
  ],
};

const executorRigs: Record<ExecutorPose, Rig[]> = {
  idle: [
    rig({ leg: 9, armR: [11, 18], prop: { kind: "cup", x: 12, y: 17 } }),
    rig({ leg: 9, dy: 1, armR: [10, 14], prop: { kind: "cup", x: 9, y: 13 }, eyes: "closed" }),
  ],
  ready: [
    rig({ armL: [2, 17], armR: [13, 17] }),
    rig({ armL: [2, 17], armR: [13, 17], dy: 1, mouth: "flat" }),
  ],
  thinking: [
    rig({ armR: [9, 14], armL: [3, 19], eyes: "up", mouth: "flat" }),
    rig({ armR: [9, 14], armL: [3, 19], eyes: "up", mouth: "flat", headDx: 1, dy: 1 }),
  ],
  typing: [
    rig({ headDy: 1, armL: [5, 18], armR: [10, 17], mouth: "flat" }),
    rig({ headDy: 1, armL: [5, 17], armR: [10, 18], mouth: "flat", dy: 1 }),
  ],
  writing: [
    rig({ headDy: 1, armL: [4, 17], armR: [10, 17], prop: { kind: "quill", x: 11, y: 12 }, mouth: "flat" }),
    rig({ headDy: 1, armL: [4, 17], armR: [11, 18], prop: { kind: "quill", x: 12, y: 13 }, mouth: "flat", dy: 1 }),
  ],
  reading: [
    rig({ armL: [4, 15], armR: [11, 15], prop: { kind: "book", x: 3, y: 12 }, eyes: "up", mouth: "flat" }),
    rig({ armL: [4, 15], armR: [11, 15], prop: { kind: "book", x: 3, y: 13 }, eyes: "up", mouth: "flat", dy: 1 }),
  ],
  attention: [
    rig({ armR: [13, 5], armL: [2, 19], eyes: "wide", mouth: "open" }),
    rig({ armR: [14, 7], armL: [2, 19], eyes: "wide", mouth: "open", dy: 1 }),
  ],
  celebrate: [
    rig({ armL: [1, 7], armR: [14, 7], mouth: "open" }),
    rig({ armL: [1, 10], armR: [14, 10], mouth: "open", dy: 1 }),
  ],
  error: [
    rig({ armL: [3, 8], armR: [12, 8], eyes: "closed", mouth: "sad", headDy: 1, sweat: true }),
    rig({ armL: [3, 9], armR: [12, 9], eyes: "closed", mouth: "sad", headDy: 1, headDx: 1, sweat: true, dy: 1 }),
  ],
};

export interface CharacterSprites {
  poses: Record<string, FrameSet>;
  walkFront: FrameSet;
  walkSide: FrameSet;
}

export function buildCharacter(who: Who): CharacterSprites {
  const rigs: Record<string, Rig[]> = who === "reasoner" ? reasonerRigs : executorRigs;
  const poses: Record<string, FrameSet> = {};
  for (const [name, list] of Object.entries(rigs)) poses[name] = render(who, list);
  const walkFront = [0, 1, 2, 3].map((ph) => {
    const p = newPen(CHAR_W, CHAR_H);
    const swing = [1, 0, -1, 0][ph] ?? 0;
    drawFront(p, STYLES[who], rig({ dy: ph % 2, leg: ph, armL: [2, 21 + swing], armR: [13, 21 - swing] }));
    return p;
  });
  const walkSide = [0, 1, 2, 3].map((ph) => {
    const p = newPen(CHAR_W, CHAR_H);
    drawSide(p, STYLES[who], ph);
    return p;
  });
  return { poses, walkFront, walkSide };
}

// ---------------------------------------------------------------- speech bubbles

export function buildBubble(kind: Exclude<BubbleKind, "none">): FrameSet {
  const frames = kind === "dots" ? 3 : 2;
  const out: FrameSet = [];
  for (let f = 0; f < frames; f++) {
    const p = newPen(15, 15);
    const bg = kind === "alert" ? C.gold : kind === "cross" ? C.red : C.white;
    p.r(1, 0, 13, 11, C.ink);
    p.r(0, 1, 15, 9, C.ink);
    p.r(1, 1, 13, 9, bg);
    p.r(6, 11, 3, 1, C.ink);
    p.r(7, 12, 1, 1, C.ink);
    p.r(6, 10, 3, 1, bg);
    const fg = kind === "alert" || kind === "cross" ? C.white : C.ink;
    switch (kind) {
      case "dots":
        for (let i = 0; i < 3; i++) p.r(3 + i * 4, 5 + (i === f ? -1 : 0), 2, 2, fg);
        break;
      case "pencil":
        p.r(4 + f, 7, 7, 1, C.ink2);
        p.r(5, 3 + f, 5, 2, C.gold);
        p.r(10, 3 + f, 1, 2, C.ink);
        break;
      case "alert":
        p.r(7, 2, 2, 5, C.ink);
        p.r(7, 8, 2, 1, C.ink);
        if (f) p.r(5, 2, 1, 1, C.red);
        break;
      case "check":
        p.r(4, 6, 2, 2, C.green);
        p.r(6, 7, 2, 2, C.green);
        p.r(8, 5, 2, 2, C.green);
        p.r(10, 3, 2, 2, C.green);
        break;
      case "cross":
        for (let i = 0; i < 6; i++) {
          p.r(4 + i, 3 + i, 2, 1, fg);
          p.r(10 - i, 3 + i, 2, 1, fg);
        }
        break;
      case "gear":
        p.r(5, 3, 5, 5, C.steel2);
        p.r(6, 4, 3, 3, bg);
        p.r(7, 2 - f, 1, 1, C.steel2);
        p.r(7, 8 + f, 1, 1, C.steel2);
        p.r(4 - f, 5, 1, 1, C.steel2);
        p.r(10 + f, 5, 1, 1, C.steel2);
        break;
    }
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- quest ticket on the board

export function buildTicket(state: BoardState): FrameSet {
  const frames = state === "empty" ? 1 : 2;
  const out: FrameSet = [];
  for (let f = 0; f < frames; f++) {
    const p = newPen(20, 22);
    if (state === "empty") {
      out.push(p);
      continue;
    }
    const worn = state === "cancelled";
    const paper = worn ? C.paper2 : C.paper;
    p.r(1, 1, 18, 20, C.ink2);
    p.r(0, 0, 18, 20, paper);
    p.r(0, 19, 18, 1, C.paper2);
    p.r(17, 0, 1, 20, C.paper2);
    p.r(8, 0, 2, 2, C.red2); // pin
    p.p(8, 0, C.red);
    if (state === "drafting") {
      for (let i = 0; i < 4; i++) p.r(3, 5 + i * 3, 8 + ((i * 3 + f * 2) % 5), 1, C.plaster3);
      p.r(12 + f, 14, 1, 4, C.gold2);
    } else {
      for (let i = 0; i < 4; i++) p.r(3, 5 + i * 3, 12 - ((i * 5) % 4), 1, C.plaster3);
    }
    switch (state) {
      case "pending":
        p.r(11, 13, 5, 5, C.red);
        p.r(12, 14, 3, 3, f ? C.gold : C.red2);
        break;
      case "approved":
        p.r(0, 15, 18, 3, C.blue);
        p.r(7, 14, 4, 5, f ? C.gold : C.gold2);
        break;
      case "active":
        p.r(11, 12, 6, 7, C.steel);
        p.r(12, 13, 4, 2 + f, C.sky);
        p.r(12, 17 - f, 4, 1 + f, C.sky);
        break;
      case "done":
        p.r(10, 13, 2, 2, C.green);
        p.r(12, 15, 2, 2, C.green);
        p.r(14, 11 + f, 2, 4, C.green);
        p.r(2, 17, 14, 1, C.green);
        break;
      case "failed":
        for (let i = 0; i < 6; i++) {
          p.r(9 + i, 12 + i, 2, 1, f ? C.red : C.red2);
          p.r(14 - i, 12 + i, 2, 1, f ? C.red : C.red2);
        }
        break;
      case "cancelled":
        p.r(0, 0, 3, 3, C.ink2);
        p.r(10, 14, 6, 1, C.grey);
        break;
      default:
        break;
    }
    out.push(p);
  }
  return out;
}
