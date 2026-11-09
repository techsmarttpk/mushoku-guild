// Café atmosphere: which of the four environments is showing. Pure so the clock logic is testable.
// Dayparts use the computer's LOCAL clock (never UTC): morning 05:00-10:59, noon 11:00-15:59,
// evening 16:00-18:59, night 19:00-04:59 (the night wraps past midnight).

export type Daypart = "morning" | "noon" | "evening" | "night";
export type AtmosphereMode = "auto" | "manual";

export const DAYPARTS: readonly Daypart[] = ["morning", "noon", "evening", "night"];
export const DAYPART_LABEL: Record<Daypart, string> = { morning: "Morning", noon: "Noon", evening: "Evening", night: "Night" };
export const DAYPART_HOURS: Record<Daypart, string> = { morning: "05:00–10:59", noon: "11:00–15:59", evening: "16:00–18:59", night: "19:00–04:59" };

/** First local hour of each daypart, in clock order (night starts the evening and ends the next morning). */
const STARTS: ReadonlyArray<[Daypart, number]> = [["morning", 5], ["noon", 11], ["evening", 16], ["night", 19]];

export function daypartAt(date: Date): Daypart {
  const h = date.getHours();
  if (h >= 19 || h < 5) return "night";
  if (h >= 16) return "evening";
  if (h >= 11) return "noon";
  return "morning";
}

export function isDaypart(v: unknown): v is Daypart {
  return typeof v === "string" && (DAYPARTS as readonly string[]).includes(v);
}

export interface AtmosphereSetting {
  mode: AtmosphereMode;
  manual: Daypart;
}

/** Reads the stored settings; anything missing or unrecognised means Automatic (the default for new users). */
export function parseSetting(settings: Record<string, string | undefined>): AtmosphereSetting {
  const manual = isDaypart(settings["cafe_theme"]) ? settings["cafe_theme"] : "morning";
  return { mode: settings["cafe_mode"] === "manual" ? "manual" : "auto", manual };
}

export function resolveDaypart(setting: AtmosphereSetting, now: Date): Daypart {
  return setting.mode === "manual" ? setting.manual : daypartAt(now);
}

/** Milliseconds until the local clock enters the next daypart (DST-safe: it builds the next boundary as a local time). */
export function msUntilNextDaypart(now: Date): number {
  const h = now.getHours();
  const boundary = STARTS.map(([, start]) => start).find((start) => start > h);
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (boundary === undefined ? 1 : 0), boundary ?? STARTS[0]![1], 0, 0, 0);
  return Math.max(1000, next.getTime() - now.getTime());
}

/** Linear blend of two 0xRRGGBB colours (used for smooth theme transitions). */
export function mixColor(a: number, b: number, t: number): number {
  const k = Math.min(1, Math.max(0, t));
  const ch = (shift: number): number => Math.round(((a >> shift) & 255) * (1 - k) + ((b >> shift) & 255) * k);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** What the scene needs to know about one daypart besides its pictures. */
export interface Grade {
  /** multiplies the interior (wall, floor, furniture) */
  room: number;
  /** multiplies the characters (a softer version of the room grade so they stay readable) */
  actors: number;
  /** strength of the warm lamp glow around the candles and sconces, 0..1 */
  lamps: number;
}

export const GRADES: Record<Daypart, Grade> = {
  morning: { room: 0xfff0d0, actors: 0xfff6e4, lamps: 0.1 },
  noon: { room: 0xffffff, actors: 0xffffff, lamps: 0.03 },
  evening: { room: 0xffc08c, actors: 0xffd7b4, lamps: 0.3 },
  night: { room: 0x7f8ccc, actors: 0xb4bce6, lamps: 0.5 },
};
