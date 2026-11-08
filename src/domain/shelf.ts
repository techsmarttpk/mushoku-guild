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

export interface BookRect {
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function layoutBooks(count: number): BookRect[] {
  const free = SHELF_W - MARGIN_X * 2 - (COLS * BOOK_W + (COLS - 1) * BOOK_GAP);
  const start = MARGIN_X + Math.floor(free / 2);
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    x: start + (i % COLS) * (BOOK_W + BOOK_GAP),
    y: TOP + Math.floor(i / COLS) * ROW_H + (ROW_H - 6 - BOOK_H),
    w: BOOK_W,
    h: BOOK_H,
  }));
}

export const rowCount = (count: number): number => Math.max(3, Math.ceil(count / COLS));
export const contentHeight = (count: number): number => TOP + rowCount(count) * ROW_H + 6;
export const maxScroll = (count: number): number => Math.max(0, contentHeight(count) - SHELF_H);
export const clampScroll = (scroll: number, count: number): number => Math.min(maxScroll(count), Math.max(0, Math.round(scroll)));

/** Which book is under the pointer? x and y are scene coordinates (0..SHELF_W, 0..SHELF_H). */
export function hitTest(rects: BookRect[], x: number, y: number, scroll: number): number {
  const cy = y + scroll;
  const hit = rects.find((r) => x >= r.x && x < r.x + r.w && cy >= r.y - 2 && cy < r.y + r.h);
  return hit ? hit.index : -1;
}

/** Scroll position that brings a book fully into view (keyboard navigation). */
export function scrollToShow(rect: BookRect, scroll: number, count: number): number {
  if (rect.y - 8 < scroll) return clampScroll(rect.y - 8, count);
  if (rect.y + rect.h + 12 > scroll + SHELF_H) return clampScroll(rect.y + rect.h + 12 - SHELF_H, count);
  return scroll;
}

/** Keyboard navigation between books: arrows move in the grid; returns the new index (or the same one at an edge). */
export function neighbour(index: number, key: "left" | "right" | "up" | "down", count: number): number {
  if (count === 0) return -1;
  const i = index < 0 ? 0 : index;
  const next = key === "left" ? i - 1 : key === "right" ? i + 1 : key === "up" ? i - COLS : i + COLS;
  return next < 0 || next >= count ? i : next;
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
