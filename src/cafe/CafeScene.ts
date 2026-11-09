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
import { Application, Container, Sprite, Texture, Ticker } from "pixi.js";
import type { BoardState, BubbleKind, SceneState, Spot } from "../domain/scene.ts";
import { IDLE_SCENE } from "../domain/scene.ts";
import type { WelcomeStep } from "../domain/welcome.ts";
import { BOARD_SLOT, FLAMES, H, MONITOR, SPOTS, STEAM, W, buildBackground, buildFlame, buildForeground, buildMonitorFrame, buildSteam } from "./world.ts";
import { bubbleSize, placeBubble, type Placement, type Rect } from "../domain/bubble.ts";
import { CHAR_H, CHAR_W, buildBubble, buildSpeech, buildCharacter, buildTicket, type CharacterSprites, type FrameSet, type Who } from "./sprites.ts";
import type { Pen } from "./pixel.ts";
import { AtmosphereLayer } from "./atmosphere.ts";
import { HEALTHY, RESTORE_WAIT_MS, nextHealth, type HealthEvent, type RenderHealth } from "../domain/renderHealth.ts";
import type { Daypart } from "../domain/atmosphere.ts";
import { lookFor, placeMembers, type MemberState, type Spot as GuildSpot } from "../domain/guild.ts";
import { MEMBER_H, MEMBER_W, buildDot, buildMember, buildNameplate } from "./memberSprites.ts";

export const SCENE_W = W;
export const SCENE_H = H;

const WALK_MS = 66;
const WORK_MS = 220;
const IDLE_MS = 500;
const WALK_PX = 3;
/** While two atmospheres cross-fade (about 1.4 s) the timer runs a little faster, then returns to the normal cadence. */
const FADE_MS_STEP = 90;

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

/** A recruited model as the scene needs it. */
export interface SceneMember {
  id: number;
  seed: number;
  name: string;
  vendor: string;
  state: MemberState;
}

/** Where a character was clicked, in scene pixels (the UI turns it into a popover position). */
export interface MemberPick {
  id: number;
  x: number;
  y: number;
  headY: number;
}

interface MemberActor {
  m: SceneMember;
  sprite: Sprite;
  dot: Sprite;
  frames: Texture[];
  phase: number;
  spot: GuildSpot;
}

export interface SceneDiagnostics {
  renderer: string;
  gpuVendor: string;
  gpuRenderer: string;
  framesTicked: number;
  health: string;
  healthReason: string | null;
  recentErrors: string[];
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
  private atmo: AtmosphereLayer | null = null;
  private health: RenderHealth = HEALTHY;
  private restoreTimer: ReturnType<typeof setTimeout> | null = null;
  private statusCb: (h: RenderHealth) => void = () => undefined;
  private starting = false;
  private speakingUntil = 0;
  private errorLog: string[] = [];
  private canvasEl: HTMLCanvasElement | null = null;
  private theme: Daypart = "morning";
  private lastStepAt = 0;
  private themed = false;
  private wanted: SceneMember[] = [];
  private members = new Map<number, MemberActor>();
  private memberLayer: Container | null = null;
  private actorTargets: Sprite[] = [];
  private dotTex = new Map<MemberState, Texture>();
  private selectedId: number | null = null;
  private plate: Sprite | null = null;
  private plateTex = new Map<string, Texture>();
  private pickCb: (p: MemberPick | null) => void = () => undefined;

  /** The UI listens here to show a fallback (with Retry) when the renderer cannot recover by itself. */
  onStatus(cb: (h: RenderHealth) => void): void {
    this.statusCb = cb;
  }

  private note(e: HealthEvent, detail?: string): void {
    if (detail) {
      this.errorLog.push(`${new Date().toISOString()} ${detail}`);
      if (this.errorLog.length > 20) this.errorLog.shift();
      console.error("[café renderer]", detail);
    }
    const next = nextHealth(this.health, e);
    if (next === this.health) return;
    this.health = next;
    this.statusCb(next);
  }

  private readonly onContextLost = (ev: Event): void => {
    ev.preventDefault(); // lets the browser restore the context
    this.note({ type: "context_lost" }, "WebGL context lost");
    if (this.restoreTimer === null) {
      this.restoreTimer = setTimeout(() => {
        this.restoreTimer = null;
        this.note({ type: "restore_timeout" }, "WebGL context was not restored in time");
      }, RESTORE_WAIT_MS);
    }
  };

  private readonly onContextRestored = (): void => {
    if (this.restoreTimer !== null) clearTimeout(this.restoreTimer);
    this.restoreTimer = null;
    this.note({ type: "context_restored" }, "WebGL context restored");
    this.refresh();
  };

  /** Forces the next frame to be drawn even if nothing changed: the browser may have discarded the canvas contents (minimise, GPU reset, hidden tab). */
  refresh(): void {
    this.lastRenderedKey = "";
    if (!this.paused) this.paint();
  }

  async init(host: HTMLElement): Promise<void> {
    if (this.starting || this.initialised || this.destroyed) return; // never two Pixi applications for one scene
    this.starting = true;
    try {
      await this.start(host);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.note({ type: "init_error", message: msg }, `init failed: ${msg}`);
    }
  }

  private async start(host: HTMLElement): Promise<void> {
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
    this.canvasEl = canvas;
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);

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
    const roomSprites: Sprite[] = [];
    const actorSprites: Sprite[] = [];
    this.atmo = new AtmosphereLayer(this.theme, { room: roomSprites, actors: actorSprites });
    this.atmo.mountBelow(stage);
    roomSprites.push(add(tex(buildBackground()), 0, 0));

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

    // Guild members stand on the same layer as the two main characters: behind the desks, tinted by the same atmosphere.
    this.memberLayer = new Container();
    this.memberLayer.sortableChildren = true;
    stage.addChild(this.memberLayer);
    this.actorTargets = actorSprites;
    roomSprites.push(add(tex(buildForeground()), 0, 0));
    actorSprites.push(reasoner.sprite, executor.sprite);
    this.monitorTex = texs([buildMonitorFrame("off"), buildMonitorFrame("a"), buildMonitorFrame("b")]);
    this.monitor = add(this.monitorTex[0] as Texture, MONITOR.x, MONITOR.y);
    this.atmo.mountAbove(stage);
    for (const a of [reasoner, executor]) {
      a.bubble.visible = false;
      stage.addChild(a.bubble);
    }
    this.speechSprite = new Sprite();
    this.speechSprite.visible = false;
    stage.addChild(this.speechSprite);
    this.plate = new Sprite();
    this.plate.visible = false;
    stage.addChild(this.plate);
    this.members.clear(); // a rebuilt scene starts without sprites; the wanted roster is drawn again below
    this.syncMembers();
  }

  // ---------------------------------------------------------------- guild members

  /** The recruited models to show. Safe to call before the scene is ready: it is drawn as soon as it is. */
  setGuild(list: SceneMember[]): void {
    this.wanted = list;
    if (this.initialised) this.syncMembers();
  }

  /** The UI is told when a character is clicked (or when the click lands elsewhere). */
  onPick(cb: (p: MemberPick | null) => void): void {
    this.pickCb = cb;
  }

  /** Marks the character whose nameplate is shown; null clears it. */
  select(id: number | null): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.paint();
  }

  private dropMember(a: MemberActor): void {
    this.actorTargets.splice(this.actorTargets.indexOf(a.sprite), 1);
    a.sprite.destroy();
    a.dot.destroy();
    for (const t of a.frames) t.destroy(true);
  }

  private syncMembers(): void {
    const layer = this.memberLayer;
    if (!layer || this.destroyed) return;
    const { placed } = placeMembers(this.wanted);
    const keep = new Set(placed.map((p) => p.id));
    for (const [id, a] of this.members) {
      if (!keep.has(id) || this.wanted.find((w) => w.id === id)?.seed !== a.m.seed) {
        this.dropMember(a);
        this.members.delete(id);
      }
    }
    for (const p of placed) {
      const m = this.wanted.find((w) => w.id === p.id) as SceneMember;
      let a = this.members.get(p.id);
      if (!a) {
        const frames = texs(buildMember(lookFor(m.seed)));
        const sprite = new Sprite(frames[0]);
        sprite.tint = this.atmo?.actorColor ?? 0xffffff;
        sprite.zIndex = p.spot.y;
        const dot = new Sprite();
        dot.zIndex = 10_000;
        layer.addChild(sprite, dot);
        this.actorTargets.push(sprite);
        a = { m, sprite, dot, frames, phase: p.id % 2, spot: p.spot };
        this.members.set(p.id, a);
      }
      a.m = m;
      a.spot = p.spot;
      a.sprite.zIndex = p.spot.y;
      if (!this.dotTex.has(m.state)) this.dotTex.set(m.state, tex(buildDot(m.state)));
    }
    if (this.selectedId !== null && !this.members.has(this.selectedId)) {
      this.selectedId = null;
      this.pickCb(null);
    }
    this.lastRenderedKey = "";
    this.paint();
    this.schedule();
  }

  private hit(ev: PointerEvent): MemberActor | null {
    const c = this.canvasEl;
    if (!c || this.members.size === 0) return null;
    const r = c.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const x = (ev.clientX - r.left) * (W / r.width);
    const y = (ev.clientY - r.top) * (H / r.height);
    let best: MemberActor | null = null;
    for (const a of this.members.values()) {
      if (x >= a.spot.x - MEMBER_W / 2 - 1 && x <= a.spot.x + MEMBER_W / 2 + 1 && y >= a.spot.y - MEMBER_H - 2 && y <= a.spot.y + 1 && (!best || a.spot.y > best.spot.y)) best = a;
    }
    return best;
  }

  private readonly onPointerDown = (ev: PointerEvent): void => {
    const a = this.hit(ev);
    this.select(a ? a.m.id : null);
    this.pickCb(a ? { id: a.m.id, x: a.spot.x, y: a.spot.y, headY: a.spot.y - MEMBER_H } : null);
  };

  private readonly onPointerMove = (ev: PointerEvent): void => {
    if (this.canvasEl) this.canvasEl.style.cursor = this.hit(ev) ? "pointer" : "";
  };

  /** Animates the members and positions the dots and the nameplate; called from paint(). */
  private paintMembers(t: number): void {
    for (const a of this.members.values()) {
      a.sprite.texture = a.frames[(t + a.phase) % a.frames.length] as Texture;
      a.sprite.position.set(Math.round(a.spot.x - MEMBER_W / 2), Math.round(a.spot.y - MEMBER_H));
      a.sprite.alpha = a.m.state === "unavailable" ? 0.55 : 1;
      const dt = this.dotTex.get(a.m.state);
      if (dt) a.dot.texture = dt;
      a.dot.position.set(Math.round(a.spot.x - 2), Math.round(a.spot.y - MEMBER_H - 6));
    }
    const sel = this.selectedId === null ? undefined : this.members.get(this.selectedId);
    if (!this.plate) return;
    this.plate.visible = !!sel;
    if (sel) {
      const key = `${sel.m.id}|${sel.m.name}|${sel.m.vendor}`;
      let pt = this.plateTex.get(key);
      if (!pt) {
        pt = tex(buildNameplate(sel.m.name, sel.m.vendor));
        this.plateTex.set(key, pt);
      }
      this.plate.texture = pt;
      const w = pt.width;
      const above = sel.spot.y - MEMBER_H - 26;
      this.plate.position.set(Math.min(Math.max(1, Math.round(sel.spot.x - w / 2)), W - w - 1), above >= 1 ? above : sel.spot.y + 3);
    }
  }

  /**
   * Switches the café atmosphere. Only the atmosphere layer changes: characters, poses, routes and timers are untouched.
   * Before the scene exists (or while the window is hidden) the change is applied at once instead of cross-fading.
   */
  setTheme(next: Daypart): void {
    const first = !this.themed;
    this.theme = next;
    this.themed = true;
    if (!this.atmo) return;
    this.atmo.setTheme(next, first || this.paused || !this.initialised);
    this.paint();
    this.schedule();
  }

  currentTheme(): Daypart {
    return this.atmo?.current ?? this.theme;
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
    this.speakingUntil = Date.now() + 600 + steps.reduce((n, s) => n + s.ms + 450, 0) + 400;
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

  /** True when an idle chat may start: nothing on the board, both characters resting in the lounge and nobody already talking. */
  canChat(): boolean {
    if (!this.actors || this.destroyed || !this.initialised || this.paused || this.health.state !== "ok") return false;
    if (this.board !== "empty" || Date.now() < this.speakingUntil) return false;
    return Object.values(this.actors).every((a) => a.route.length === 0 && a.spot === "lounge" && a.bubbleKind === "none" && !WORKING_POSES.has(a.pose));
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
    if (paused) {
      this.clearTimer();
      this.lastStepAt = 0;
    } else {
      this.lastRenderedKey = ""; // the canvas may have been discarded while hidden: always draw once on resume
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
    if (this.atmo?.transitioning) return FADE_MS_STEP;
    if (reasoner.route.length || executor.route.length) return WALK_MS;
    const busy = WORKING_POSES.has(reasoner.pose) || WORKING_POSES.has(executor.pose) || this.board === "active";
    return busy ? WORK_MS : IDLE_MS;
  }

  private schedule(): void {
    this.clearTimer();
    if (this.destroyed || this.paused || !this.initialised) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.step();
      } catch (e) {
        this.note({ type: "draw_error", message: String(e) }, `step failed: ${String(e)}`);
      } finally {
        this.schedule(); // the animation chain must never die because one frame threw
      }
    }, this.interval());
  }

  private step(): void {
    this.tickCount++;
    const now = Date.now();
    this.atmo?.step(this.tickCount, this.lastStepAt ? Math.min(400, now - this.lastStepAt) : 0);
    this.lastStepAt = now;
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
    this.paintMembers(t);
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
    // While the context is lost there is nothing to draw into: wait for the restore (which forces a redraw) instead of counting failures.
    if (this.health.state === "lost" || this.canvasEl?.getContext("webgl2")?.isContextLost() || this.canvasEl?.getContext("webgl")?.isContextLost()) {
      this.lastRenderedKey = "";
      return;
    }
    // Skip the GPU draw when nothing visible changed since the last frame.
    const key = this.frameKey();
    if (key === this.lastRenderedKey) return;
    this.lastRenderedKey = key;
    try {
      this.app.render();
      this.rendered++;
      this.note({ type: "draw_ok" });
    } catch (e) {
      this.lastRenderedKey = ""; // draw it again next tick
      this.note({ type: "draw_error", message: String(e) }, `render failed: ${String(e)}`);
    }
  }

  private frameKey(): string {
    if (!this.actors) return "";
    const parts: Array<string | number> = [this.atmo?.key() ?? "", this.board, this.ticket?.texture.uid ?? 0, this.steamSprite?.texture.uid ?? 0, this.flameSprites[0]?.texture.uid ?? 0, this.monitor?.texture.uid ?? 0, this.speechSprite?.visible ? this.speechSprite.texture.uid : 0, this.speechSprite?.x ?? 0, this.speechSprite?.alpha ?? 1];
    for (const a of Object.values(this.actors)) parts.push(a.sprite.texture.uid, a.sprite.x, a.sprite.y, a.sprite.scale.x, a.bubble.visible ? a.bubble.texture.uid : 0, a.bubble.y);
    for (const a of this.members.values()) parts.push(a.sprite.texture.uid, a.sprite.x, a.sprite.y, a.sprite.alpha, a.dot.texture.uid);
    if (this.plate?.visible) parts.push(this.plate.texture.uid, this.plate.x, this.plate.y);
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
      health: this.health.state,
      healthReason: this.health.reason,
      recentErrors: [...this.errorLog],
      framesRendered: this.rendered,
      timerActive: this.timer !== null,
      sharedTicker: { started: Ticker.shared.started, listeners: Ticker.shared.count },
      systemTicker: { started: Ticker.system.started, listeners: Ticker.system.count },
    };
  }

  destroy(): void {
    this.destroyed = true;
    this.clearTimer();
    if (this.restoreTimer !== null) clearTimeout(this.restoreTimer);
    this.canvasEl?.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvasEl?.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.canvasEl?.removeEventListener("pointerdown", this.onPointerDown);
    this.canvasEl?.removeEventListener("pointermove", this.onPointerMove);
    this.speechTimers.forEach(clearTimeout);
    if (this.initialised) {
      this.app.ticker.stop();
      Ticker.system.stop();
      this.app.destroy(true, { children: true, texture: true });
    }
  }
}
