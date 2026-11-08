// PixiJS café scene controller. It deliberately lives outside React: React creates and destroys it once,
// and the scene drives itself (ADR-0010).
//
// Phase 2 spike: all art is generated from vector primitives at runtime (no asset files). The scene is
// static decoration plus two idle-animated characters; it is NOT driven by agent activity yet.
//
// Rendering regimes (measured in Phase 2, see docs/measurements/phase2/README.md):
//  - stopped: nothing is scheduled at all. Cost is the platform floor (~0.05% total CPU).
//  - ambient: a plain timer changes the idle pose ~3 times per second and draws only then. No
//             requestAnimationFrame loop exists, because an rAF loop costs ~1.7% CPU at ANY frame cap:
//             Pixi's maxFPS only skips work inside the callback while the browser still wakes at display rate.
//  - active:  Pixi's shared ticker (rAF) capped at 30 fps, drawing only when something changed.
// Pixi's internal system ticker (event polling on rAF) is kept stopped in every mode; nothing in the scene
// is interactive yet. Re-enable it deliberately when pointer interaction is added.
import {
  AnimatedSprite,
  Application,
  Graphics,
  Rectangle,
  Sprite,
  Texture,
  Ticker,
  UPDATE_PRIORITY,
} from "pixi.js";

export type SceneMode = "stopped" | "ambient" | "active";

const ACTIVE_MAX_FPS = 30;
const AMBIENT_STEP_MS = 333; // idle pose change interval (~3 per second)
const ACTIVE_POSE_MS = 80; // pose change interval while active (~12 per second)
const POSES = 4;
const WIDTH = 640;
const HEIGHT = 360;

export interface SceneDiagnostics {
  renderer: string;
  gpuVendor: string;
  gpuRenderer: string;
  /** Scene update steps: ambient timer steps plus active ticker frames. */
  framesTicked: number;
  /** Frames actually drawn. */
  framesRendered: number;
  /** Pixi keeps two tickers: the shared one (active mode) and an internal system ticker (events). */
  sharedTicker: { started: boolean; listeners: number };
  systemTicker: { started: boolean; listeners: number };
}

export class CafeScene {
  private readonly app = new Application();
  private mode: SceneMode = "stopped";
  private initialised = false;
  private destroyed = false;
  private characters: AnimatedSprite[] = [];
  private ticket: Sprite | null = null;
  private ticketDirection = 1;
  private pose = 0;
  private poseAccumMs = 0;
  private ambientTimer: ReturnType<typeof setTimeout> | null = null;
  private framesTicked = 0;
  private framesRendered = 0;

  async init(host: HTMLElement): Promise<void> {
    await this.app.init({
      width: WIDTH,
      height: HEIGHT,
      preference: "webgl", // WebGL is the recommended production renderer in PixiJS v8
      powerPreference: "low-power", // a tiny 2D scene should not wake the discrete GPU (hint only; see docs)
      antialias: false,
      autoStart: false, // nothing renders until a mode is chosen
      sharedTicker: true,
      background: 0x2b2118,
      resolution: Math.min(window.devicePixelRatio, 1.5),
      autoDensity: true,
    });
    if (this.destroyed) {
      this.disposeApp();
      return;
    }
    host.appendChild(this.app.canvas);
    this.build();
    // Render on demand: drop Pixi's automatic render-every-tick listener; we draw explicitly.
    this.app.ticker.remove(this.app.render, this.app);
    this.app.ticker.add(this.onActiveTick, this, UPDATE_PRIORITY.LOW);
    this.initialised = true;
    this.apply();
    this.draw(); // one static frame, so a stopped scene is never blank
  }

  setMode(mode: SceneMode): void {
    this.mode = mode;
    if (this.initialised) {
      this.apply();
    }
  }

  diagnostics(): SceneDiagnostics {
    const gl = (this.app.renderer as unknown as { gl?: WebGL2RenderingContext }).gl;
    let gpuVendor = "unknown";
    let gpuRenderer = "unknown";
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    if (gl && info) {
      gpuVendor = String(gl.getParameter(info.UNMASKED_VENDOR_WEBGL));
      gpuRenderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
    }
    return {
      renderer: this.app.renderer.name,
      gpuVendor,
      gpuRenderer,
      framesTicked: this.framesTicked,
      framesRendered: this.framesRendered,
      sharedTicker: { started: Ticker.shared.started, listeners: Ticker.shared.count },
      systemTicker: { started: Ticker.system.started, listeners: Ticker.system.count },
    };
  }

  destroy(): void {
    this.destroyed = true;
    this.clearAmbientTimer();
    if (this.initialised) {
      this.app.ticker.remove(this.onActiveTick, this);
      this.app.ticker.stop();
      Ticker.system.stop();
      this.initialised = false;
      this.disposeApp();
    }
    // If init() is still in flight it notices `destroyed` and disposes itself.
  }

  private disposeApp(): void {
    this.app.destroy({ removeView: true }, { children: true, texture: true });
  }

  private apply(): void {
    this.clearAmbientTimer();
    Ticker.system.stop();
    if (this.mode === "active") {
      this.app.ticker.maxFPS = ACTIVE_MAX_FPS;
      this.app.ticker.start();
      return;
    }
    this.app.ticker.stop();
    if (this.mode === "ambient") {
      this.scheduleAmbientStep();
    }
  }

  private clearAmbientTimer(): void {
    if (this.ambientTimer !== null) {
      clearTimeout(this.ambientTimer);
      this.ambientTimer = null;
    }
  }

  private scheduleAmbientStep(): void {
    this.ambientTimer = setTimeout(() => {
      this.framesTicked += 1;
      this.setPose(this.pose + 1);
      this.draw();
      this.scheduleAmbientStep();
    }, AMBIENT_STEP_MS);
  }

  private setPose(pose: number): void {
    this.pose = pose % POSES;
    this.characters.forEach((c, i) => c.gotoAndStop((this.pose + i * 2) % POSES)); // characters offset by half a cycle
  }

  private readonly onActiveTick = (ticker: Ticker): void => {
    if (this.mode !== "active") return;
    this.framesTicked += 1;
    this.poseAccumMs += ticker.deltaMS;
    if (this.poseAccumMs >= ACTIVE_POSE_MS) {
      this.poseAccumMs = 0;
      this.setPose(this.pose + 1);
    }
    if (this.ticket) {
      const t = this.ticket;
      t.x += this.ticketDirection * 2 * ticker.deltaTime;
      if (t.x > 300) this.ticketDirection = -1;
      if (t.x < 60) this.ticketDirection = 1;
    }
    this.draw(); // the ticket moves every tick in active mode
  };

  private draw(): void {
    this.app.render();
    this.framesRendered += 1;
  }

  private rect(x: number, y: number, w: number, h: number, color: number): Graphics {
    return new Graphics().rect(x, y, w, h).fill(color);
  }

  private texture(g: Graphics, frame: Rectangle): Texture {
    return this.app.renderer.generateTexture({ target: g, frame });
  }

  private characterFrames(body: number): Texture[] {
    const frame = new Rectangle(0, 0, 24, 44);
    return [0, 1, 2, 1].map((bob) => {
      const g = new Graphics();
      g.rect(2, 16 + bob, 20, 26 - bob).fill(body);
      g.circle(12, 9 + bob, 8).fill(0xf2d4b0);
      return this.texture(g, frame);
    });
  }

  private build(): void {
    const stage = this.app.stage;
    stage.addChild(this.rect(0, 0, WIDTH, 170, 0x4a3828)); // back wall
    stage.addChild(this.rect(0, 170, WIDTH, HEIGHT - 170, 0x6b4f35)); // floor
    stage.addChild(this.rect(440, 30, 150, 90, 0x9ec8e0)); // window
    stage.addChild(this.rect(60, 190, 330, 26, 0x8a6240)); // counter
    stage.addChild(this.rect(60, 30, 200, 100, 0x3a2c20)); // order board
    for (let i = 0; i < 3; i++) {
      stage.addChild(this.rect(76 + i * 62, 48, 48, 64, 0xf4e8c8)); // order tickets (static decoration)
    }
    for (const x of [120, 300, 480]) {
      stage.addChild(new Graphics().circle(x, 290, 28).fill(0x8a6240)); // tables
    }

    // autoUpdate=false: poses are stepped explicitly (timer in ambient, ticker in active), never by a hidden rAF loop.
    const reasoner = new AnimatedSprite(this.characterFrames(0x7a5cc0), false);
    reasoner.position.set(110, 148);
    const executor = new AnimatedSprite(this.characterFrames(0xc0643c), false);
    executor.position.set(300, 148);
    for (const c of [reasoner, executor]) {
      stage.addChild(c);
    }
    this.characters = [reasoner, executor];
    this.setPose(0);

    const ticketTexture = this.texture(
      new Graphics().rect(0, 0, 22, 14).fill(0xf4e8c8),
      new Rectangle(0, 0, 22, 14),
    );
    this.ticket = new Sprite(ticketTexture);
    this.ticket.position.set(60, 176);
    stage.addChild(this.ticket);
  }
}
