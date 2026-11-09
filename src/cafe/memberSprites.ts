// Guild members: original 16x26 pixel-art characters generated from a Look (domain/guild.ts), in the same style as the
// Reasoner and Executor. Nothing here is copied from any game: every figure is assembled from rectangles and palettes, so
// each recruited model gets its own hair, clothing, colours, accessory and activity.
import { C, drawText, newPen, textWidth, type Pen } from "./pixel.ts";
import { LOOK_SIZES, type Activity, type Look, type MemberState } from "../domain/guild.ts";

export const MEMBER_W = 16;
export const MEMBER_H = 26;

const SKIN: Array<[string, string]> = [
  ["#f6d9bb", "#dfb48b"], ["#f0c8a0", "#d29d73"], ["#e0aa7c", "#c0865b"], ["#c98a5e", "#a96a42"], ["#a9693f", "#864d2c"], ["#7e4a2c", "#5e3320"],
];
const HAIR = ["#2b1d16", "#5a3a22", "#8a5a2b", "#c8872e", "#e3c25a", "#d65a3a", "#b04aa0", "#4a7bc8", "#5fa86a", "#d7d7e6"];
const CLOTH: Array<[string, string]> = [
  ["#c8453b", "#8f2c2a"], ["#d9822b", "#a85d17"], ["#e0b93a", "#b0882a"], ["#3f9150", "#2c6b3b"], ["#2f9a98", "#1f6e72"], ["#3b6fb5", "#264a82"],
  ["#2e4b8a", "#1d2f55"], ["#6f4bb2", "#4d3380"], ["#d86a9a", "#a84775"], ["#8a5a2f", "#5e3b1d"], ["#8a93a3", "#5d6573"], ["#e8e2d2", "#bdb59f"],
];
const LIGHT_CLOTH = new Set([2, 11]);

type Painter = (x: number, y: number, w: number, h: number, c: string) => void;

function drawBack(look: Look, u: Painter, hair: string): void {
  // hair that falls behind the shoulders is drawn before the body so the body covers its top
  if (look.hairStyle === 1) {
    u(3, 6, 2, 13, hair);
    u(11, 6, 2, 13, hair);
  }
  if (look.hairStyle === 4) {
    u(12, 8, 2, 8, hair);
    u(13, 15, 1, 2, hair);
  }
}

function drawLegsAndBody(p: Pen, look: Look, u: Painter): void {
  const [main, dark] = CLOTH[look.cloth % LOOK_SIZES.cloth] as [string, string];
  const trim = LIGHT_CLOTH.has(look.cloth) ? C.navy : C.gold;
  const boot = "#4a2d1c";
  const pants = "#46465f";
  switch (look.outfit) {
    case 0: // long robe
      p.r(3, 15, 10, 9, main);
      p.r(3, 15, 10, 1, dark);
      p.r(7, 15, 2, 9, trim);
      p.r(3, 23, 10, 1, dark);
      break;
    case 1: // tunic and trousers
      p.r(5, 20, 3, 4, pants);
      p.r(9, 20, 3, 4, pants);
      u(4, 14, 8, 7, main);
      u(4, 14, 8, 1, dark);
      u(4, 19, 8, 1, "#6b4226");
      u(7, 19, 2, 1, trim);
      break;
    case 2: // cloak over a plain shirt
      p.r(5, 20, 3, 4, pants);
      p.r(9, 20, 3, 4, pants);
      u(4, 14, 8, 6, "#e3d6b8");
      u(3, 14, 10, 9, dark);
      u(5, 14, 6, 4, "#e3d6b8");
      u(7, 14, 2, 1, trim);
      break;
    case 3: // work apron
      p.r(5, 20, 3, 4, pants);
      p.r(9, 20, 3, 4, pants);
      u(4, 14, 8, 6, main);
      u(5, 16, 6, 7, "#efe8d6");
      u(5, 14, 1, 2, "#efe8d6");
      u(10, 14, 1, 2, "#efe8d6");
      u(5, 16, 6, 1, "#d6ccb2");
      break;
    default: // vest over a light shirt
      p.r(5, 20, 3, 4, dark);
      p.r(9, 20, 3, 4, dark);
      u(4, 14, 8, 6, "#efe8d6");
      u(4, 14, 3, 6, main);
      u(9, 14, 3, 6, main);
      u(7, 15, 2, 5, "#d6ccb2");
      break;
  }
  p.r(4, 24, 3, 2, boot);
  p.r(9, 24, 3, 2, boot);
}

function sleeve(look: Look): string {
  const [main, dark] = CLOTH[look.cloth % LOOK_SIZES.cloth] as [string, string];
  return look.outfit === 2 ? dark : main;
}

function drawArmsAndProp(p: Pen, look: Look, u: Painter, frame: number, skin: string): void {
  const s = sleeve(look);
  const hand = (x: number, y: number): void => u(x, y, 2, 2, skin);
  const act: Activity = look.activity;
  const f = frame;
  switch (act) {
    case "book": {
      u(3, 15, 2, 4, s);
      u(11, 15, 2, 4, s);
      hand(3, 18);
      hand(11, 18);
      u(4, 16, 8, 5, C.blue);
      u(5, 17, 6, 3, C.cream);
      u(7, 17, 2, 3, C.paper2);
      if (f === 1) u(5, 17, 2, 3, C.paper); // a page turns
      else u(9, 17, 2, 3, C.paper);
      u(4, 20, 8, 1, C.navy);
      break;
    }
    case "scroll": {
      u(3, 15, 2, 4, s);
      u(11, 15, 2, 4, s);
      hand(3, 18);
      hand(11, 18);
      u(2, 15, 2, 5, C.cream2);
      u(12, 15, 2, 5, C.cream2);
      u(3, 16, 10, 3, C.paper);
      u(5, 17 + (f ? 1 : 0), 6, 1, C.plaster3);
      u(5, 16, 3, 1, C.plaster3);
      u(10, 17, 1, 1, C.red);
      break;
    }
    case "notes": {
      u(3, 15, 2, 4, s);
      u(11, 15, 2, 3, s);
      hand(3, 18);
      hand(11, 17);
      u(3, 17, 6, 5, "#7a4b2a");
      u(4, 18, 4, 3, C.paper);
      u(5, 19, 2, 1, C.plaster3);
      u(10, 14 + (f ? 0 : 1), 1, 5, C.cream);
      u(10, 19 + (f ? 0 : 1), 1, 1, C.ink);
      if (f) p.p(9, 21, C.ink2);
      break;
    }
    case "carry": {
      const o = f ? -1 : 0;
      u(2, 18, 2, 4, s);
      u(12, 18, 2, 4, s);
      hand(2, 21);
      hand(12, 21);
      u(3, 19 + o, 10, 3, C.red);
      u(3, 19 + o, 10, 1, C.red2);
      u(4, 16 + o, 8, 3, C.green);
      u(4, 16 + o, 8, 1, C.green2);
      u(3, 13 + o, 9, 3, C.blue);
      u(3, 13 + o, 9, 1, C.navy);
      u(4, 14 + o, 1, 1, C.cream);
      break;
    }
    case "map": {
      u(3, 15, 2, 4, s);
      u(11, 15, 2, 4, s);
      hand(2, 17);
      hand(12, 17);
      u(2, 15, 12, 8, C.paper);
      u(2, 15, 12, 1, C.paper2);
      u(7, 15, 1, 8, C.paper2);
      u(4, 18, 1, 1, C.plaster3);
      u(5, 19, 1, 1, C.plaster3);
      u(6, 20, 1, 1, C.plaster3);
      u(9, 17, 3, 1, C.green3);
      u(10, 20, 2, 2, f ? C.gold : C.red);
      break;
    }
    default: {
      // orb: one hand raised holding a glowing sphere
      u(3, 15, 2, 6, s);
      hand(3, 20);
      u(11, 14, 2, 3, s);
      u(12, 11, 2, 3, s);
      hand(12, 10);
      const glow = f ? "#cfe9ff" : "#8fd3ee";
      u(11, 5, 6, 6, "#6f4bb2");
      u(12, 6, 4, 4, glow);
      u(13, 7, 2, 2, C.white);
      p.p(10, 4 + (f ? 1 : 0), C.sun);
      break;
    }
  }
}

function drawHead(look: Look, u: Painter, frame: number, skin: string, skin2: string, hair: string): void {
  u(4, 6, 8, 8, skin);
  u(4, 13, 8, 1, skin2);
  const blink = frame === 1 && (look.activity === "book" || look.activity === "scroll");
  if (blink) {
    u(6, 10, 2, 1, C.ink);
    u(9, 10, 2, 1, C.ink);
  } else {
    u(6, 9, 1, 2, C.ink);
    u(9, 9, 1, 2, C.ink);
  }
  u(7, 12, 2, 1, C.red2);
  u(4, 11, 1, 1, skin2);
  u(11, 11, 1, 1, skin2);
  switch (look.hairStyle) {
    case 0:
      u(4, 5, 8, 3, hair);
      u(4, 8, 1, 2, hair);
      u(11, 8, 1, 2, hair);
      break;
    case 1:
      u(4, 5, 8, 3, hair);
      u(4, 8, 1, 3, hair);
      u(11, 8, 1, 3, hair);
      break;
    case 2:
      u(4, 5, 8, 3, hair);
      u(4, 8, 1, 2, hair);
      u(11, 8, 1, 2, hair);
      u(6, 2, 4, 3, hair);
      u(7, 1, 2, 1, hair);
      break;
    case 3:
      u(4, 6, 8, 2, hair);
      u(4, 4, 2, 2, hair);
      u(7, 3, 2, 3, hair);
      u(10, 4, 2, 2, hair);
      break;
    case 4:
      u(4, 5, 8, 3, hair);
      u(4, 8, 1, 2, hair);
      u(11, 8, 1, 2, hair);
      break;
    default:
      u(4, 5, 8, 2, hair);
      u(5, 7, 2, 1, hair);
      break;
  }
}

function drawAccessory(look: Look, u: Painter): void {
  const [main, dark] = CLOTH[look.cloth % LOOK_SIZES.cloth] as [string, string];
  const accent = LIGHT_CLOTH.has(look.cloth) ? C.navy : C.gold;
  switch (look.accessory) {
    case 1: // round glasses
      for (const gx of [5, 9]) {
        u(gx, 8, 3, 1, C.gold2);
        u(gx, 11, 3, 1, C.gold2);
        u(gx, 8, 1, 4, C.gold2);
        u(gx + 2, 8, 1, 4, C.gold2);
      }
      u(8, 9, 1, 1, C.gold2);
      break;
    case 2: // pointed hat
      u(2, 5, 12, 2, dark);
      u(2, 5, 12, 1, main);
      u(4, 2, 8, 3, main);
      u(6, 0, 4, 2, main);
      u(4, 4, 8, 1, accent);
      break;
    case 3: // cap
      u(4, 4, 8, 3, main);
      u(3, 7, 10, 1, dark);
      u(4, 4, 8, 1, accent);
      break;
    case 4: // scarf
      u(4, 14, 8, 2, "#c8453b");
      u(10, 16, 2, 4, "#8f2c2a");
      break;
    case 5: // headband
      u(4, 6, 8, 1, accent);
      u(11, 6, 2, 2, accent);
      break;
    case 6: // goggles pushed up
      u(4, 5, 8, 1, C.gold2);
      u(5, 3, 2, 2, C.sky);
      u(9, 3, 2, 2, C.sky);
      u(5, 3, 1, 1, C.white);
      break;
    default:
      break;
  }
}

/** Two animation frames of the character doing its activity. */
export function buildMember(look: Look): Pen[] {
  const [skin, skin2] = SKIN[look.skin % LOOK_SIZES.skin] as [string, string];
  const hair = HAIR[look.hair % LOOK_SIZES.hair] as string;
  return [0, 1].map((frame) => {
    const p = newPen(MEMBER_W, MEMBER_H);
    const dy = frame === 1 && look.activity !== "carry" ? 1 : 0; // a slow breath: the upper body rises and falls one pixel
    const u: Painter = (x, y, w, h, c) => p.r(x, y + dy, w, h, c);
    drawBack(look, u, hair);
    drawLegsAndBody(p, look, u);
    drawArmsAndProp(p, look, u, frame, skin);
    drawHead(look, u, frame, skin, skin2, hair);
    drawAccessory(look, u);
    return p;
  });
}

// ---------------------------------------------------------------- indicator and nameplate

const DOT: Record<MemberState, string> = { available: "#5fd16f", unavailable: "#d9594c", offline: "#d9a63a" };

/** A 5x5 availability light shown above the character's head. */
export function buildDot(state: MemberState): Pen {
  const p = newPen(5, 5);
  p.r(0, 1, 5, 3, C.ink);
  p.r(1, 0, 3, 5, C.ink);
  p.r(1, 1, 3, 3, DOT[state]);
  p.p(1, 1, C.white);
  return p;
}

/** The pixel font only has capitals, digits and a little punctuation: anything else becomes a space. */
export function plateText(s: string, max: number): string {
  const t = s
    .toUpperCase()
    .replace(/[^A-Z0-9.,'!?:-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1).trim()}.` : t;
}

/** Name and provider on a small sign, shown while a character is selected. */
export function buildNameplate(name: string, vendor: string): Pen {
  const a = plateText(name, 26) || "MODEL";
  const b = plateText(`${vendor} - OPENROUTER`, 26);
  const w = Math.max(textWidth(a), textWidth(b)) + 6;
  const p = newPen(w, 17);
  p.r(0, 0, w, 17, C.gold2);
  p.r(1, 1, w - 2, 15, C.ink);
  drawText(p, 3, 3, a, C.cream);
  drawText(p, 3, 10, b, C.gold);
  return p;
}
