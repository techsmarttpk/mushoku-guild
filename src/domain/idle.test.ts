import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULTS, EXCHANGES, createDirector, toSteps, type IdleContext } from "./idle.ts";
import { BUBBLE_LINES, wrapText } from "./welcome.ts";

const ctx = (over: Partial<IdleContext> = {}): IdleContext => ({ daypart: "noon", outcome: null, pending: 1, ...over });
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const MIN = 60_000;

test("the collection is original, unique and fits the small pixel bubbles", () => {
  assert.ok(EXCHANGES.length >= 40);
  assert.equal(new Set(EXCHANGES.map((e) => e.id)).size, EXCHANGES.length);
  for (const e of EXCHANGES) {
    assert.ok(e.lines.length >= 2 && e.lines.length <= 4, e.id);
    for (const [, text] of e.lines) assert.ok(wrapText(text).length <= BUBBLE_LINES, `${e.id}: ${text}`);
  }
  // the requested examples are in
  const all = EXCHANGES.flatMap((e) => e.lines.map((l) => l[1]));
  for (const line of ["Does debugging count as reading?", "I hope it involves less CSS.", "Enjoy it while it lasts.", "After I finish this spell."]) assert.ok(all.includes(line), line);
  // every mood has material
  for (const m of ["any", "morning", "noon", "evening", "night", "success", "failure", "quiet"]) assert.ok(EXCHANGES.some((e) => e.mood === m), m);
});

test("both characters start conversations", () => {
  const starters = new Set(EXCHANGES.map((e) => e.lines[0]?.[0]));
  assert.ok(starters.has("reasoner") && starters.has("executor"));
});

test("a cooldown separates exchanges", () => {
  const d = createDirector(seeded(1));
  assert.ok(d.next(ctx(), 0));
  assert.equal(d.next(ctx(), DEFAULTS.minGapMs - 1), null);
  assert.ok(d.next(ctx(), DEFAULTS.minGapMs + 1));
});

test("exchanges are not repeated until the recent memory has moved on", () => {
  const d = createDirector(seeded(7), { minGapMs: 1000, sameExchangeMs: 0, memory: 10 });
  const seen: string[] = [];
  for (let i = 0; i < 40; i++) {
    const e = d.next(ctx(), i * 2000);
    if (e) seen.push(e.id);
  }
  for (let i = 0; i < seen.length; i++) for (let j = i + 1; j < Math.min(seen.length, i + 11); j++) assert.notEqual(seen[i], seen[j], `repeat within 10 exchanges at ${i}/${j}`);
  assert.ok(new Set(seen).size >= 15);
});

test("the same exchange is held back for a long time even after memory", () => {
  const pool = EXCHANGES.filter((e) => e.mood === "any").slice(0, 3);
  const d = createDirector(seeded(3), { minGapMs: 1000, sameExchangeMs: 20 * MIN, memory: 1 }, pool);
  const first = d.next(ctx(), 0);
  const second = d.next(ctx(), 5000);
  const third = d.next(ctx(), 10_000);
  assert.ok(first && second && third);
  assert.equal(new Set([first.id, second.id, third.id]).size, 3);
  assert.equal(d.next(ctx(), 15_000), null, "everything is cooling down: stay quiet rather than repeat");
});

test("contextual selection: time of day, outcomes and a quiet board", () => {
  const pickMany = (c: IdleContext): string[] => {
    const out: string[] = [];
    for (let s = 1; s <= 200; s++) {
      const e = createDirector(seeded(s)).next(c, 0);
      if (e) out.push(e.mood);
    }
    return out;
  };
  const morning = pickMany(ctx({ daypart: "morning", pending: 1 }));
  assert.ok(morning.filter((m) => m === "morning").length > morning.filter((m) => m === "any").length * 0.5, "morning greetings are favoured");
  assert.ok(!morning.some((m) => m === "night" || m === "evening"), "no night talk in the morning");
  assert.ok(!morning.some((m) => m === "success" || m === "failure"), "no quest reactions without an outcome");
  assert.ok(pickMany(ctx({ daypart: "night" })).includes("night"));
  assert.ok(pickMany(ctx({ pending: 0 })).includes("quiet"));
  assert.ok(!pickMany(ctx({ pending: 2 })).includes("quiet"));
  assert.ok(pickMany(ctx({ outcome: "success" })).every((m) => m === "success"), "a fresh success is celebrated");
  assert.ok(pickMany(ctx({ outcome: "failure" })).every((m) => m === "failure"), "a failure gets a concerned remark");
});

test("timing is natural: one to two and a half minutes between attempts", () => {
  const d = createDirector(seeded(5));
  for (let i = 0; i < 100; i++) {
    const t = d.delay();
    assert.ok(t >= 60_000 && t <= 150_000, String(t));
  }
});

test("steps carry the speaker and a reading time", () => {
  const steps = toSteps(EXCHANGES[0]!);
  assert.equal(steps[0]?.who, "reasoner");
  assert.ok(steps.every((s) => s.ms >= 2800));
});

test("idle dialogue works offline: no network, IPC or AI module is imported or called", () => {
  const src = readFileSync(new URL("./idle.ts", import.meta.url), "utf8");
  const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ["./atmosphere.ts", "./welcome.ts"]);
  assert.ok(!/\bfetch\s*\(|\binvoke\b|ipc\.ts/.test(src));
  const welcome = readFileSync(new URL("./welcome.ts", import.meta.url), "utf8");
  assert.ok(!/\bfetch\s*\(|\binvoke\b|ipc\.ts/.test(welcome));
});
