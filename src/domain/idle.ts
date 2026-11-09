// Idle conversations between the Reasoner and the Executor.
// Everything here is local and deterministic given the random source: a small hand-written collection of exchanges, chosen by
// time of day and recent outcome, with cooldowns and repetition avoidance. There are NO network calls and NO AI calls: this
// module imports nothing from the IPC layer (a test enforces that).
import type { Daypart } from "./atmosphere.ts";
import { readingTime, type Speaker, type WelcomeStep } from "./welcome.ts";

export type Mood = "any" | Daypart | "success" | "failure" | "quiet";

export interface Exchange {
  id: string;
  mood: Mood;
  lines: ReadonlyArray<readonly [Speaker, string]>;
}

const R = "reasoner" as const;
const E = "executor" as const;
const ex = (id: string, mood: Mood, ...lines: Array<readonly [Speaker, string]>): Exchange => ({ id, mood, lines });

export const EXCHANGES: readonly Exchange[] = [
  // ---- any time
  ex("read", "any", [R, "Read anything interesting lately?"], [E, "Does debugging count as reading?"]),
  ex("new-quest", "any", [R, "Think we'll get a new quest today?"], [E, "I hope it involves less CSS."]),
  ex("quiet-day", "any", [E, "Another quiet day at the guild."], [R, "Enjoy it while it lasts."]),
  ex("coffee", "any", [E, "Coffee?"], [R, "After I finish this spell."]),
  ex("spell", "any", [R, "This spell needs one more comment."], [E, "Spells don't have comments."], [R, "Mine do."]),
  ex("semicolon", "any", [E, "Found a missing semicolon once."], [R, "Only one? Impressive restraint."]),
  ex("naming", "any", [R, "Naming things is the hardest part."], [E, "That and cache invalidation."]),
  ex("tabs", "any", [E, "Tabs or spaces?"], [R, "I write in runes."]),
  ex("bug", "any", [R, "Ever fixed a bug by accident?"], [E, "Never. Never admit it either."]),
  ex("tea", "any", [R, "The tea is almost ready."], [E, "Mine went cold an hour ago."]),
  ex("rubber", "any", [E, "I explained my bug to the plant."], [R, "And?"], [E, "It had no objections."]),
  ex("tests", "any", [R, "Tests are just promises."], [E, "Mine keep breaking them."]),
  ex("window", "any", [R, "Nice light in the guild today."], [E, "Less glare on my screen, too."]),
  ex("stack", "any", [E, "Is it a stack or a pile?"], [R, "A pile, if you ask me."]),
  ex("snack", "any", [E, "Do we have any biscuits left?"], [R, "I hid them from you."]),
  ex("refactor", "any", [R, "Fancy a little refactoring?"], [E, "Only if it's a small one."]),
  // ---- morning
  ex("morning-1", "morning", [R, "Good morning! Fresh day, fresh page."], [E, "Fresh coffee first."]),
  ex("morning-2", "morning", [E, "Up with the sun again."], [R, "The sun is just early."]),
  ex("morning-3", "morning", [R, "Morning light suits this place."], [E, "Warm enough to type in."]),
  ex("morning-4", "morning", [E, "What's on the board today?"], [R, "Nothing yet. A good sign."]),
  // ---- noon
  ex("noon-1", "noon", [E, "Lunch time yet?"], [R, "You asked an hour ago."], [E, "And I'm still hopeful."]),
  ex("noon-2", "noon", [R, "The guild is buzzing today."], [E, "That's just the fridge."]),
  ex("noon-3", "noon", [E, "Bright enough to read in the sun."], [R, "Bright enough to forget the time."]),
  // ---- evening
  ex("evening-1", "evening", [R, "Look at that sunset."], [E, "Too pretty to ship anything."]),
  ex("evening-2", "evening", [E, "Golden hour. My favourite."], [R, "Mine is the one after supper."]),
  ex("evening-3", "evening", [R, "A good day's work, I think."], [E, "Let's call it good."]),
  ex("evening-4", "evening", [E, "Lamps are coming on."], [R, "Cosy hour at last."]),
  // ---- night
  ex("night-1", "night", [R, "The stars are out tonight."], [E, "So are my bugs."]),
  ex("night-2", "night", [E, "Late shift at the guild."], [R, "Best shift. Quietest, too."]),
  ex("night-3", "night", [R, "One more chapter, then bed."], [E, "You said that two chapters ago."]),
  ex("night-4", "night", [E, "Candles are low."], [R, "I know a spell for that."], [E, "Is it matches?"]),
  // ---- after a successful quest
  ex("success-1", "success", [R, "That quest went beautifully."], [E, "Clean run. I'm proud."]),
  ex("success-2", "success", [E, "All green. Feels good."], [R, "Take a moment. You earned it."]),
  ex("success-3", "success", [R, "Another quest down!"], [E, "Cake to celebrate?"]),
  ex("success-4", "success", [E, "Finished faster than I thought."], [R, "That's the spell working."]),
  // ---- after a failed quest
  ex("failure-1", "failure", [R, "That one fought back, didn't it?"], [E, "I'll take another look."]),
  ex("failure-2", "failure", [E, "Well. That didn't go to plan."], [R, "We learn something each time."]),
  ex("failure-3", "failure", [R, "Don't worry. Failures teach."], [E, "Then I'm getting educated."]),
  ex("failure-4", "failure", [E, "Maybe the task was too big."], [R, "We can split it up."]),
  // ---- nothing pending
  ex("quiet-1", "quiet", [E, "No quests on the board."], [R, "A rare treat."]),
  ex("quiet-2", "quiet", [R, "The board is empty."], [E, "Time to nap, then."]),
  ex("quiet-3", "quiet", [E, "Quiet. Almost too quiet."], [R, "Don't tempt the board."]),
  ex("quiet-4", "quiet", [R, "Nothing pending. Lovely."], [E, "Let's keep it that way."]),
];

export interface IdleContext {
  daypart: Daypart;
  /** the last finished quest outcome, if it is still fresh enough to mention */
  outcome: "success" | "failure" | null;
  /** quests waiting for the owner (none means a quiet board) */
  pending: number;
}

export interface Director {
  /** Picks the next exchange or null when it is too soon. */
  next(ctx: IdleContext, now: number): Exchange | null;
  /** Milliseconds to wait before the next attempt (natural timing, not constant chatter). */
  delay(): number;
  /** ids shown recently, oldest first (exposed for tests) */
  recent(): string[];
}

export interface DirectorOptions {
  /** minimum time between two exchanges */
  minGapMs: number;
  /** an exchange is not repeated within this time */
  sameExchangeMs: number;
  /** how many of the latest exchanges are never repeated */
  memory: number;
}

export const DEFAULTS: DirectorOptions = { minGapMs: 45_000, sameExchangeMs: 20 * 60_000, memory: 10 };

const pick = <T>(list: readonly T[], rand: () => number): T => list[Math.min(list.length - 1, Math.floor(rand() * list.length))] as T;

export function createDirector(rand: () => number, opts: DirectorOptions = DEFAULTS, pool: readonly Exchange[] = EXCHANGES): Director {
  const shownAt = new Map<string, number>();
  const history: string[] = [];
  let last = -Infinity;
  const moodsFor = (c: IdleContext): Mood[] => {
    const moods: Mood[] = [c.daypart];
    if (c.outcome) moods.unshift(c.outcome);
    if (c.pending === 0) moods.push("quiet");
    return moods;
  };
  return {
    next(ctx, now) {
      if (now - last < opts.minGapMs) return null;
      const recent = new Set(history.slice(-Math.min(opts.memory, Math.max(0, pool.length - 1))));
      const fresh = pool.filter((e) => !recent.has(e.id) && now - (shownAt.get(e.id) ?? -Infinity) >= opts.sameExchangeMs);
      if (fresh.length === 0) return null;
      const moods = moodsFor(ctx);
      // a fresh quest outcome is reacted to first, once
      const reaction = ctx.outcome ? fresh.filter((e) => e.mood === ctx.outcome) : [];
      let chosen: Exchange;
      if (reaction.length) chosen = pick(reaction, rand);
      else {
        // contextual exchanges are three times as likely as generic ones
        const weighted: Exchange[] = fresh.flatMap((e) => {
          if (e.mood === "success" || e.mood === "failure") return [];
          return moods.includes(e.mood) ? [e, e, e] : e.mood === "any" ? [e] : [];
        });
        if (weighted.length === 0) return null;
        chosen = pick(weighted, rand);
      }
      last = now;
      shownAt.set(chosen.id, now);
      history.push(chosen.id);
      if (history.length > 64) history.shift();
      return chosen;
    },
    delay() {
      return 60_000 + Math.floor(rand() * 90_000); // one to two and a half minutes
    },
    recent: () => [...history],
  };
}

/** The speech steps the café plays. */
export function toSteps(e: Exchange): WelcomeStep[] {
  return e.lines.map(([who, text]) => ({ who, text, ms: readingTime(text) }));
}
