// The Library bookshelf: a second small PixiJS scene (created only while the Library tab is open). Every document
// is its own sprite, hit-tested with the pure geometry in domain/shelf.ts. There is no ticker and no animation
// loop: the scene draws once per hover, selection or scroll change, so an idle library costs nothing.
import "pixi.js/unsafe-eval";
import { Application, Container, Sprite, Texture, Ticker } from "pixi.js";
import { BOOK_H, BOOK_W, DEFAULT_VIEW, TOP, ROW_H, bookLook, clampScroll, clampView, columnsFor, hitTest, labelLines, layoutBooks, rowCount, scrollToShow, type BookRect, type View } from "../domain/shelf.ts";
import type { LibraryMeta } from "../domain/types.ts";
import { C, drawText, newPen, type Pen } from "./pixel.ts";

const tex = (pen: Pen): Texture => {
  const t = Texture.from(pen.canvas);
  t.source.scaleMode = "nearest";
  return t;
};

function wallTexture(w: number, h: number): Texture {
  const p = newPen(w, h);
  p.r(0, 0, w, h, "#5a3a24");
  for (let y = 0; y < h; y += 6) for (let x = (y % 12) * 2; x < w; x += 24) p.r(x, y, 11, 1, "#4a2e1c");
  for (const x of [0, w - 8]) {
    p.r(x, 0, 8, h, C.beam);
    p.r(x + (x === 0 ? 6 : 0), 0, 2, h, C.ink2);
    p.r(x + (x === 0 ? 1 : 3), 0, 1, h, C.beamHi);
  }
  return tex(p);
}

function boardTexture(w: number): Texture {
  const p = newPen(w, 8);
  p.r(0, 0, w, 8, C.beam2);
  p.r(0, 0, w, 1, C.beamHi);
  p.r(0, 5, w, 3, C.wainDk);
  p.r(0, 6, w, 1, C.ink2);
  for (let x = 12; x < w; x += 37) p.r(x, 2, 9, 1, C.wain);
  return tex(p);
}

function signTexture(): Texture {
  const p = newPen(84, 16);
  p.r(0, 0, 84, 16, C.ink);
  p.r(1, 1, 82, 14, C.beam2);
  p.r(2, 2, 80, 12, C.wain);
  p.r(2, 2, 80, 1, C.beamHi);
  drawText(p, 25, 5, "LIBRARY", C.gold, 1);
  p.p(8, 8, C.gold);
  p.p(75, 8, C.gold);
  return tex(p);
}

function outlineTexture(color: string): Texture {
  const p = newPen(BOOK_W + 4, BOOK_H + 4);
  p.r(0, 0, BOOK_W + 4, 2, color);
  p.r(0, BOOK_H + 2, BOOK_W + 4, 2, color);
  p.r(0, 0, 2, BOOK_H + 4, color);
  p.r(BOOK_W + 2, 0, 2, BOOK_H + 4, color);
  return tex(p);
}

export function bookTexture(path: string, title: string): Texture {
  const look = bookLook(path);
  const p = newPen(BOOK_W, BOOK_H);
  p.r(0, 0, BOOK_W, BOOK_H, look.cover);
  p.r(0, 0, 4, BOOK_H, look.edge); // spine
  p.r(4, 0, 1, BOOK_H, C.ink);
  p.r(0, 0, BOOK_W, 1, C.ink);
  p.r(0, BOOK_H - 1, BOOK_W, 1, C.ink);
  p.r(BOOK_W - 1, 0, 1, BOOK_H, C.ink);
  p.a(5, 1, BOOK_W - 6, 1, C.white, 0.35);
  p.r(5, 4, BOOK_W - 6, 2, look.band);
  p.r(5, BOOK_H - 7, BOOK_W - 6, 2, look.band);
  if (look.golden) {
    p.r(BOOK_W - 8, 8, 3, 3, look.band);
    p.r(BOOK_W - 9, 9, 5, 1, look.band);
  }
  const lines = labelLines(title);
  const h = lines.length * 6 + 3;
  const y = 9 + Math.floor((BOOK_H - 9 - 9 - h) / 2) + 1;
  p.r(6, y, BOOK_W - 8, h, C.cream);
  p.r(6, y + h - 1, BOOK_W - 8, 1, C.cream2);
  lines.forEach((l, i) => drawText(p, 8, y + 2 + i * 6, l, C.ink2, 1));
  return tex(p);
}

export class LibraryScene {
  private readonly app = new Application();
  private initialised = false;
  private destroyed = false;
  private content = new Container();
  private docs: LibraryMeta[] = [];
  private rects: BookRect[] = [];
  private sprites: Sprite[] = [];
  private hover = -1;
  private selected = -1;
  private scroll = 0;
  private view: View = DEFAULT_VIEW;
  private cols = columnsFor(DEFAULT_VIEW.w);
  private wall: Sprite | null = null;
  private sign: Sprite | null = null;
  private bookTextures = new Map<string, Texture>();
  private boardTex: Texture | null = null;
  private onLostCb: () => void = () => undefined;
  private hoverBox: Sprite | null = null;
  private selectBox: Sprite | null = null;
  private onHoverCb: (index: number) => void = () => undefined;
  private onSelectCb: (index: number) => void = () => undefined;

  onHover(cb: (index: number) => void): void {
    this.onHoverCb = cb;
  }
  onSelect(cb: (index: number) => void): void {
    this.onSelectCb = cb;
  }

  /** Called when the graphics context is lost and not restored, so the UI can offer a retry. */
  onLost(cb: () => void): void {
    this.onLostCb = cb;
  }

  async init(host: HTMLElement, view: View = DEFAULT_VIEW): Promise<void> {
    if (this.initialised) return;
    this.view = clampView(view);
    this.cols = columnsFor(this.view.w);
    await this.app.init({ width: this.view.w, height: this.view.h, resolution: 1, antialias: false, roundPixels: true, backgroundAlpha: 0, preference: "webgl", powerPreference: "low-power", autoStart: false, sharedTicker: true });
    if (this.destroyed) {
      this.app.destroy(true);
      return;
    }
    this.app.ticker.remove(this.app.render, this.app);
    this.app.ticker.stop();
    Ticker.system.stop();
    const c = this.app.canvas;
    c.style.imageRendering = "pixelated";
    c.style.display = "block";
    c.setAttribute("role", "img");
    c.setAttribute("aria-label", "Bookshelf with one book per documentation file");
    host.appendChild(c);
    this.wall = new Sprite(wallTexture(this.view.w, this.view.h));
    this.sign = new Sprite(signTexture());
    this.sign.position.set((this.view.w - 84) >> 1, 3);
    this.app.stage.addChild(this.wall, this.content, this.sign);
    c.addEventListener("webglcontextlost", this.onContextLost);
    c.addEventListener("webglcontextrestored", this.onContextRestored);
    c.addEventListener("pointermove", this.onMove);
    c.addEventListener("pointerleave", this.onLeave);
    c.addEventListener("click", this.onClick);
    c.addEventListener("wheel", this.onWheel, { passive: false });
    this.initialised = true;
    this.rebuild();
  }

  private point(ev: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.app.canvas.getBoundingClientRect();
    return { x: ((ev.clientX - r.left) * this.view.w) / Math.max(1, r.width), y: ((ev.clientY - r.top) * this.view.h) / Math.max(1, r.height) };
  }
  private readonly onMove = (ev: PointerEvent): void => {
    const p = this.point(ev);
    const i = hitTest(this.rects, p.x, p.y, this.scroll);
    if (i !== this.hover) {
      this.hover = i;
      this.app.canvas.style.cursor = i >= 0 ? "pointer" : "default";
      this.onHoverCb(i);
      this.draw();
    }
  };
  private readonly onLeave = (): void => {
    if (this.hover !== -1) {
      this.hover = -1;
      this.onHoverCb(-1);
      this.draw();
    }
  };
  private readonly onClick = (ev: MouseEvent): void => {
    const p = this.point(ev);
    const i = hitTest(this.rects, p.x, p.y, this.scroll);
    if (i >= 0) this.onSelectCb(i);
  };
  private readonly onWheel = (ev: WheelEvent): void => {
    if (this.docs.length === 0) return;
    ev.preventDefault();
    this.setScroll(this.scroll + Math.sign(ev.deltaY) * 24);
  };

  private rebuild(): void {
    if (!this.initialised) return;
    this.content.removeChildren().forEach((c) => c.destroy());
    this.sprites = [];
    this.rects = layoutBooks(this.docs.length, this.cols, this.view.w);
    this.boardTex ??= boardTexture(this.view.w);
    const board = this.boardTex;
    for (let r = 0; r < rowCount(this.docs.length, this.cols, this.view.h); r++) {
      const b = new Sprite(board);
      b.position.set(0, TOP + r * ROW_H + ROW_H - 8);
      this.content.addChild(b);
    }
    this.docs.forEach((d, i) => {
      const key = `${d.path}\u0000${d.title}`;
      let bt = this.bookTextures.get(key);
      if (!bt) {
        bt = bookTexture(d.path, d.title);
        this.bookTextures.set(key, bt);
      }
      const s = new Sprite(bt);
      const r = this.rects[i];
      if (r) s.position.set(r.x, r.y);
      this.sprites.push(s);
      this.content.addChild(s);
    });
    this.hoverBox = new Sprite(outlineTexture("#f5e6c4"));
    this.selectBox = new Sprite(outlineTexture("#f0b93a"));
    this.hoverBox.visible = this.selectBox.visible = false;
    this.content.addChild(this.hoverBox, this.selectBox);
    this.scroll = clampScroll(this.scroll, this.docs.length, this.cols, this.view.h);
    this.draw();
  }

  /**
   * Adapts the shelf to a new view size (logical pixels). Only the wall and the row layout are recomputed: the Pixi application,
   * the canvas and every book texture are kept, so resizing a window never recreates the scene.
   */
  resize(next: View): void {
    const v = clampView(next);
    if (v.w === this.view.w && v.h === this.view.h) return;
    const widthChanged = v.w !== this.view.w;
    this.view = v;
    this.cols = columnsFor(v.w);
    if (!this.initialised || this.destroyed) return;
    this.app.renderer.resize(v.w, v.h);
    if (this.wall) {
      this.wall.texture.destroy(true);
      this.wall.texture = wallTexture(v.w, v.h);
    }
    if (this.sign) this.sign.position.set((v.w - 84) >> 1, 3);
    if (widthChanged) {
      this.boardTex?.destroy(true);
      this.boardTex = null;
    }
    const keep = this.selected >= 0 ? this.docs[this.selected]?.path ?? null : null;
    this.rebuild();
    if (keep) this.setSelectedIndex(this.selected);
  }

  /** Draws again even if nothing changed (restored from minimise, context restored). */
  refresh(): void {
    this.draw();
  }

  private readonly onContextLost = (ev: Event): void => {
    ev.preventDefault();
    this.lostTimer ??= setTimeout(() => {
      this.lostTimer = null;
      this.onLostCb();
    }, 2500);
  };
  private lostTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onContextRestored = (): void => {
    if (this.lostTimer !== null) clearTimeout(this.lostTimer);
    this.lostTimer = null;
    this.draw();
  };

  /** Replaces the shelf contents (switching repository, or Refresh). */
  setDocs(docs: LibraryMeta[], selectedPath: string | null): void {
    this.docs = docs;
    this.selected = selectedPath ? docs.findIndex((d) => d.path === selectedPath) : -1;
    this.hover = -1;
    this.rebuild();
  }

  setSelectedIndex(index: number): void {
    this.selected = index;
    const r = this.rects[index];
    if (r) this.scroll = scrollToShow(r, this.scroll, this.docs.length, this.cols, this.view.h);
    this.draw();
  }

  private setScroll(y: number): void {
    const next = clampScroll(y, this.docs.length, this.cols, this.view.h);
    if (next !== this.scroll) {
      this.scroll = next;
      this.draw();
    }
  }

  private draw(): void {
    if (!this.initialised || this.destroyed) return;
    this.content.y = -this.scroll;
    this.sprites.forEach((s, i) => {
      const r = this.rects[i];
      if (r) s.y = r.y - (i === this.hover ? 2 : 0);
    });
    const place = (box: Sprite | null, i: number): void => {
      const r = this.rects[i];
      if (!box) return;
      box.visible = !!r;
      if (r) box.position.set(r.x - 2, r.y - 2 - (i === this.hover ? 2 : 0));
    };
    place(this.hoverBox, this.hover === this.selected ? -1 : this.hover);
    place(this.selectBox, this.selected);
    try {
      this.app.render();
    } catch (e) {
      console.error("[library renderer]", e);
    }
  }

  get columns(): number {
    return this.cols;
  }

  get viewSize(): View {
    return this.view;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.lostTimer !== null) clearTimeout(this.lostTimer);
    if (this.initialised) {
      const c = this.app.canvas;
      c.removeEventListener("webglcontextlost", this.onContextLost);
      c.removeEventListener("webglcontextrestored", this.onContextRestored);
      c.removeEventListener("pointermove", this.onMove);
      c.removeEventListener("pointerleave", this.onLeave);
      c.removeEventListener("click", this.onClick);
      c.removeEventListener("wheel", this.onWheel);
      this.app.destroy(true, { children: true, texture: true });
      for (const t of this.bookTextures.values()) {
        try {
          t.destroy(true);
        } catch {
          /* already released with the stage */
        }
      }
      this.bookTextures.clear();
    }
  }
}
