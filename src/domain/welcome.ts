// Welcome dialogue: pure data + selection so it can be tested without a canvas. The café shows it once per
// application launch (new session) and only while nobody is doing real work.

export type Speaker = "reasoner" | "executor";
export interface WelcomeStep {
  who: Speaker;
  text: string;
  /** how long the bubble stays up, in ms */
  ms: number;
}

export const BUBBLE_CHARS = 18;
export const BUBBLE_LINES = 3;

const REASONER = [
  "Hey! Ready to cook up something brilliant?",
  "Welcome back, adventurer. Got a quest for us?",
  "The guild is open! What are we building today?",
];
const EXECUTOR = ["Let's get our hands dirty!", "Another day, another quest. I'm ready.", "Point me at the code!"];
/** Short back-and-forth greetings, used now and then instead of two separate hellos. */
const EXCHANGES: Array<[string, string]> = [
  ["Morning! Tea before the quest?", "Tea, then code. Deal."],
  ["Think we can ship it today?", "Give me a quest and watch."],
  ["Doors are open, partner!", "Then let's get to work!"],
];

/** Greedy word wrap for the 17-character pixel bubble; words longer than the line are split. */
export function wrapText(text: string, max = BUBBLE_CHARS): string[] {
  const lines: string[] = [];
  let line = "";
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > max) {
      if (line) {
        lines.push(line);
        line = "";
      }
      lines.push(word.slice(0, max));
      word = word.slice(max);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= max) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Long enough to read (about 14 characters per second plus a pause), never shorter than 2.8 s. */
export function readingTime(text: string): number {
  return Math.max(2800, 1400 + text.length * 75);
}

const step = (who: Speaker, text: string): WelcomeStep => ({ who, text, ms: readingTime(text) });
const pick = <T>(list: readonly T[], rand: () => number): T => list[Math.min(list.length - 1, Math.floor(rand() * list.length))] as T;

export function pickWelcome(rand: () => number): WelcomeStep[] {
  if (rand() < 0.3) {
    const [a, b] = pick(EXCHANGES, rand);
    return [step("reasoner", a), step("executor", b)];
  }
  return [step("reasoner", pick(REASONER, rand)), step("executor", pick(EXECUTOR, rand))];
}

export const ALL_DIALOGUE: string[] = [...REASONER, ...EXECUTOR, ...EXCHANGES.flat()];

/** Returns true exactly once per gate: call it from the app start-up path, not from render. */
export function createWelcomeGate(): () => boolean {
  let used = false;
  return () => {
    if (used) return false;
    used = true;
    return true;
  };
}
