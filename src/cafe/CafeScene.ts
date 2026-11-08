// PixiJS café scene controller. It lives outside React: React creates and destroys it once and pushes the
// projected SceneState (domain/scene.ts) into it; the scene animates by itself from there (ADR-0010).
//
// Rendering regimes (measured in Phase 2, docs/measurements/phase2/README.md):
//  - There is NO requestAnimationFrame loop and Pixi's tickers stay stopped: any rAF loop costs ~1.7% CPU
//    at every frame cap. All animation is driven by one timer whose interval depends on what is on screen:
//      walking .......... 66 ms   (characters move between desk, board and table)
//      working poses .... 220 ms  (typing, writing, waving, celebrating …)
//      pure idle ........ 500 ms  (breathing, sipping tea)
//  - A frame is drawn only when the timer fires; nothing is scheduled while the window is minimised/hidden.
import "pixi.js/unsafe-eval"; // CSP-safe shader/uniform sync (no `new Function`)
import { Application, Sprite, Texture, Ticker } from "pixi.js";
import type { BoardState, BubbleKind, SceneState, Spot } from "../domain/scene.ts";
import { IDLE_SCENE } from "../domain/scene.ts";
import type { WelcomeStep } from "../domain/welcome.ts";
import { BOARD_SLOT, FLAMES, H, MONITOR, SPOTS, STEAM, W, buildBackground, buildFlame, buildForeground, buildMonitorFrame, buildSteam } from "./world.ts";
import { bubbleSize, placeBubble, type Placement, type Rect } from "../domain/bubble.ts";
import { CHAR_H, CHAR_W, buildBubble, buildSpeech, buildCharacter, buildTicket, type CharacterSprites, type FrameSet, type Who } from "./sprites.ts";
import type { Pen } from "./pixel.ts";

export const SCENE_W = W;
export const SCENE_H = H;

const WALK_MS = 66;
const WORK_MS = 220;
const IDLE_MS = 500;
const WALK_PX = 3;

const WORKING_POSES = new Set(["writing", "typing", "reading", "attention", "celebrate", "cheer", "error", "present", "thinking", "ready"]);

interface Pt {
  x: number;
  y: number;
}

interface Actor {
  who: Who;
  art: CharacterSprites;
  sprite: Sprite;
  bubble: Sprite;
  pos: Pt;
  spot: Spot;
  route: Pt[];
  facing: 1 | -1;
  walkDir: "side" | "front";
  pose: string;
  bubbleKind: BubbleKind;
  target: { pose: string; spot: Spot; bubble: BubbleKind };
}

export interface SceneDiagnostics {
  renderer: string;
  gpuVendor: string;
  gpuRenderer: string;
  framesTicked: number;
  framesRendered: number;
  timerActive: boolean;
  sharedTicker: { started: boolean; listeners: number };
  systemTicker: { started: boolean; listeners: number };
}

function tex(pen: Pen): Texture {
  const t = Texture.from(pen.canvas);
  t.source.scaleMode = "nearest";
  return t;
}
const texs = (set: FrameSet): Texture[] => set.map(tex);

export class CafeScene {
  private readonly app = new Application();
  private destroyed = false;
  private initialised = false;
  private paused = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tickCount = 0;
  private rendered = 0;
  private lastRenderedKey = "";
  private state: SceneState = IDLE_SCENE;

  private actors: Record<Who, Actor> | null = null;
  private charTex = new Map<string, Texture[]>();
  private bubbleTex = new Map<string, Texture[]>();
  private ticketTex = new Map<string, Texture[]>();
  private ticket: Sprite | null = null;
  private board: BoardState = "empty";
  private flameSprites: Sprite[] = [];
  private flameTex: Texture[] = [];
  private steamSprite: Sprite | null = null;
  private steamTex: Texture[] = [];
  private monitor: Sprite | null = null;
  private speechSprite: Sprite | null = null;
  private speech: { who: Who; tex: Texture; at: Placement; alpha: number } | null = null;
  private speechTimers: ReturnType<typeof setTimeout>[] = [];
  private monitorTex: Texture[] = [];

  async init(host: HTMLElement): Promise<void> {
    await this.app.init({
      width: W,
      height: H,
      resolution: 1,
      antialias: false,
      roundPixels: true,
      backgroundAlpha: 0,
      preference: "webgl",
      powerPreference: "low-power",
      autoStart: false,
      sharedTicker: true,
    });
    if (this.destroyed) {
      this.app.destroy(true);
      return;
    }
    // Render on demand only: remove Pixi's render-every-tick listener and keep both tickers stopped.
    this.app.ticker.remove(this.app.render, this.app);
    this.app.ticker.stop();
    Ticker.system.stop();

    const canvas = this.app.canvas;
    canvas.style.imageRendering = "pixelated";
    canvas.style.display = "block";
    canvas.setAttribute("aria-label", "Pixel-art café showing what the Reasoner and Executor are doing");
    canvas.setAttribute("role", "img");
    host.appendChild(canvas);

    this.build();
    this.initialised = true;
    this.paint();
    this.schedule();
  }

  private build(): void {
    const stage = this.app.stage;
    const add = (t: Texture, x: number, y: number): Sprite => {
      const s = new Sprite(t);
      s.position.set(x, y);
      stage.addChild(s);
      return s;
    };
    add(tex(buildBackground()), 0, 0);

    this.flameTex = texs([buildFlame(0), buildFlame(1)]);
    this.flameSprites = FLAMES.map((f) => add(this.flameTex[0] as Texture, f.x, f.y));
    this.steamTex = texs([buildSteam(0), buildSteam(1)]);
    const st = STEAM[0] as { x: number; y: number };
    this.steamSprite = add(this.steamTex[0] as Texture, st.x, st.y);

    const states: BoardState[] = ["empty", "drafting", "pending", "approved", "active", "done", "failed", "cancelled"];
    for (const b of states) this.ticketTex.set(b, texs(buildTicket(b)));
    this.ticket = add(this.ticketTex.get("empty")?.[0] as Texture, BOARD_SLOT.x, BOARD_SLOT.y);

    const bubbles: Array<Exclude<BubbleKind, "none">> = ["dots", "pencil", "alert", "check", "cross", "gear"];
    for (const b of bubbles) this.bubbleTex.set(b, texs(buildBubble(b)));

    const make = (who: Who): Actor => {
      const art = buildCharacter(who);
      for (const [name, frames] of Object.entries(art.poses)) this.charTex.set(`${who}:${name}`, texs(frames));
      this.charTex.set(`${who}:walkFront`, texs(art.walkFront));
      this.charTex.set(`${who}:walkSide`, texs(art.walkSide));
      const home = SPOTS[who].lounge;
      const sprite = add(this.charTex.get(`${who}:idle`)?.[0] as Texture, home.x - CHAR_W / 2, home.y - CHAR_H);
      return {
        who,
        art,
        sprite,
        bubble: new Sprite(),
        pos: { ...home },
        spot: "lounge",
        route: [],
        facing: 1,
        walkDir: "front",
        pose: "idle",
        bubbleKind: "none",
        target: { pose: "idle", spot: "lounge", bubble: "none" },
      };
    };
    const reasoner = make("reasoner");
    const executor = make("executor");
    this.actors = { reasoner, executor };

    add(tex(buildForeground()), 0, 0);
    this.monitorTex = texs([buildMonitorFrame("off"), buildMonitorFrame("a"), buildMonitorFrame("b")]);
    this.monitor = add(this.monitorTex[0] as Texture, MONITOR.x, MONITOR.y);
    for (const a of [reasoner, executor]) {
      a.bubble.visible = false;
      stage.addChild(a.bubble);
    }
    this.speechSprite = new Sprite();
    this.speechSprite.visible = false;
    stage.addChild(this.speechSprite);
  }

  /** Called whenever the projected real state changes. */
  setState(s: SceneState): void {
    this.state = s;
    if (!this.actors) return;
    if (s !== IDLE_SCENE && s.board !== "empty") this.stopSpeech(); // real work always wins over small talk
    for (const who of ["reasoner", "executor"] as const) {
      const a = this.actors[who];
      const want = s[who];
      a.target = { pose: want.pose, spot: want.spot, bubble: want.bubble };
      if (want.spot !== a.spot) this.planRoute(a, want.spot);
      else if (a.route.length === 0) {
        a.pose = want.pose;
        a.bubbleKind = want.bubble;
      }
    }
    this.board = s.board;
    this.paint();
    this.schedule();
  }

  private planRoute(a: Actor, spot: Spot): void {
    const dest = SPOTS[a.who][spot];
    const route: Pt[] = [];
    const corridor = SPOTS.corridorY;
    if (a.pos.y > corridor + 1) route.push({ x: a.pos.x, y: corridor });
    else if (a.pos.y < corridor - 1 && a.pos.x !== dest.x) route.push({ x: a.pos.x, y: corridor });
    route.push({ x: dest.x, y: corridor });
    route.push({ x: dest.x, y: dest.y });
    a.route = route;
    a.spot = spot;
    a.bubbleKind = "none";
  }

  /**
   * Plays welcome dialogue one small speech bubble at a time. It is ambient only: it never changes poses, is dropped
   * as soon as a real task shows up on the board, and does nothing while the window is paused. Each bubble fades in
   * and out in two steps (no continuous animation).
   */
  welcome(steps: WelcomeStep[]): void {
    this.stopSpeech();
    let at = 600;
    for (const st of steps) {
      const show = at;
      this.speechTimers.push(
        setTimeout(() => {
          if (this.destroyed || !this.actors) return;
          const speaker = this.actors[st.who];
          const other = this.actors[st.who === "reasoner" ? "executor" : "reasoner"];
          const size = bubbleSize(st.text);
          const avoid: Rect[] = [{ x: other.pos.x - CHAR_W / 2 - 1, y: other.pos.y - CHAR_H - 1, w: CHAR_W + 2, h: CHAR_H + 2 }, { x: 108, y: 2, w: 72, h: 42 }];
          const place = placeBubble({ speaker: speaker.pos, size, scene: { w: SCENE_W, h: SCENE_H }, char: { w: CHAR_W, h: CHAR_H }, avoid });
          const tex = Texture.from(buildSpeech(size, place.tailX).canvas);
          tex.source.scaleMode = "nearest";
          this.speech = { who: st.who, tex, at: place, alpha: 0.5 };
          this.redraw();
        }, show),
        setTimeout(() => {
          if (this.speech) this.speech.alpha = 1;
          this.redraw();
        }, show + 110),
      );
      at += st.ms;
      this.speechTimers.push(
        setTimeout(() => {
          if (this.speech) this.speech.alpha = 0.5;
          this.redraw();
        }, at),
        setTimeout(() => {
          this.speech = null;
          this.redraw();
        }, at + 110),
      );
      at += 450;
    }
  }

  private redraw(): void {
    if (!this.destroyed && !this.paused && this.initialised) this.paint();
  }

  private stopSpeech(): void {
    this.speechTimers.forEach(clearTimeout);
    this.speechTimers = [];
    if (this.speech) {
      this.speech = null;
      this.redraw();
    }
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) this.clearTimer();
    else {
      this.paint();
      this.schedule();
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private interval(): number {
    if (!this.actors) return IDLE_MS;
    const { reasoner, executor } = this.actors;
    if (reasoner.route.length || executor.route.length) return WALK_MS;
    const busy = WORKING_POSES.has(reasoner.pose) || WORKING_POSES.has(executor.pose) || this.board === "active";
    return busy ? WORK_MS : IDLE_MS;
  }

  private schedule(): void {
    this.clearTimer();
    if (this.destroyed || this.paused || !this.initialised) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.step();
      this.schedule();
    }, this.interval());
  }

  private step(): void {
    this.tickCount++;
    if (!this.actors) return;
    for (const a of Object.values(this.actors)) {
      const next = a.route[0];
      if (!next) continue;
      const dx = next.x - a.pos.x;
      const dy = next.y - a.pos.y;
      const dist = Math.abs(dx) + Math.abs(dy);
      if (dist <= WALK_PX) {
        a.pos = { ...next };
        a.route.shift();
        if (a.route.length === 0) {
          a.pose = a.target.pose;
          a.bubbleKind = a.target.bubble;
        }
      } else if (Math.abs(dx) > 0) {
        a.pos.x += Math.sign(dx) * WALK_PX;
        a.facing = dx > 0 ? 1 : -1;
        a.walkDir = "side";
      } else {
        a.pos.y += Math.sign(dy) * WALK_PX;
        a.walkDir = "front";
      }
    }
    this.paint();
  }

  /** Applies the current logical state to the sprites and draws one frame. */
  private paint(): void {
    if (!this.actors || this.destroyed || !this.initialised) return;
    const t = this.tickCount;
    for (const a of Object.values(this.actors)) {
      const walking = a.route.length > 0;
      let frames: Texture[] | undefined;
      let frame: number;
      if (walking) {
        frames = this.charTex.get(`${a.who}:${a.walkDir === "side" ? "walkSide" : "walkFront"}`);
        frame = t % 4;
      } else {
        frames = this.charTex.get(`${a.who}:${a.pose}`);
        frame = frames ? t % frames.length : 0;
      }
      if (frames) a.sprite.texture = frames[frame] as Texture;
      const flip = walking && a.walkDir === "side" && a.facing === -1;
      const jump = !walking && (a.pose === "celebrate" || a.pose === "cheer") && frame === 1 ? -3 : 0;
      a.sprite.scale.x = flip ? -1 : 1;
      a.sprite.position.set(Math.round(a.pos.x - CHAR_W / 2 + (flip ? CHAR_W : 0)), Math.round(a.pos.y - CHAR_H + jump));

      const kind = walking ? "none" : a.bubbleKind;
      const bt = kind === "none" ? undefined : this.bubbleTex.get(kind);
      a.bubble.visible = !!bt;
      if (bt) {
        a.bubble.texture = bt[t % bt.length] as Texture;
        a.bubble.position.set(Math.round(a.pos.x + 3), Math.round(a.pos.y - CHAR_H - 10 + jump));
      }
    }
    if (this.speechSprite) {
      const sp = this.speech;
      const a = sp ? this.actors[sp.who] : null;
      const show = !!sp && !!a && a.route.length === 0 && a.spot === "lounge" && a.bubbleKind === "none";
      this.speechSprite.visible = show;
      if (show && sp) {
        this.speechSprite.texture = sp.tex;
        this.speechSprite.alpha = sp.alpha;
        this.speechSprite.position.set(sp.at.x, sp.at.y);
      }
    }
    if (this.ticket) {
      const set = this.ticketTex.get(this.board);
      if (set) this.ticket.texture = set[t % set.length] as Texture;
    }
    this.flameSprites.forEach((s, i) => {
      s.texture = this.flameTex[(t + i) % 2] as Texture;
    });
    if (this.steamSprite) this.steamSprite.texture = this.steamTex[t % 2] as Texture;
    if (this.monitor) {
      const exec = this.actors.executor;
      const live = exec.spot === "desk" && !exec.route.length && (exec.pose === "typing" || exec.pose === "reading" || exec.pose === "writing" || exec.pose === "thinking");
      this.monitor.texture = this.monitorTex[live ? 1 + (t % 2) : exec.pose === "ready" ? 1 : 0] as Texture;
    }
    // Skip the GPU draw when nothing visible changed since the last frame.
    const key = this.frameKey();
    if (key === this.lastRenderedKey) return;
    this.lastRenderedKey = key;
    this.app.render();
    this.rendered++;
  }

  private frameKey(): string {
    if (!this.actors) return "";
    const parts: Array<string | number> = [this.board, this.ticket?.texture.uid ?? 0, this.steamSprite?.texture.uid ?? 0, this.flameSprites[0]?.texture.uid ?? 0, this.monitor?.texture.uid ?? 0, this.speechSprite?.visible ? this.speechSprite.texture.uid : 0, this.speechSprite?.x ?? 0, this.speechSprite?.alpha ?? 1];
    for (const a of Object.values(this.actors)) parts.push(a.sprite.texture.uid, a.sprite.x, a.sprite.y, a.sprite.scale.x, a.bubble.visible ? a.bubble.texture.uid : 0, a.bubble.y);
    return parts.join("|");
  }

  currentState(): SceneState {
    return this.state;
  }

  diagnostics(): SceneDiagnostics {
    const gl = (this.app.renderer as unknown as { gl?: WebGL2RenderingContext }).gl;
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return {
      renderer: this.app.renderer.name,
      gpuVendor: ext && gl ? String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)) : "unknown",
      gpuRenderer: ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "unknown",
      framesTicked: this.tickCount,
      framesRendered: this.rendered,
      timerActive: this.timer !== null,
      sharedTicker: { started: Ticker.shared.started, listeners: Ticker.shared.count },
      systemTicker: { started: Ticker.system.started, listeners: Ticker.system.count },
    };
  }

  destroy(): void {
    this.destroyed = true;
    this.clearTimer();
    this.speechTimers.forEach(clearTimeout);
    if (this.initialised) {
      this.app.ticker.stop();
      Ticker.system.stop();
      this.app.destroy(true, { children: true, texture: true });
    }
  }
}
