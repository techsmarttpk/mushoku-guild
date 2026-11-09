// The Guild roster as the UI sees it: model records, procedural character looks and café placement.
// Pure (no Pixi, no DOM) so appearance uniqueness and placement are testable. The pixel art itself is drawn in cafe/memberSprites.ts.

export interface Capabilities {
  textInput: boolean;
  textOutput: boolean;
  imageInput: boolean;
  imageOutput: boolean;
  tools: boolean;
  structuredOutput: boolean;
  streaming: boolean;
}

export interface OrModel {
  id: string;
  name: string;
  vendor: string;
  contextLength: number | null;
  description: string;
  inputModalities: string[];
  outputModalities: string[];
  caps: Capabilities;
}

export interface OrStatus {
  connected: boolean;
  catalogAt: number | null;
  eligible: number;
  total: number;
}

export interface OrPage {
  models: OrModel[];
  total: number;
}

export interface KeyInfo {
  freeTier: boolean;
  limitRemaining: number | null;
}

export interface OrTest {
  text: string;
  latencyMs: number;
  usage: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null; cost: number | null } | null;
}

export interface GuildMember {
  id: number;
  provider: "openrouter";
  modelId: string;
  name: string;
  vendor: string;
  seed: number;
  status: "available" | "unavailable";
  reason: string;
  contextLength: number | null;
  description: string;
  caps: Capabilities;
  recruitedAt: number;
  connected: boolean;
}

/** The catalogue is re-downloaded when the Guild tab opens and it is older than this. */
export const CATALOG_REFRESH_MS = 6 * 60 * 60 * 1000;

export type MemberState = "available" | "unavailable" | "offline";

/** What the character's indicator shows: unavailable (no longer free) wins over offline (no key stored). */
export function memberState(m: Pick<GuildMember, "status" | "connected">): MemberState {
  if (m.status === "unavailable") return "unavailable";
  return m.connected ? "available" : "offline";
}

export const STATE_LABEL: Record<MemberState, string> = { available: "Available", unavailable: "Unavailable", offline: "Offline (OpenRouter not connected)" };

/** A model can be chatted with when it is free-and-available, the key is stored and it can produce text. */
export function canChat(m: GuildMember): boolean {
  return memberState(m) === "available" && m.caps.textOutput && m.caps.textInput;
}

export function capabilityLabels(c: Capabilities): string[] {
  const out: string[] = [];
  if (c.textInput && c.textOutput) out.push("Text");
  if (c.imageInput) out.push("Image input");
  if (c.imageOutput) out.push("Image generation");
  if (c.tools) out.push("Tool calling");
  if (c.structuredOutput) out.push("Structured output");
  if (c.streaming) out.push("Streaming");
  return out;
}

export function formatContext(n: number | null): string {
  if (!n) return "unknown";
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M tokens` : `${Math.round(n / 1000)}K tokens`;
}

// ---------------------------------------------------------------- characters

export type Activity = "book" | "scroll" | "notes" | "carry" | "map" | "orb";
export const ACTIVITIES: Activity[] = ["book", "scroll", "notes", "carry", "map", "orb"];

export interface Look {
  skin: number;
  hairStyle: number;
  hair: number;
  outfit: number;
  cloth: number;
  accessory: number;
  activity: Activity;
}

export const LOOK_SIZES = { skin: 6, hairStyle: 6, hair: 10, outfit: 5, cloth: 12, accessory: 7 } as const;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a: a stable 32-bit hash of the model id, so the same model always starts from the same character. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The character a seed stands for. Deterministic: the roster looks identical after every restart. */
export function lookFor(seed: number): Look {
  const r = mulberry32(seed);
  const pick = (n: number): number => Math.floor(r() * n);
  return {
    skin: pick(LOOK_SIZES.skin),
    hairStyle: pick(LOOK_SIZES.hairStyle),
    hair: pick(LOOK_SIZES.hair),
    outfit: pick(LOOK_SIZES.outfit),
    cloth: pick(LOOK_SIZES.cloth),
    accessory: pick(LOOK_SIZES.accessory),
    activity: ACTIVITIES[pick(ACTIVITIES.length)] as Activity,
  };
}

/** What makes two characters distinguishable at a glance (the activity is a pose, not an identity). */
export function lookSignature(l: Look): string {
  return [l.skin, l.hairStyle, l.hair, l.outfit, l.cloth, l.accessory].join("-");
}

export const seedSignature = (seed: number): string => lookSignature(lookFor(seed));

/**
 * The seed for a newly recruited model: derived from its id, then advanced until its look differs from every character
 * already in the Guild (so two recruits never look alike). Bounded; the signature space is far larger than any roster.
 */
export function pickSeed(modelId: string, takenSignatures: ReadonlySet<string>): number {
  let seed = hashString(modelId);
  for (let i = 0; i < 10_000; i++) {
    if (!takenSignatures.has(seedSignature(seed))) return seed;
    seed = (seed + 0x9e3779b1) >>> 0;
  }
  return seed;
}

// ---------------------------------------------------------------- café placement (logical 288x176 scene pixels)

export const SCENE = { w: 288, h: 176 } as const;
/** A character is drawn 16x26 with its feet on the spot. */
export const BODY = { w: 16, h: 26 } as const;

export interface Spot {
  x: number;
  y: number;
}

/** Idle positions (feet, bottom centre): open floor away from desks, table, door, plants and the quest corridor. */
export const GUILD_SPOTS: readonly Spot[] = [
  { x: 50, y: 150 },
  { x: 94, y: 150 },
  { x: 72, y: 170 },
  { x: 114, y: 170 },
  { x: 188, y: 134 },
  { x: 188, y: 162 },
  { x: 232, y: 150 },
  { x: 210, y: 170 },
  { x: 180, y: 70 },
  { x: 210, y: 70 },
];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Furniture and fixed characters that members must not stand on (taken from cafe/world.ts). */
export const OBSTACLES: readonly Rect[] = [
  { x: 14, y: 98, w: 60, h: 24 }, // reasoner's desk
  { x: 214, y: 98, w: 60, h: 24 }, // executor's desk
  { x: 112, y: 100, w: 64, h: 34 }, // table, stools and the two lounge seats
  { x: 10, y: 146, w: 29, h: 26 }, // crates
  { x: 123, y: 155, w: 48, h: 21 }, // door and mat
  { x: 254, y: 140, w: 28, h: 26 }, // plants
  { x: 0, y: 78, w: 288, h: 16 }, // corridor the two main characters walk along
];

export function bodyBox(s: Spot): Rect {
  return { x: s.x - BODY.w / 2, y: s.y - BODY.h, w: BODY.w, h: BODY.h };
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export interface Placed {
  id: number;
  seed: number;
  spot: Spot;
}

/**
 * Gives every member a spot: its preferred one (from its seed) if free, otherwise the next free one. Earlier recruits are
 * placed first, so adding a member never moves anyone already standing. Members beyond the free spots are counted in
 * `overflow` and are reachable through the Guild tab instead of crowding the café.
 */
export function placeMembers(members: ReadonlyArray<{ id: number; seed: number }>, spots: readonly Spot[] = GUILD_SPOTS): { placed: Placed[]; overflow: number } {
  const used = new Set<number>();
  const placed: Placed[] = [];
  let overflow = 0;
  for (const m of members) {
    if (used.size >= spots.length) {
      overflow++;
      continue;
    }
    let i = m.seed % spots.length;
    while (used.has(i)) i = (i + 1) % spots.length;
    used.add(i);
    placed.push({ id: m.id, seed: m.seed, spot: spots[i] as Spot });
  }
  return { placed, overflow };
}
