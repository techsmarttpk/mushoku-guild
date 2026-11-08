import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_DIALOGUE, BUBBLE_CHARS, BUBBLE_LINES, createWelcomeGate, pickWelcome, readingTime, wrapText } from "./welcome.ts";

test("the welcome gate fires exactly once per session, however often it is asked", () => {
  const gate = createWelcomeGate();
  assert.deepEqual([gate(), gate(), gate()], [true, false, false]);
  assert.equal(createWelcomeGate()(), true, "a new session gets its own greeting");
});

test("every line fits the pixel bubble (3 lines of 18 characters)", () => {
  for (const line of ALL_DIALOGUE) {
    const wrapped = wrapText(line);
    assert.ok(wrapped.length <= BUBBLE_LINES, `${line} -> ${wrapped.length} lines`);
    assert.ok(wrapped.every((l) => l.length <= BUBBLE_CHARS), line);
  }
});

test("wrapping splits overlong words and keeps all text", () => {
  assert.deepEqual(wrapText("a ".repeat(3).trim()), ["a a a"]);
  const w = wrapText("supercalifragilisticexpialidocious");
  assert.ok(w.every((l) => l.length <= BUBBLE_CHARS));
  assert.equal(w.join(""), "supercalifragilisticexpialidocious");
});

test("a welcome has a Reasoner greeting then an Executor reply, each readable long enough", () => {
  for (const r of [0, 0.1, 0.29, 0.31, 0.6, 0.99]) {
    const steps = pickWelcome(() => r);
    assert.deepEqual(steps.map((s) => s.who), ["reasoner", "executor"]);
    for (const s of steps) assert.ok(s.ms >= 2800 && s.ms === readingTime(s.text));
  }
});

test("selection varies with the random source", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) seen.add(pickWelcome(() => i / 20)[0]?.text ?? "");
  assert.ok(seen.size > 2);
});
