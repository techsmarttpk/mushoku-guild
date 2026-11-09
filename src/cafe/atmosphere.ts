// The café's atmosphere layer. It owns the sprites that make the four dayparts look different (outdoor scenery behind the
// windows, a shade wash, sun/moon beams, lamp glows) and cross-fades between dayparts. It never re-renders the scene by
// itself: the CafeScene timer calls `step()` and draws only when `key()` changed, so an idle café stays cheap.
import { Sprite, Texture } from "pixi.js";
import type { Container } from "pixi.js";
import { GRADES, mixColor, type Daypart } from "../domain/atmosphere.ts";
import { PHASES, buildGlow, buildLight, buildShade, buildSky } from "./atmo-art.ts";
import type { Pen } from "./pixel.ts";
import { FLAMES, WINDOWS } from "./world.ts";

const FADE_MS = 1400;
/** Timer ticks per sky phase (clouds drift, stars twinkle): about every 4 s at the idle cadence. */
const TICKS_PER_PHASE = 8;

function tex(pen: Pen): Texture {
  const t = Texture.from(pen.canvas);
  t.source.scaleMode = "nearest";
  return t;
}

/** A sprite pair: `older` (full alpha, underneath) and `newer` (fading in on top). */
interface Pair {
  older: Sprite;
  newer: Sprite;
}

export interface Tintable {
  room: Sprite[];
  actors: Sprite[];
}

export class AtmosphereLayer {
  private skies: Pair[] = [];
  private shade: Pair | null = null;
  private light: Pair | null = null;
  private glows: Sprite[] = [];
  private cache = new Map<string, Texture>();
  private glowTex: Texture | null = null;

  private theme: Daypart;
  private from: Daypart | null = null;
  private progress = 1;
  private phase = 0;
  private flicker = 0;
  private roomTint: number;
  private actorTint: number;
  private lamps: number;
  private fromRoom = 0;
  private fromActors = 0;
  private fromLamps = 0;

  constructor(initial: Daypart, private readonly targets: Tintable) {
    this.theme = initial;
    this.roomTint = GRADES[initial].room;
    this.actorTint = GRADES[initial].actors;
    this.lamps = GRADES[initial].lamps;
  }

  get current(): Daypart {
    return this.theme;
  }

  get transitioning(): boolean {
    return this.progress < 1;
  }

  /** Sky sprites go BELOW the background (the glass is transparent). */
  mountBelow(stage: Container): void {
    for (const win of WINDOWS) {
      const pair = { older: new Sprite(), newer: new Sprite() };
      for (const s of [pair.older, pair.newer]) {
        s.position.set(win.x, win.y);
        stage.addChild(s);
      }
      this.skies.push(pair);
    }
  }

  /** Shade, beams and lamp glows go ABOVE the furniture and characters but below speech bubbles. */
  mountAbove(stage: Container): void {
    const pair = (): Pair => {
      const p = { older: new Sprite(), newer: new Sprite() };
      stage.addChild(p.older, p.newer);
      return p;
    };
    this.light = pair();
    this.shade = pair();
    this.glowTex = tex(buildGlow());
    for (const f of FLAMES) {
      const g = new Sprite(this.glowTex);
      g.blendMode = "add";
      g.position.set(f.x + 2 - 20, f.y + 3 - 20);
      stage.addChild(g);
      this.glows.push(g);
    }
    this.assign("newer");
    this.applyColours();
  }

  private texture(kind: "sky0" | "sky1" | "shade" | "light", theme: Daypart, phase: number): Texture {
    const key = `${kind}:${theme}:${kind.startsWith("sky") ? phase : 0}`;
    let t = this.cache.get(key);
    if (!t) {
      const pen = kind === "sky0" ? buildSky(theme, 0, phase) : kind === "sky1" ? buildSky(theme, 1, phase) : kind === "shade" ? buildShade(theme) : buildLight(theme);
      t = pen ? tex(pen) : Texture.EMPTY;
      this.cache.set(key, t);
    }
    return t;
  }

  /** Puts the textures of `theme` (at the current phase) on one side of every pair. */
  private assign(side: "older" | "newer", theme: Daypart = this.theme): void {
    this.skies.forEach((p, i) => {
      p[side].texture = this.texture(i === 0 ? "sky0" : "sky1", theme, this.phase);
    });
    if (this.shade) this.shade[side].texture = this.texture("shade", theme, 0);
    if (this.light) this.light[side].texture = this.texture("light", theme, 0);
  }

  /** Switches to a daypart. `instant` skips the cross-fade (first paint, hidden window). Positions and animations are untouched. */
  setTheme(next: Daypart, instant: boolean): void {
    if (next === this.theme && this.progress >= 1) return;
    if (instant || this.skies.length === 0) {
      this.theme = next;
      this.from = null;
      this.progress = 1;
      this.roomTint = GRADES[next].room;
      this.actorTint = GRADES[next].actors;
      this.lamps = GRADES[next].lamps;
      if (this.skies.length) {
        this.assign("newer");
        this.hideOlder();
        this.applyColours();
      }
      return;
    }
    // whatever is showing right now becomes the "older" picture; the new daypart fades in over it
    this.assign("older", this.theme);
    this.from = this.theme;
    this.fromRoom = this.roomTint;
    this.fromActors = this.actorTint;
    this.fromLamps = this.lamps;
    this.theme = next;
    this.progress = 0;
    this.assign("newer");
    this.applyColours();
  }

  private hideOlder(): void {
    for (const p of [...this.skies, this.shade, this.light]) if (p) p.older.visible = false;
  }

  /** One timer tick. Returns true when anything visible may have changed. */
  step(tick: number, dtMs: number): void {
    const phase = Math.floor(tick / TICKS_PER_PHASE) % PHASES;
    if (phase !== this.phase) {
      this.phase = phase;
      this.assign("newer");
      if (this.transitioning && this.from) this.assign("older", this.from);
    }
    this.flicker = tick % 3;
    if (this.transitioning) {
      this.progress = Math.min(1, this.progress + dtMs / FADE_MS);
      if (this.progress >= 1) {
        this.from = null;
        this.hideOlder();
      }
    }
    this.applyColours();
  }

  private applyColours(): void {
    const k = this.transitioning ? this.progress : 1;
    const to = GRADES[this.theme];
    const room = this.from ? mixColor(this.fromRoom, to.room, k) : to.room;
    const actors = this.from ? mixColor(this.fromActors, to.actors, k) : to.actors;
    const lamps = this.from ? this.fromLamps + (to.lamps - this.fromLamps) * k : to.lamps;
    this.roomTint = room;
    this.actorTint = actors;
    this.lamps = lamps;
    for (const s of this.targets.room) s.tint = room;
    for (const s of this.targets.actors) s.tint = actors;
    const fading = this.transitioning;
    for (const p of [...this.skies, this.shade, this.light]) {
      if (!p) continue;
      p.older.visible = fading;
      p.older.alpha = 1;
      p.newer.alpha = fading ? k : 1;
    }
    const glow = lamps * (this.flicker === 0 ? 0.8 : this.flicker === 1 ? 1 : 0.9);
    for (const g of this.glows) {
      g.alpha = glow;
      g.visible = glow > 0.02;
    }
  }

  /** Changes whenever a frame must be drawn (used by the scene's skip-identical-frames check). */
  key(): string {
    return `${this.theme}|${this.from ?? ""}|${this.progress.toFixed(2)}|${this.phase}|${this.flicker}`;
  }

}
