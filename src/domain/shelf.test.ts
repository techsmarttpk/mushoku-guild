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

// ---- responsive layout (Cycle 6)
import { ROW_H as ROW, TOP as TOPY, BOOK_H as BH, BOOK_W as BW, columnsFor, fitView, layoutBooks as layout, maxScroll as maxScr, rowCount as rows, contentHeight as contentH, MIN_VIEW_W } from "./shelf.ts";

const WINDOWS: Array<[string, number, number]> = [
  ["1366x768", 890, 574],
  ["1280x720", 804, 526],
  ["1600x900", 1124, 706],
  ["maximised 1920x1080", 1444, 886],
  ["narrow 900x480", 504, 286],
  ["tiny", 150, 120],
];

test("the shelf fills any window: columns follow the width and nothing is clipped or overlapping", () => {
  for (const [name, w, h] of WINDOWS) {
    for (const count of [0, 1, 7, 38, 120]) {
      const { scale, view } = fitView(w, h);
      const cols = columnsFor(view.w);
      const rects = layout(count, cols, view.w);
      assert.ok(cols >= 1, name);
      assert.ok(scale >= 1 && scale <= 3, `${name} scale`);
      for (const r of rects) {
        assert.ok(r.x >= 0 && r.x + r.w <= view.w, `${name}: book ${r.index} clipped horizontally`);
        assert.ok(r.y >= 0 && r.y + r.h <= contentH(count, cols, view.h), `${name}: book ${r.index} outside the shelf`);
      }
      // no overlap: distinct grid cells, rows separated by at least one book height
      const seen = new Set(rects.map((r) => `${r.x},${r.y}`));
      assert.equal(seen.size, rects.length, `${name}: overlapping books`);
      for (let i = cols; i < rects.length; i++) assert.ok((rects[i]?.y ?? 0) - (rects[i - cols]?.y ?? 0) >= BH, `${name}: rows overlap`);
      // the boards fill at least the whole view, and every book can be scrolled into view
      assert.ok(contentH(count, cols, view.h) >= view.h, `${name}: shelf shorter than the view`);
      assert.ok(rows(count, cols, view.h) * cols >= count, `${name}: rows missing`);
      const last = rects.at(-1);
      if (last) assert.ok(last.y + last.h - maxScr(count, cols, view.h) <= view.h, `${name}: last book unreachable`);
    }
  }
});

test("wider windows get more columns, narrower ones fewer; books keep their proportions", () => {
  const wide = fitView(1444, 886);
  const mid = fitView(890, 574);
  const narrow = fitView(504, 286);
  assert.ok(columnsFor(wide.view.w) > columnsFor(mid.view.w), "a maximised window shows more books per row");
  const tiny = fitView(150, 120);
  assert.ok(columnsFor(tiny.view.w) < columnsFor(mid.view.w), "a very narrow window shows fewer books per row");
  assert.ok(columnsFor(narrow.view.w) >= 3, "still usable when narrow");
  // books are only ever scaled uniformly (one CSS scale for both axes), never stretched
  for (const f of [wide, mid, narrow, tiny]) assert.ok(f.scale >= 1 && f.scale <= 3 && f.view.w >= MIN_VIEW_W);
  assert.equal(BW, 30);
  assert.equal(BH, 36);
});

test("resizing back and forth is stable (same size, same layout) and never degenerates", () => {
  const sizes: Array<[number, number]> = [[890, 574], [504, 286], [1444, 886], [890, 574], [300, 200], [890, 574]];
  const first = fitView(890, 574);
  for (const [w, h] of sizes) {
    const f = fitView(w, h);
    assert.ok(f.view.w >= MIN_VIEW_W && f.view.h > 0);
    assert.ok(columnsFor(f.view.w) >= 1);
  }
  assert.deepEqual(fitView(890, 574), first);
  assert.equal(layout(40, columnsFor(first.view.w), first.view.w).length, 40);
  assert.ok(TOPY > 0 && ROW > BH);
});

test("the original 288x176 view still lays out exactly as before", () => {
  assert.equal(columnsFor(288), 8);
  assert.equal(rows(10, 8, 176), 3);
  assert.equal(layout(2, 8, 288).length, 2);
});
