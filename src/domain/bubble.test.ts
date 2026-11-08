import assert from "node:assert/strict";
import { test } from "node:test";
import { BUBBLE_MAX_H, BUBBLE_MAX_W, bubbleSize, placeBubble, type Rect } from "./bubble.ts";
import { ALL_DIALOGUE } from "./welcome.ts";

const scene = { w: 288, h: 176 };
const char = { w: 16, h: 26 };
const charRect = (x: number, y: number): Rect => ({ x: x - 8, y: y - 26, w: 16, h: 26 });
const inScene = (x: number, y: number, w: number, h: number) => x >= 0 && y >= 0 && x + w <= scene.w && y + h <= scene.h;

test("every dialogue line produces a small bubble within the width and height limits", () => {
  for (const line of ALL_DIALOGUE) {
    const s = bubbleSize(line);
    assert.ok(s.w <= BUBBLE_MAX_W && s.h + 3 <= BUBBLE_MAX_H, `${line}: ${s.w}x${s.h}`);
    assert.ok(s.w < scene.w / 3, "a bubble stays well under a third of the scene width");
  }
});

test("a short line is a tiny bubble and a long line wraps instead of growing wide", () => {
  const short = bubbleSize("Hi!");
  assert.ok(short.w < 20 && short.lines.length === 1);
  const long = bubbleSize("This is a rather long sentence that must wrap onto several lines but never grow wider than the limit");
  assert.ok(long.w <= BUBBLE_MAX_W && long.lines.length <= 3);
});

test("the bubble sits above the speaker, inside the scene, with the tail over the head", () => {
  const speaker = { x: 121, y: 126 };
  const size = bubbleSize("Hey! Ready to cook up something brilliant?");
  const p = placeBubble({ speaker, size, scene, char, avoid: [] });
  assert.ok(p.y + size.h + 3 <= speaker.y - char.h, "bottom of the tail stays above the head");
  assert.ok(inScene(p.x, p.y, size.w, size.h + 3));
  assert.ok(Math.abs(p.x + p.tailX - speaker.x) <= 1);
});

test("bubbles never cover the other character or a protected object, and stay on screen at the edges", () => {
  const size = bubbleSize("Welcome back, adventurer. Got a quest for us?");
  const speaker = { x: 20, y: 60 };
  const other = charRect(40, 60);
  const board: Rect = { x: 112, y: 4, w: 64, h: 36 };
  const p = placeBubble({ speaker, size, scene, char, avoid: [other, board] });
  const box: Rect = { x: p.x, y: p.y, w: size.w, h: size.h + 3 };
  const hit = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  assert.ok(!hit(box, other) && !hit(box, board));
  assert.ok(inScene(box.x, box.y, box.w, box.h));
  const edge = placeBubble({ speaker: { x: 286, y: 100 }, size, scene, char, avoid: [] });
  assert.ok(inScene(edge.x, edge.y, size.w, size.h + 3));
});
