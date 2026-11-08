// PixiJS café scene controller. It deliberately lives outside React: React creates and destroys it once,
// and every frame is driven by Pixi's shared ticker, never by React renders (ADR-0010).
//
// Phase 2 spike: all art is generated from vector primitives at runtime (no asset files). The scene is
// static decoration plus two idle-animated characters; it is NOT driven by agent activity yet.
import { AnimatedSprite, Application, Graphics, Rectangle, Sprite, Texture, Ticker } from "pixi.js";

export type SceneMode = "stopped" | "ambient" | "active";

/** Frame-rate caps per mode. 0 fps ("stopped") means the ticker is not running at all. */
const MAX_FPS = { ambient: 15, active: 30 } as const;
const WIDTH = 640;
const HEIGHT = 360;

export interface SceneDiagnostics {
  renderer: string;
  gpuVendor: string;
  gpuRenderer: string;
  framesTicked: number;
}

export class CafeScene {
  private readonly app = new Application();
  private mode: SceneMode = "stopped";
  private initialised = false;
  private destroyed = false;
  private characters: AnimatedSprite[] = [];
  private ticket: Sprite | null = null;
  private ticketDirection = 1;
  private framesTicked = 0;

  async init(host: HTMLElement): Promise<void> {
    await this.app.init({
      width: WIDTH,
      height: HEIGHT,
      preference: "webgl", // WebGL is the recommended production renderer in PixiJS v8
      powerPreference: "low-power", // a tiny 2D scene should not wake the discrete GPU
      antialias: false,
      autoStart: false, // nothing renders until a mode is chosen
      sharedTicker: true, // AnimatedSprite advances on the shared ticker, so one ticker governs every frame
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
    this.app.ticker.add(this.onTick, this);
    this.app.render(); // one static frame, so a stopped scene is never blank
    this.initialised = true;
    this.apply();
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
    };
  }

  destroy(): void {
    this.destroyed = true;
    if (this.initialised) {
      this.app.ticker.remove(this.onTick, this);
      this.app.ticker.stop();
      this.initialised = false;
      this.disposeApp();
    }
    // If init() is still in flight it notices `destroyed` and disposes itself.
  }

  private disposeApp(): void {
    this.app.destroy({ removeView: true }, { children: true, texture: true });
  }

  private apply(): void {
    const ticker = this.app.ticker;
    if (this.mode === "stopped") {
      ticker.stop();
      return;
    }
    ticker.maxFPS = MAX_FPS[this.mode];
    const speed = this.mode === "active" ? 0.2 : 0.1;
    for (const c of this.characters) {
      c.animationSpeed = speed;
    }
    ticker.start();
  }

  private readonly onTick = (ticker: Ticker): void => {
    this.framesTicked += 1;
    if (this.mode === "active" && this.ticket) {
      const t = this.ticket;
      t.x += this.ticketDirection * 2 * ticker.deltaTime;
      if (t.x > 300) this.ticketDirection = -1;
      if (t.x < 60) this.ticketDirection = 1;
    }
  };

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

    const reasoner = new AnimatedSprite(this.characterFrames(0x7a5cc0));
    reasoner.position.set(110, 148);
    const executor = new AnimatedSprite(this.characterFrames(0xc0643c));
    executor.position.set(300, 148);
    for (const c of [reasoner, executor]) {
      c.animationSpeed = 0.1;
      c.play();
      stage.addChild(c);
    }
    this.characters = [reasoner, executor];

    const ticketTexture = this.texture(
      new Graphics().rect(0, 0, 22, 14).fill(0xf4e8c8),
      new Rectangle(0, 0, 22, 14),
    );
    this.ticket = new Sprite(ticketTexture);
    this.ticket.position.set(60, 176);
    stage.addChild(this.ticket);
  }
}
