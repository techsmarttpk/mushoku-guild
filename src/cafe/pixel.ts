// Tiny pixel-art toolkit: a pen over a 2D canvas (integer rectangles only, no smoothing), a seeded PRNG,
// the shared palette and a 3x5 pixel font. All art in this app is original and generated from code, so there
// are no third-party art assets to license.

export interface Pen {
  readonly canvas: HTMLCanvasElement;
  readonly w: number;
  readonly h: number;
  /** filled rectangle */
  r(x: number, y: number, w: number, h: number, c: string): void;
  /** single pixel */
  p(x: number, y: number, c: string): void;
  /** translucent rectangle */
  a(x: number, y: number, w: number, h: number, c: string, alpha: number): void;
}

export function newPen(w: number, h: number): Pen {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas is unavailable");
  ctx.imageSmoothingEnabled = false;
  return {
    canvas,
    w,
    h,
    r(x, y, rw, rh, c) {
      ctx.fillStyle = c;
      ctx.fillRect(Math.round(x), Math.round(y), rw, rh);
    },
    p(x, y, c) {
      ctx.fillStyle = c;
      ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
    },
    a(x, y, rw, rh, c, alpha) {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = c;
      ctx.fillRect(Math.round(x), Math.round(y), rw, rh);
      ctx.globalAlpha = 1;
    },
  };
}

/** mulberry32: small deterministic PRNG so the generated art is identical on every launch. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const C = {
  ink: "#26160f",
  ink2: "#3a2417",
  // walls
  plaster: "#d9b47c",
  plaster2: "#c99f66",
  plaster3: "#b58a55",
  beam: "#5b3921",
  beam2: "#7a4b2a",
  beamHi: "#96623a",
  wain: "#6e4429",
  wain2: "#80512f",
  wainHi: "#9a6a42",
  wainDk: "#4a2b19",
  // floor
  fl1: "#b8794a",
  fl2: "#a96b3e",
  fl3: "#c58a58",
  flDk: "#7e4d2b",
  flHi: "#d9a06b",
  // misc materials
  cream: "#f5e6c4",
  cream2: "#e3cb9f",
  paper: "#f1e3b8",
  paper2: "#d9c590",
  sky: "#8fd3ee",
  sky2: "#c4ebf6",
  sun: "#fff2a8",
  glass: "#a6dff0",
  green: "#3f9150",
  green2: "#2c6b3b",
  green3: "#74c15f",
  pot: "#bb5a3c",
  pot2: "#8c3f29",
  red: "#c8453b",
  red2: "#8f2c2a",
  gold: "#f0b93a",
  gold2: "#b98322",
  teal: "#2f9a98",
  teal2: "#1f6e72",
  purple: "#6f4bb2",
  purple2: "#4d3380",
  purple3: "#9677d6",
  blue: "#3b6fb5",
  navy: "#1d2f55",
  steel: "#a3aebd",
  steel2: "#6f7b8c",
  white: "#ffffff",
  black: "#101010",
  grey: "#8d8d8d",
  skin: "#f2cfa8",
  skin2: "#d9a77c",
  rug: "#8a2f35",
  rug2: "#6a2026",
  rugGold: "#e0b04a",
} as const;

// ---- 3x5 pixel font (uppercase letters and digits) for in-world signs
const GLYPHS: Record<string, string> = {
  A: "010101111101101", B: "110101110101110", C: "011100100100011", D: "110101101101110",
  E: "111100110100111", F: "111100110100100", G: "011100101101011", H: "101101111101101",
  I: "111010010010111", J: "001001001101010", K: "101101110101101", L: "100100100100111",
  M: "101111111101101", N: "110101101101101", O: "010101101101010", P: "110101110100100",
  Q: "010101101111011", R: "110101110101101", S: "011100010001110", T: "111010010010010",
  U: "101101101101111", V: "101101101101010", W: "101101111111101", X: "101101010101101",
  Y: "101101010010010", Z: "111001010100111", "0": "111101101101111", "1": "010110010010111",
  "2": "110001010100111", "3": "110001010001110", "4": "101101111001001", "5": "111100110001110",
  "6": "011100111101111", "7": "111001010010010", "8": "111101111101111", "9": "111101111001110",
};

export function drawText(pen: Pen, x: number, y: number, text: string, color: string): number {
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const g = GLYPHS[ch];
    if (g) {
      for (let i = 0; i < 15; i++) if (g[i] === "1") pen.p(cx + (i % 3), y + Math.floor(i / 3), color);
    }
    cx += 4;
  }
  return cx - x - 1;
}

export function textWidth(text: string): number {
  return text.length * 4 - 1;
}
