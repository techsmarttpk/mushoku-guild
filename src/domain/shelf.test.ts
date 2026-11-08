import assert from "node:assert/strict";
import { test } from "node:test";
import { COLS, SHELF_H, SHELF_W, bookLook, clampScroll, contentHeight, hitTest, labelLines, layoutBooks, maxScroll, neighbour, scrollToShow } from "./shelf.ts";

test("every book gets its own rectangle inside the shelf, none overlap", () => {
  const rects = layoutBooks(30);
  assert.equal(rects.length, 30);
  assert.ok(rects.every((r) => r.x >= 0 && r.x + r.w <= SHELF_W));
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i]!, b = rects[j]!;
    assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${i} overlaps ${j}`);
  }
});

test("clicking finds the right book, also after scrolling, and misses between books", () => {
  const rects = layoutBooks(40);
  const third = rects[2]!;
  assert.equal(hitTest(rects, third.x + 3, third.y + 3, 0), 2);
  const far = rects[30]!;
  assert.equal(hitTest(rects, far.x + 2, far.y + 2 - 100, 100), 30, "scroll offsets the hit test");
  assert.equal(hitTest(rects, third.x + third.w + 1, third.y + 5, 0), -1, "the gap between books is empty");
});

test("many documents scroll; few documents do not, and scrolling is clamped", () => {
  assert.equal(maxScroll(3), contentHeight(3) - SHELF_H > 0 ? maxScroll(3) : 0);
  assert.ok(maxScroll(COLS * 12) > 0);
  assert.equal(clampScroll(-50, 100), 0);
  assert.equal(clampScroll(99999, 100), maxScroll(100));
  const rects = layoutBooks(100);
  const last = rects[99]!;
  const s = scrollToShow(last, 0, 100);
  assert.ok(last.y + last.h - s <= SHELF_H && last.y - s >= 0, "the selected book ends up fully visible");
});

test("keyboard navigation moves through the grid and stops at the edges", () => {
  assert.equal(neighbour(0, "left", 10), 0);
  assert.equal(neighbour(0, "right", 10), 1);
  assert.equal(neighbour(0, "down", 20), COLS);
  assert.equal(neighbour(5, "down", 6), 5);
  assert.equal(neighbour(-1, "right", 5), 1);
  assert.equal(neighbour(0, "up", 0), -1);
});

test("book looks are stable per path and CLAUDE.md is the golden book", () => {
  assert.deepEqual(bookLook("docs/a.md"), bookLook("docs/a.md"));
  assert.equal(bookLook("CLAUDE.md").golden, true);
  assert.equal(bookLook("README.md").golden, false);
  assert.ok(new Set(["a.md", "b.md", "c.md", "d.md", "e.md", "f.md"].map((p) => bookLook(p).cover)).size > 2, "spines vary");
});

test("labels fit the cover: at most 3 lines of 6 letters", () => {
  assert.deepEqual(labelLines("Architecture"), ["ARCHIT", "ECTURE"]);
  assert.deepEqual(labelLines("plan"), ["PLAN"]);
  for (const t of ["System design and long-term roadmap of the whole guild", "A", "", "???", "supercalifragilisticexpialidocious"]) {
    const l = labelLines(t);
    assert.ok(l.length >= 1 && l.length <= 3 && l.every((x) => x.length <= 6), t);
  }
});
