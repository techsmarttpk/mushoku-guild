// Geometry of the small RPG dialogue bubbles: size from the wrapped text and placement relative to the speaker.
// Pure so it can be tested; the scene only draws what this returns (scene coordinates are logical pixels).
import { BUBBLE_CHARS, BUBBLE_LINES, wrapText } from "./welcome.ts";

export interface Pt {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 3x5 font at 1x: 4 px per glyph, 7 px per line; padding 4 px sides, 3 px top/bottom. */
export const GLYPH_W = 4;
export const LINE_H = 7;
export const PAD_X = 4;
export const PAD_Y = 3;
export const TAIL_H = 3;
export const BUBBLE_MAX_W = BUBBLE_CHARS * GLYPH_W - 1 + PAD_X * 2;
export const BUBBLE_MAX_H = BUBBLE_LINES * LINE_H - 1 + PAD_Y * 2 + TAIL_H;

export interface BubbleSize {
  lines: string[];
  /** body width and height, tail excluded */
  w: number;
  h: number;
}

export function bubbleSize(text: string): BubbleSize {
  const lines = wrapText(text, BUBBLE_CHARS).slice(0, BUBBLE_LINES);
  const longest = Math.max(1, ...lines.map((l) => l.length));
  return { lines, w: longest * GLYPH_W - 1 + PAD_X * 2, h: lines.length * LINE_H - 1 + PAD_Y * 2 };
}

const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export interface Placement {
  x: number;
  y: number;
  /** tail position inside the bubble, pointing at the speaker's head */
  tailX: number;
}

/**
 * Puts the bubble above the speaker's head (centred), then nudges it sideways if it would cover the other
 * character or a protected object, and finally clamps it inside the scene.
 */
export function placeBubble(o: { speaker: Pt; size: BubbleSize; scene: { w: number; h: number }; char: { w: number; h: number }; avoid: Rect[] }): Placement {
  const { speaker, size, scene, char } = o;
  const total = size.h + TAIL_H;
  const clampX = (x: number) => Math.min(scene.w - size.w - 1, Math.max(1, x));
  const y = Math.max(1, speaker.y - char.h - total);
  const box = (x: number): Rect => ({ x, y, w: size.w, h: total });
  const centred = clampX(Math.round(speaker.x - size.w / 2));
  const candidates = [centred];
  for (const r of o.avoid) {
    candidates.push(clampX(r.x - size.w - 2), clampX(r.x + r.w + 2));
  }
  const x = candidates.find((c) => o.avoid.every((r) => !overlaps(box(c), r))) ?? centred;
  const tailX = Math.min(size.w - 5, Math.max(4, Math.round(speaker.x - x)));
  return { x, y, tailX };
}
