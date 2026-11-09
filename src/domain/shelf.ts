// Geometry and styling of the bookshelf, kept pure so navigation and hit-testing are testable without a canvas.
// Content space: x 0..SHELF_W, y grows downward with the number of rows; the view shows SHELF_H pixels of it.

export const SHELF_W = 288;
export const SHELF_H = 176;
export const BOOK_W = 30;
export const BOOK_H = 36;
export const BOOK_GAP = 4;
export const MARGIN_X = 10;
export const TOP = 22; // room for the "LIBRARY" sign
export const ROW_H = 50; // book + board + breathing space
export const COLS = Math.floor((SHELF_W - MARGIN_X * 2 + BOOK_GAP) / (BOOK_W + BOOK_GAP));
/** Smallest view the shelf lays out (one column of books). */
export const MIN_VIEW_W = BOOK_W + MARGIN_X * 2;
export const MIN_VIEW_H = 96;

export interface BookRect {
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The shelf is laid out for whatever view size it is given (logical pixels, not the original window size): the number of
 * columns follows the width, rows follow the number of books, and the board rows always fill at least the view height.
 * Every function defaults to the original 288x176 view so older callers and tests keep working.
 */
export interface View {
  w: number;
  h: number;
}

export const DEFAULT_VIEW: View = { w: SHELF_W, h: SHELF_H };

export function clampView(v: View): View {
  return { w: Math.max(MIN_VIEW_W, Math.floor(v.w)), h: Math.max(MIN_VIEW_H, Math.floor(v.h)) };
}

export function columnsFor(viewW: number = SHELF_W): number {
  return Math.max(1, Math.floor((viewW - MARGIN_X * 2 + BOOK_GAP) / (BOOK_W + BOOK_GAP)));
}

export function layoutBooks(count: number, cols: number = COLS, viewW: number = SHELF_W): BookRect[] {
  const free = viewW - MARGIN_X * 2 - (cols * BOOK_W + (cols - 1) * BOOK_GAP);
  const start = MARGIN_X + Math.max(0, Math.floor(free / 2));
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    x: start + (i % cols) * (BOOK_W + BOOK_GAP),
    y: TOP + Math.floor(i / cols) * ROW_H + (ROW_H - 6 - BOOK_H),
    w: BOOK_W,
    h: BOOK_H,
  }));
}

export const rowCount = (count: number, cols: number = COLS, viewH: number = SHELF_H): number => Math.max(Math.ceil(count / cols), Math.ceil((viewH - TOP - 6) / ROW_H), 1);
export const contentHeight = (count: number, cols: number = COLS, viewH: number = SHELF_H): number => TOP + rowCount(count, cols, viewH) * ROW_H + 6;
export const maxScroll = (count: number, cols: number = COLS, viewH: number = SHELF_H): number => Math.max(0, contentHeight(count, cols, viewH) - viewH);
export const clampScroll = (scroll: number, count: number, cols: number = COLS, viewH: number = SHELF_H): number => Math.min(maxScroll(count, cols, viewH), Math.max(0, Math.round(scroll)));

/** Which book is under the pointer? x and y are scene coordinates (0..view.w, 0..view.h). */
export function hitTest(rects: BookRect[], x: number, y: number, scroll: number): number {
  const cy = y + scroll;
  const hit = rects.find((r) => x >= r.x && x < r.x + r.w && cy >= r.y - 2 && cy < r.y + r.h);
  return hit ? hit.index : -1;
}

/** Scroll position that brings a book fully into view (keyboard navigation). */
export function scrollToShow(rect: BookRect, scroll: number, count: number, cols: number = COLS, viewH: number = SHELF_H): number {
  if (rect.y - 8 < scroll) return clampScroll(rect.y - 8, count, cols, viewH);
  if (rect.y + rect.h + 12 > scroll + viewH) return clampScroll(rect.y + rect.h + 12 - viewH, count, cols, viewH);
  return scroll;
}

/** Keyboard navigation between books: arrows move in the grid; returns the new index (or the same one at an edge). */
export function neighbour(index: number, key: "left" | "right" | "up" | "down", count: number, cols: number = COLS): number {
  if (count === 0) return -1;
  const i = index < 0 ? 0 : index;
  const next = key === "left" ? i - 1 : key === "right" ? i + 1 : key === "up" ? i - cols : i + cols;
  return next < 0 || next >= count ? i : next;
}

/**
 * CSS scale for the view and the logical view size that exactly fills a container. Larger windows get bigger books
 * (up to 3x) and, beyond that, more columns; smaller windows get fewer columns, never clipped books.
 */
export function fitView(cssW: number, cssH: number): { scale: number; view: View } {
  const scale = Math.min(3, Math.max(1, Math.floor((cssW / SHELF_W) * 4) / 4));
  return { scale, view: clampView({ w: cssW / scale, h: cssH / scale }) };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const COVERS: Array<[string, string, string]> = [
  ["#8a2f35", "#5e1f26", "#e0b04a"],
  ["#2f6f9a", "#1f4a69", "#f5e6c4"],
  ["#3f8f4a", "#2a6234", "#f0d070"],
  ["#6f4bb2", "#4a3280", "#f0b93a"],
  ["#b9742c", "#7e4d1c", "#f5e6c4"],
  ["#2f9a98", "#1f6e72", "#f5e6c4"],
  ["#7a5a3a", "#523a22", "#e0b04a"],
  ["#a8413a", "#7a2b27", "#f5e6c4"],
];

/** Same path, same look, on every launch. CLAUDE.md always gets the golden constitution cover. */
export function bookLook(path: string): { cover: string; edge: string; band: string; golden: boolean } {
  if (path === "CLAUDE.md") return { cover: "#1d2f55", edge: "#101c36", band: "#f0b93a", golden: true };
  const c = COVERS[hash(path) % COVERS.length] ?? COVERS[0] ?? ["#8a2f35", "#5e1f26", "#e0b04a"];
  return { cover: c[0], edge: c[1], band: c[2], golden: false };
}

/** Title for the 3x5 pixel font: at most 3 lines of 6 letters. */
export function labelLines(title: string): string[] {
  const words = title.toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    let rest = w;
    while (rest.length > 6) {
      if (line) {
        lines.push(line);
        line = "";
      }
      lines.push(rest.slice(0, 6));
      rest = rest.slice(6);
    }
    if (!line) line = rest;
    else if (line.length + 1 + rest.length <= 6) line += ` ${rest}`;
    else {
      lines.push(line);
      line = rest;
    }
  }
  if (line) lines.push(line);
  if (lines.length > 3) {
    const kept = lines.slice(0, 3);
    kept[2] = `${(kept[2] ?? "").slice(0, 5)}.`;
    return kept;
  }
  return lines.length ? lines : ["DOC"];
}
